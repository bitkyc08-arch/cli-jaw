import type { RuntimeEvent } from './runtime-contract.js';
import { activityKey, applyActivityEvent, createActivityState, type ActivityState } from './activity-state.js';

const MAX_TURNS = 16;
const MAX_PENDING = 256;
const MAX_PENDING_BYTES = 1024 * 1024;

export interface ActivityRestoreOptions { runId?: string; signal?: AbortSignal; }

function makeRoom(turns: Map<string, ActivityState>, settled: Set<string>,
    canEvict: (state: ActivityState) => boolean, rank: (state: ActivityState) => number): void {
    if (turns.size < MAX_TURNS) return;
    let selected: string | undefined;
    let selectedRank = Infinity;
    for (const [key, state] of turns) {
        if ((!state.end && !settled.has(key)) || !canEvict(state)) continue;
        const priority = rank(state);
        if (selected === undefined || priority < selectedRank) { selected = key; selectedRank = priority; }
    }
    if (selected === undefined) throw new Error('activity_turn_capacity');
    turns.delete(selected); settled.delete(selected);
}

/** Coordinates validated, ordered journal seeds with live events. No I/O ownership. */
export class ActivityReplay {
    readonly turns = new Map<string, ActivityState>();
    private settled = new Set<string>();
    private pending: RuntimeEvent[] = [];
    private pendingBytes = 0;
    private controller: AbortController | null = null;
    private generation = 0;
    private scopeGeneration = 0;
    private drainingScope: number | null = null;
    private targetRun: string | null = null;

    constructor(private readonly changed: (state: ActivityState) => void,
        private readonly canEvict: (state: ActivityState) => boolean = () => true,
        private readonly evictionRank: (state: ActivityState) => number = () => 0) {}

    /** Caller-validated historical/compatibility finality permits eviction only.
     * It neither fabricates a journal end nor fences late canonical events.
     */
    markSettled(runId: string): void {
        for (const key of this.settled) if (!this.turns.has(key)) this.settled.delete(key);
        for (const [key, state] of this.turns) {
            if (state.identity.runId === runId) this.settled.add(key);
        }
    }

    live(event: RuntimeEvent): boolean {
        if (!this.controller && this.drainingScope !== this.scopeGeneration) return this.apply(event);
        // A historical A read must not freeze live B. Pending B transferred from
        // an older restore still needs ordered draining before newer B can apply.
        if (this.controller && this.targetRun && event.runId !== this.targetRun
            && !this.pending.some(prior => activityKey(prior) === activityKey(event))) return this.apply(event);
        this.controller?.signal.throwIfAborted();
        const key = activityKey(event);
        const state = this.turns.get(key);
        if (state && (state.end || event.seq <= state.seq)) return false;
        for (let i = this.pending.length - 1; i >= 0; i--) {
            const prior = this.pending[i]!;
            if (activityKey(prior) !== key) continue;
            if (prior.kind === 'turn-end' || event.seq <= prior.seq) return false;
            break;
        }
        const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
        if (this.pending.length >= MAX_PENDING || this.pendingBytes + bytes > MAX_PENDING_BYTES) {
            const error = new Error('activity_live_buffer_overflow');
            this.controller?.abort(error);
            throw error;
        }
        this.pending.push(event);
        this.pendingBytes += bytes;
        return true;
    }

    private apply(event: RuntimeEvent): boolean {
        const key = activityKey(event);
        let state = this.turns.get(key);
        if (state) {
            if (!applyActivityEvent(state, event)) return false;
        } else {
            state = createActivityState(event);
            if (!applyActivityEvent(state, event)) return false;
            // Reduce before eviction so an invalid event cannot remove a retained turn.
            makeRoom(this.turns, this.settled, this.canEvict, this.evictionRank);
            this.settled.delete(key);
            this.turns.set(key, state);
        }
        this.changed(state);
        return true;
    }

    private fold(events: readonly RuntimeEvent[], settled: Set<string>): Map<string, ActivityState> {
        const rebuilt = new Map<string, ActivityState>();
        const rebuiltSettled = new Set(settled);
        for (const event of events) {
            const key = activityKey(event);
            let state = rebuilt.get(key);
            if (!state) {
                state = createActivityState(event);
                makeRoom(rebuilt, rebuiltSettled, this.canEvict, this.evictionRank);
                rebuilt.set(key, state);
            }
            applyActivityEvent(state, event);
        }
        const staged = new Map(this.turns);
        // Replace existing keys first: newly closed states can then make room.
        for (const [key, state] of rebuilt) {
            const current = staged.get(key);
            if (!current || state.seq < current.seq || (current.end && state.seq > current.seq)) continue;
            staged.set(key, state);
        }
        for (const [key, state] of rebuilt) {
            // A replaced closed state may already have been evicted for a new key.
            if (this.turns.has(key)) continue;
            makeRoom(staged, settled, this.canEvict, this.evictionRank);
            staged.set(key, state);
        }
        return staged;
    }

    private publish(staged: Map<string, ActivityState>, settled: Set<string>, generation: number): void {
        const changed: ActivityState[] = [];
        for (const [key, next] of staged) {
            const current = this.turns.get(key);
            if (current === next) continue;
            // Browser owners may already hold this exact model. Keep that reference.
            const adopted = current ? Object.assign(current, next) : next;
            staged.set(key, adopted);
            changed.push(adopted);
        }
        this.turns.clear();
        for (const [key, state] of staged) this.turns.set(key, state);
        for (const key of settled) if (!staged.has(key)) settled.delete(key);
        this.settled = settled;
        for (const state of changed) {
            if (generation !== this.generation) break;
            this.changed(state);
        }
    }

    private foldPending(staged: Map<string, ActivityState>, settled: Set<string>): void {
        for (const event of this.pending) {
            const key = activityKey(event);
            let state = staged.get(key);
            if (state && (state.end || event.seq <= state.seq)) continue;
            // Untouched live models still belong to the browser until commit.
            if (state && state === this.turns.get(key)) state = structuredClone(state);
            if (!state) {
                state = createActivityState(event);
                makeRoom(staged, settled, this.canEvict, this.evictionRank);
            }
            applyActivityEvent(state, event);
            staged.set(key, state);
        }
    }

    private drain(): unknown[] {
        const scopeGeneration = this.scopeGeneration;
        const errors: unknown[] = [];
        if (this.drainingScope === scopeGeneration) return errors;
        this.drainingScope = scopeGeneration;
        try {
            // Keep the unconsumed tail visible to reentrant live admission. A new
            // restore takes ownership of that same queue; reset invalidates this drain.
            while (this.pending.length && scopeGeneration === this.scopeGeneration && !this.controller) {
                const event = this.pending.shift()!;
                this.pendingBytes -= new TextEncoder().encode(JSON.stringify(event)).length;
                try { this.apply(event); } catch (error) { errors.push(error); }
            }
        } finally {
            if (this.drainingScope === scopeGeneration) this.drainingScope = null;
        }
        return errors;
    }

    async restore(read: (signal: AbortSignal) => Promise<readonly RuntimeEvent[]>, options?: ActivityRestoreOptions): Promise<void> {
        const previous = this.controller;
        const controller = new AbortController();
        const generation = ++this.generation;
        this.controller = controller;
        this.targetRun = options?.runId ?? null;
        let onAbort!: () => void;
        // Resolve cancellation so a reentrant reset before read admission cannot
        // leave an unobserved rejection when this generation exits early.
        const aborted = new Promise<null>(resolve => {
            onAbort = () => resolve(null);
            controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const errors: unknown[] = [];
        const cancel = () => controller.abort(options?.signal?.reason);
        if (options?.signal?.aborted) cancel();
        else options?.signal?.addEventListener('abort', cancel, { once: true });
        try {
            // Abort listeners are external code: they may reset or supersede us.
            // Pending events transfer only while this scope/generation still owns them.
            previous?.abort();
            if (generation !== this.generation) return;
            controller.signal.throwIfAborted();
            // Racing abort also settles readers which ignore their AbortSignal.
            const reading = new Promise<readonly RuntimeEvent[]>(resolve => resolve(read(controller.signal)));
            const events = await Promise.race([aborted, reading]);
            if (generation !== this.generation) return;
            if (events === null || controller.signal.aborted) throw controller.signal.reason;
            if (options?.runId !== undefined && events.some(event => event.runId !== options.runId)) throw new Error('activity_restore_target');
            // Eviction metadata participates in the transaction; failed folds cannot
            // consume a live model's settlement marker. Both collections stay <=16.
            const settled = new Set(this.settled);
            const staged = this.fold(events, settled);
            this.foldPending(staged, settled);
            this.pending = [];
            this.pendingBytes = 0;
            this.publish(staged, settled, generation);
        } catch (error) {
            if (generation !== this.generation) return;
            errors.push(error);
            controller.abort(error);
        } finally {
            options?.signal?.removeEventListener('abort', cancel);
            controller.signal.removeEventListener('abort', onAbort);
            if (generation === this.generation) {
                this.controller = null;
                this.targetRun = null;
                errors.push(...this.drain());
            }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'activity_replay_failed');
    }

    reset(): void {
        ++this.generation;
        ++this.scopeGeneration;
        const controller = this.controller;
        this.controller = null;
        this.targetRun = null;
        this.pending = [];
        this.pendingBytes = 0;
        this.turns.clear();
        this.settled.clear();
        controller?.abort();
    }
}
