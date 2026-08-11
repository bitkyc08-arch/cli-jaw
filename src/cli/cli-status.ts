import { CLI_KEYS } from './registry.js';
import { runCliStatusWorker } from './cli-status-worker.js';

/**
 * `failing` means "the probe keeps erroring, and here is why" — NOT "gave up".
 * The cache still retries; `nextRetryAt` says when. Before #277 a repeatedly
 * failing probe was indistinguishable from one still in progress: the error was
 * discarded and the row decayed fresh -> stale -> checking, so /api/cli-status
 * answered "not ready" for a runtime that demonstrably worked, with no reason
 * attached.
 */
export type CliStatusProbeState = 'checking' | 'fresh' | 'stale' | 'failing';

export interface CliStatusRow {
    available: boolean | null;
    binaryInstalled: boolean | null;
    capabilityReady: boolean | null;
    authenticated: boolean | null;
    path: string | null;
    source: string;
    probeState: CliStatusProbeState;
    reason?: string;
    /** Underlying probe error. Present only while `probeState` is `failing`. */
    probeError?: string;
    /** Consecutive probe failures. Present only while `failing`. */
    probeFailures?: number;
    /** Epoch ms of the next scheduled retry. Present only while `failing`. */
    nextRetryAt?: number;
}

export type CliStatusSnapshot = Record<string, CliStatusRow>;

export function formatCliStatusLine(cli: string, row: Pick<CliStatusRow, 'available' | 'capabilityReady' | 'probeState' | 'path'>): string {
    if (row.probeState === 'checking') return `${cli}: checking`;
    // Without this branch a stale-but-successful snapshot kept printing a green
    // check while every probe was failing — the same false-positive #277 is about.
    if (row.probeState === 'failing') {
        const why = (row as CliStatusRow).probeError;
        return `${cli}: ⚠️ probe failing${why ? ` (${why})` : ''}`;
    }
    const ready = row.available === true && row.capabilityReady !== false;
    return `${cli}: ${ready ? '✅' : '❌'}${row.path ? ` ${row.path}` : ''}`;
}

export interface CliStatusCacheOptions {
    now?: () => number;
    refresh?: () => Promise<CliStatusSnapshot>;
    freshTtlMs?: number;
    staleTtlMs?: number;
}

const FRESH_TTL_MS = 30_000;
const STALE_TTL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * First retry is immediate. A single failure is often a cold-start race, and
 * the established contract (a request after a rejection starts a new worker)
 * depends on it. Back off only once failure repeats, so a persistently broken
 * probe stops respawning a worker on every read.
 */
export function cliStatusBackoffMs(consecutive: number): number {
    if (consecutive <= 1) return 0;
    return Math.min(MAX_BACKOFF_MS, 15_000 * 2 ** (consecutive - 2));
}

interface ProbeFailure {
    message: string;
    at: number;
    consecutive: number;
    nextRetryAt: number;
}

function coldSnapshot(): CliStatusSnapshot {
    return Object.fromEntries(CLI_KEYS.map((cli) => [cli, {
        available: null,
        binaryInstalled: null,
        capabilityReady: null,
        authenticated: null,
        path: null,
        source: 'pending-probe',
        probeState: 'checking' as const,
    }])) as CliStatusSnapshot;
}

function snapshotWithState(snapshot: CliStatusSnapshot, probeState: CliStatusProbeState): CliStatusSnapshot {
    return Object.fromEntries(Object.entries(snapshot).map(([cli, row]) => [cli, {
        ...row,
        probeState,
    }])) as CliStatusSnapshot;
}

function snapshotWithFailure(snapshot: CliStatusSnapshot, failure: ProbeFailure): CliStatusSnapshot {
    return Object.fromEntries(Object.entries(snapshot).map(([cli, row]) => [cli, {
        ...row,
        probeState: 'failing' as const,
        probeError: failure.message,
        probeFailures: failure.consecutive,
        nextRetryAt: failure.nextRetryAt,
    }])) as CliStatusSnapshot;
}

export class CliStatusCache {
    private readonly now: () => number;
    private readonly refresh: () => Promise<CliStatusSnapshot>;
    private readonly freshTtlMs: number;
    private readonly staleTtlMs: number;
    private lastSuccessfulSnapshot: CliStatusSnapshot | null = null;
    private lastSuccessfulProbeAt: number | null = null;
    private refreshInFlight: Promise<void> | null = null;
    private failure: ProbeFailure | null = null;

    constructor(options: CliStatusCacheOptions = {}) {
        this.now = options.now ?? Date.now;
        this.refresh = options.refresh ?? runCliStatusWorker;
        this.freshTtlMs = options.freshTtlMs ?? FRESH_TTL_MS;
        this.staleTtlMs = options.staleTtlMs ?? STALE_TTL_MS;
    }

    getSnapshot(): CliStatusSnapshot {
        const now = this.now();
        const age = this.lastSuccessfulProbeAt == null
            ? Number.POSITIVE_INFINITY
            : now - this.lastSuccessfulProbeAt;

        if (this.lastSuccessfulSnapshot && age <= this.freshTtlMs) {
            return snapshotWithState(this.lastSuccessfulSnapshot, 'fresh');
        }

        // Honour the backoff window: a probe that keeps failing must not respawn
        // a worker on every single read.
        if (!this.failure || now >= this.failure.nextRetryAt) this.startRefresh();

        // A recorded failure outranks the decaying snapshot. Reporting `stale`
        // while every probe errors is what made #277 undiagnosable.
        if (this.failure) {
            const base = this.lastSuccessfulSnapshot ?? coldSnapshot();
            return snapshotWithFailure(base, this.failure);
        }

        if (this.lastSuccessfulSnapshot && age <= this.staleTtlMs) {
            return snapshotWithState(this.lastSuccessfulSnapshot, 'stale');
        }
        return coldSnapshot();
    }

    private startRefresh(): void {
        if (this.refreshInFlight) return;
        this.refreshInFlight = Promise.resolve()
            .then(() => this.refresh())
            .then((snapshot) => {
                this.lastSuccessfulSnapshot = snapshotWithState(snapshot, 'fresh');
                this.lastSuccessfulProbeAt = this.now();
                this.failure = null;
            })
            .catch((err: unknown) => {
                // Record instead of discard. The last successful snapshot is
                // still preserved; what changes is that the failure is now
                // observable, with its reason and its retry schedule (#277).
                const failedAt = this.now();
                const consecutive = (this.failure?.consecutive ?? 0) + 1;
                this.failure = {
                    message: err instanceof Error ? err.message : String(err),
                    at: failedAt,
                    consecutive,
                    nextRetryAt: failedAt + cliStatusBackoffMs(consecutive),
                };
            })
            .finally(() => {
                this.refreshInFlight = null;
            });
    }
}

const defaultCliStatusCache = new CliStatusCache();

export function getCachedCliStatus(): CliStatusSnapshot {
    return defaultCliStatusCache.getSnapshot();
}

/** @internal exported for deterministic cache tests. */
export function createCliStatusCacheForTest(options: CliStatusCacheOptions): CliStatusCache {
    return new CliStatusCache(options);
}
