import type { RuntimeEvent } from './runtime-contract.js';
import { activityKey, applyActivityEvent, createActivityState, type ActivityState } from './activity-state.js';

const MAX_TURNS = 16;
const MAX_PENDING = 256;
const MAX_PENDING_BYTES = 1024 * 1024;

function makeRoom(turns: Map<string, ActivityState>): void {
    if (turns.size < MAX_TURNS) return;
    for (const [key, state] of turns) {
        if (!state.end) continue;
        turns.delete(key);
        return;
    }
    throw new Error('activity_turn_capacity');
}

/** Coordinates validated, ordered journal seeds with live events. No I/O ownership. */
export class ActivityReplay {
    readonly turns = new Map<string, ActivityState>();
    private pending: RuntimeEvent[] = [];
    private pendingBytes = 0;
    private controller: AbortController | null = null;
    private generation = 0;
    private scopeGeneration = 0;

    constructor(private readonly changed: (state: ActivityState) => void) {}

    live(event: RuntimeEvent): boolean {
        if (!this.controller) return this.apply(event);
        this.controller.signal.throwIfAborted();
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
            this.controller.abort(error);
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
            makeRoom(this.turns);
            this.turns.set(key, state);
        }
        this.changed(state);
        return true;
    }

    private fold(events: readonly RuntimeEvent[]): Map<string, ActivityState> {
        const rebuilt = new Map<string, ActivityState>();
        for (const event of events) {
            const key = activityKey(event);
            let state = rebuilt.get(key);
            if (!state) {
                state = createActivityState(event);
                makeRoom(rebuilt);
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
            makeRoom(staged);
            staged.set(key, state);
        }
        return staged;
    }

    private publish(staged: Map<string, ActivityState>, generation: number): void {
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
        for (const state of changed) {
            if (generation !== this.generation) break;
            this.changed(state);
        }
    }

    private foldPending(staged: Map<string, ActivityState>): void {
        for (const event of this.pending) {
            const key = activityKey(event);
            let state = staged.get(key);
            if (state && (state.end || event.seq <= state.seq)) continue;
            // Untouched live models still belong to the browser until commit.
            if (state && state === this.turns.get(key)) state = structuredClone(state);
            if (!state) {
                state = createActivityState(event);
                makeRoom(staged);
            }
            applyActivityEvent(state, event);
            staged.set(key, state);
        }
    }

    private drain(): unknown[] {
        const scopeGeneration = this.scopeGeneration;
        const pending = this.pending;
        this.pending = [];
        this.pendingBytes = 0;
        const errors: unknown[] = [];
        for (const event of pending) {
            if (scopeGeneration !== this.scopeGeneration) break;
            try { this.live(event); } catch (error) { errors.push(error); }
        }
        return errors;
    }

    async restore(read: (signal: AbortSignal) => Promise<readonly RuntimeEvent[]>): Promise<void> {
        const previous = this.controller;
        const controller = new AbortController();
        const generation = ++this.generation;
        this.controller = controller;
        // Pending events belong to the current scope, so supersession transfers them.
        previous?.abort();
        let onAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const errors: unknown[] = [];
        try {
            // Racing abort also settles readers which ignore their AbortSignal.
            const reading = new Promise<readonly RuntimeEvent[]>(resolve => resolve(read(controller.signal)));
            const events = await Promise.race([aborted, reading]);
            if (generation !== this.generation) return;
            controller.signal.throwIfAborted();
            const staged = this.fold(events);
            this.foldPending(staged);
            this.pending = [];
            this.pendingBytes = 0;
            this.publish(staged, generation);
        } catch (error) {
            if (generation !== this.generation) return;
            errors.push(error);
            controller.abort(error);
        } finally {
            controller.signal.removeEventListener('abort', onAbort);
            if (generation === this.generation) {
                this.controller = null;
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
        this.pending = [];
        this.pendingBytes = 0;
        this.turns.clear();
        controller?.abort();
    }
}
