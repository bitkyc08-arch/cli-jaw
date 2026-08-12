// ─── Enrichment Cache ────────────────────────────────
// The concurrency primitive behind Slack enrichment lookups: TTL cache with cap
// eviction, classified failure suppression, capability lockout with a single
// re-probe, in-flight coalescing, generation invalidation, and per-caller
// cancellation.
//
// Why this exists as its own module: every one of those concerns was already
// implemented, correctly and expensively, inside identity.ts — and specifying it
// a SECOND time for conversation lookups produced four consecutive audit
// failures, because the second specification kept disagreeing with the first
// about cancellation ownership. Extracting it means the discipline is written
// once and both adapters inherit it. Design: devlog
// 260812_slack_conversation_context/012_wp1_replan_shared_primitive.md.
//
// Two rules run through everything below:
//   1. Enrichment is decoration, never a precondition. Every failure path
//      degrades; nothing here throws at its caller.
//   2. Shared work belongs to no single caller. One caller cancelling must not
//      cancel the lookup its peers are waiting on.

/** How a failed load should suppress subsequent attempts. */
export type Suppression =
    | { kind: 'none' }
    /** Scoped to one resource (a channel, a user). Other resources unaffected. */
    | { kind: 'resource'; key: string; ttlMs: number }
    /** Scoped to a capability (a token/method pair). Blocks every resource. */
    | { kind: 'capability'; key: string; ttlMs: number };

export type LoadResult<V, E> = { ok: true; value: V } | { ok: false; error: E };

export type LoadContext = {
    /** The SHARED signal. Never an individual caller's. */
    signal: AbortSignal;
    generation: number;
};

export type EnrichmentEvent =
    | { type: 'suppressed'; scope: 'resource' | 'capability'; key: string }
    | { type: 'capability_locked'; key: string; error: unknown }
    | { type: 'admission_declined'; key: string }
    | { type: 'stale_discarded'; key: string };

export type PartitionSpec = {
    /** Read per write so a settings change takes effect without a restart. */
    ttlMs: () => number;
    cap: number;
};

export type EnrichmentCacheOptions<P extends string, E> = {
    partitions: Record<P, PartitionSpec>;
    suppressionCap?: number;
    classifyFailure: (error: E) => Suppression;
    onEvent?: (event: EnrichmentEvent) => void;
};

export type ResolveOptions<P extends string, V, E> = {
    partition: P;
    /** Cache + coalescing identity. Must already include the workspace. */
    resourceKey: string;
    /** Capability lock identity. Adapters choose the granularity. */
    capabilityKey: string;
    signal?: AbortSignal;
    load: (ctx: LoadContext) => Promise<LoadResult<V, E>>;
    /** Built fresh per call: the degraded value may embed caller-specific hints. */
    degraded: () => V;
    /** Optional start-rate gate. Returning false declines without waiting. */
    admitStart?: () => boolean;
};

export type EnrichmentStats<P extends string> = {
    entries: Record<P, number>;
    suppressed: number;
    inFlight: number;
};

type Entry<V> = { value: V; expiresAt: number };

type InFlight<V> = {
    promise: Promise<V | undefined>;
    controller: AbortController;
    /** Live waiters. At zero the record is retired and its work aborted. */
    waiters: number;
    /** Set when this request holds the single capability re-probe reservation. */
    probeKey: string | null;
    /** Once retired, no further caller may join. */
    retired: boolean;
    /** Set once the load settles: a completed request must not be "cancelled". */
    settled: boolean;
};

const DEFAULT_SUPPRESSION_CAP = 1000;

export class EnrichmentCache<P extends string, V, E> {
    private readonly partitions: Record<P, PartitionSpec>;
    private readonly caches = new Map<P, Map<string, Entry<V>>>();
    /** key -> epoch ms until which the key is suppressed. */
    private readonly suppressed = new Map<string, number>();
    private readonly inFlight = new Map<string, InFlight<V>>();
    /** Capability keys whose lock has lapsed and whose re-probe is in flight. */
    private readonly probing = new Set<string>();
    private readonly suppressionCap: number;
    private readonly classifyFailure: (error: E) => Suppression;
    private readonly onEvent: ((event: EnrichmentEvent) => void) | undefined;
    /**
     * Bumped by reset. Captured at dispatch and re-checked before BOTH the cache
     * write and the publication to waiters, so a lookup issued under a superseded
     * token can neither poison the cache nor leak a stale value to a caller.
     */
    private generation = 0;

    constructor(options: EnrichmentCacheOptions<P, E>) {
        this.partitions = options.partitions;
        this.suppressionCap = options.suppressionCap ?? DEFAULT_SUPPRESSION_CAP;
        this.classifyFailure = options.classifyFailure;
        this.onEvent = options.onEvent;
        for (const name of Object.keys(options.partitions) as P[]) {
            this.caches.set(name, new Map());
        }
    }

    /** Cache-only read. Never calls the loader; a miss is simply undefined. */
    get(partition: P, resourceKey: string): V | undefined {
        const cache = this.caches.get(partition);
        const entry = cache?.get(resourceKey);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            cache!.delete(resourceKey);
            return undefined;
        }
        return entry.value;
    }

    /** Insert a value obtained elsewhere (a bulk listing, a push payload). */
    prime(partition: P, resourceKey: string, value: V): void {
        this.write(partition, resourceKey, value);
    }

    entryCount(partition: P): number {
        return this.caches.get(partition)?.size ?? 0;
    }

    isSuppressed(key: string): boolean {
        const until = this.suppressed.get(key);
        if (until === undefined) return false;
        if (until <= Date.now()) {
            this.suppressed.delete(key);
            return false;
        }
        return true;
    }

    /**
     * Suppress a key directly. Exposed for adapters that learn about a failure
     * outside a `resolve` call.
     */
    suppress(key: string, ttlMs: number): void {
        this.suppressed.set(key, Date.now() + ttlMs);
        if (this.suppressed.size > this.suppressionCap) {
            const entries = [...this.suppressed.entries()].sort((a, b) => a[1] - b[1]);
            for (const [stale] of entries.slice(0, Math.floor(this.suppressed.size / 2))) {
                this.suppressed.delete(stale);
            }
        }
    }

    /** Release a capability lock and its probe reservation. */
    clearCapability(capabilityKey: string): void {
        this.suppressed.delete(capabilityKey);
        this.probing.delete(capabilityKey);
    }

    /**
     * Resolve a value, degrading rather than throwing.
     *
     * Admission order is fixed (and load-bearing): cache -> suppression ->
     * in-flight join -> start-rate admission -> new upstream request. Joining an
     * existing request is NOT a "start", so coalesced callers never consume the
     * rate budget.
     */
    async resolve(options: ResolveOptions<P, V, E>): Promise<V> {
        const { partition, resourceKey, capabilityKey, signal } = options;

        const cached = this.get(partition, resourceKey);
        if (cached !== undefined) return cached;

        // An already-cancelled caller should cost zero API calls.
        if (signal?.aborted) return options.degraded();

        if (this.isSuppressed(resourceKey)) {
            this.emit({ type: 'suppressed', scope: 'resource', key: resourceKey });
            return options.degraded();
        }

        // Capability lock: while held, everyone degrades. Once it lapses exactly
        // one caller is admitted to re-probe; the rest keep degrading until that
        // probe answers. Letting them all through would restore the request storm
        // the lock exists to prevent.
        //
        // The expiry check is INLINE rather than via isSuppressed(), because that
        // helper deletes an expired key as a side effect — which erased the very
        // marker that decides who becomes the probe, and admitted every caller.
        let holdsProbe = false;
        const lockedUntil = this.suppressed.get(capabilityKey);
        if (lockedUntil !== undefined) {
            if (lockedUntil > Date.now()) {
                this.emit({ type: 'suppressed', scope: 'capability', key: capabilityKey });
                return options.degraded();
            }
            if (this.probing.has(capabilityKey)) {
                this.emit({ type: 'suppressed', scope: 'capability', key: capabilityKey });
                return options.degraded();
            }
            // Lapsed and unclaimed: this caller is the single probe.
            this.suppressed.delete(capabilityKey);
            this.probing.add(capabilityKey);
            holdsProbe = true;
        } else if (this.probing.has(capabilityKey)) {
            // The probe holder already removed the marker; everyone else waits.
            this.emit({ type: 'suppressed', scope: 'capability', key: capabilityKey });
            return options.degraded();
        }

        const existing = this.inFlight.get(resourceKey);
        if (existing && !existing.retired && existing.waiters > 0) {
            if (holdsProbe) this.probing.delete(capabilityKey);
            return this.join(existing, options);
        }

        if (options.admitStart && !options.admitStart()) {
            if (holdsProbe) this.probing.delete(capabilityKey);
            this.emit({ type: 'admission_declined', key: resourceKey });
            return options.degraded();
        }

        return this.start(options, holdsProbe ? capabilityKey : null);
    }

    /** Invalidate everything. In-flight work is aborted and can no longer publish. */
    reset(): void {
        // Generation first: a request that settles during this call must already
        // see itself as superseded.
        this.generation += 1;
        for (const record of this.inFlight.values()) {
            record.retired = true;
            record.controller.abort();
        }
        this.inFlight.clear();
        this.probing.clear();
        this.suppressed.clear();
        for (const cache of this.caches.values()) cache.clear();
    }

    stats(): EnrichmentStats<P> {
        const entries = {} as Record<P, number>;
        for (const [name, cache] of this.caches) entries[name] = cache.size;
        return { entries, suppressed: this.suppressed.size, inFlight: this.inFlight.size };
    }

    // ─── internals ──────────────────────────────────

    private emit(event: EnrichmentEvent): void {
        try { this.onEvent?.(event); } catch { /* diagnostics must never break a lookup */ }
    }

    private write(partition: P, resourceKey: string, value: V): void {
        const cache = this.caches.get(partition);
        const spec = this.partitions[partition];
        if (!cache || !spec) return;
        cache.set(resourceKey, { value, expiresAt: Date.now() + spec.ttlMs() });
        if (cache.size > spec.cap) {
            // Drop the half closest to expiry. Sorted by stored expiry rather than
            // insertion order, because a re-write refreshes a value in place.
            const entries = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
            for (const [stale] of entries.slice(0, Math.floor(cache.size / 2))) {
                cache.delete(stale);
            }
        }
    }

    /** Attach a caller to shared work, racing its own signal against the result. */
    private async join(record: InFlight<V>, options: ResolveOptions<P, V, E>): Promise<V> {
        record.waiters += 1;
        try {
            const value = await this.race(record, options.signal);
            return value === undefined ? options.degraded() : value;
        } finally {
            this.release(record, options.resourceKey);
        }
    }

    /**
     * Race shared work against this caller's cancellation.
     *
     * Cancelling abandons only this caller's interest — the shared request keeps
     * running for its peers. `release` is what eventually stops it, once nobody
     * is left waiting.
     */
    private race(record: InFlight<V>, signal: AbortSignal | undefined): Promise<V | undefined> {
        if (!signal) return record.promise;
        if (signal.aborted) return Promise.resolve(undefined);
        return new Promise<V | undefined>(resolve => {
            const finish = (value: V | undefined) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            };
            const onAbort = () => finish(undefined);
            signal.addEventListener('abort', onAbort, { once: true });
            void record.promise.then(finish, () => finish(undefined));
        });
    }

    /**
     * Drop one waiter. When the last one leaves, the record is retired
     * SYNCHRONOUSLY before its controller is aborted, so a caller arriving in the
     * same tick cannot attach to work that is already dying.
     */
    private release(record: InFlight<V>, resourceKey: string): void {
        record.waiters -= 1;
        if (record.waiters > 0 || record.retired) return;
        record.retired = true;
        if (this.inFlight.get(resourceKey) === record) this.inFlight.delete(resourceKey);
        // An abandoned probe reservation must be returned: an abort is neither a
        // successful probe nor a capability failure, and holding it would keep the
        // capability locked forever.
        if (record.probeKey) {
            this.probing.delete(record.probeKey);
            record.probeKey = null;
        }
        // Only cancel work that is still running. The last waiter also departs on
        // the SUCCESS path, and aborting there would fire cancellation handlers
        // for a request that already delivered its value.
        if (!record.settled) record.controller.abort();
    }

    private start(options: ResolveOptions<P, V, E>, probeKey: string | null): Promise<V> {
        const { partition, resourceKey, capabilityKey } = options;
        const controller = new AbortController();
        const generation = this.generation;

        const record: InFlight<V> = {
            promise: Promise.resolve(undefined),
            controller,
            waiters: 0,
            probeKey,
            retired: false,
            settled: false,
        };

        record.promise = options
            .load({ signal: controller.signal, generation })
            .then((result): V | undefined => {
                // A result from a superseded generation describes the OLD token or
                // workspace. It may neither be cached NOR handed to a waiter:
                // returning it would leak one stale value per reset boundary.
                if (generation !== this.generation) {
                    this.emit({ type: 'stale_discarded', key: resourceKey });
                    return undefined;
                }
                if (result.ok) {
                    if (record.probeKey) {
                        this.clearCapability(record.probeKey);
                        record.probeKey = null;
                    }
                    this.write(partition, resourceKey, result.value);
                    return result.value;
                }
                const suppression = this.classifyFailure(result.error);
                if (suppression.kind === 'capability') {
                    this.suppress(suppression.key, suppression.ttlMs);
                    this.probing.delete(suppression.key);
                    if (record.probeKey === suppression.key) record.probeKey = null;
                    this.emit({ type: 'capability_locked', key: suppression.key, error: result.error });
                } else if (suppression.kind === 'resource') {
                    this.suppress(suppression.key, suppression.ttlMs);
                }
                // A probe that failed for an unrelated reason must still release
                // its reservation, or the capability never gets probed again.
                if (record.probeKey) {
                    this.probing.delete(record.probeKey);
                    record.probeKey = null;
                }
                return undefined;
            })
            .catch((): V | undefined => {
                if (record.probeKey) {
                    this.probing.delete(record.probeKey);
                    record.probeKey = null;
                }
                return undefined;
            })
            .finally(() => {
                record.settled = true;
                // Identity-checked: a retired record may already have been replaced,
                // and deleting the replacement would strand its waiters.
                if (this.inFlight.get(resourceKey) === record) this.inFlight.delete(resourceKey);
            });

        this.inFlight.set(resourceKey, record);
        void capabilityKey; // capability state is keyed by the caller's choice
        return this.join(record, options);
    }
}
