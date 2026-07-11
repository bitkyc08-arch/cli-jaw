// 042 — Windowed TurnStore 4-tier (M3.1b). The ONLY external store slot in
// the D3 hybrid: scope.tsx keeps pure UI state, this store owns turn data,
// windows, and budgets. useSyncExternalStore-only — no zustand, no Context
// arrays. Transport (EventSource/generation guard) stays in the 032
// sync-provider; invalidation arrives as explicit actions.
import type { TurnSegment } from '../../../../../src/shared/chat-events.ts';
import {
    createTurnStreamState,
    reduce,
    reduceBatch,
} from '../reducer.ts';
import type {
    TurnStreamAction,
    TurnStreamState,
    TurnTerminalStatus,
} from '../types.ts';
import {
    createTierBudget,
    enforceBudget,
    estimateBytes,
    removeEntry,
    setPinned,
    touchEntry,
    type BodyFidelity,
    type TierBudget,
} from './tier-budget.ts';

export const T1_OVERSCAN_TURNS = 40;
export const T2_MAX_TURNS = 200;            // client turns budget (NOT server 200 messages)
export const T2_MAX_BYTES = 32 * 1024 * 1024;
export const T3_MAX_BYTES = 16 * 1024 * 1024;
export const PREVIEW_CHARS = 512;
export const SUMMARY_CHARS = 96;

export interface CommittedStub {
    turnId: string;
    terminalStatus: TurnTerminalStatus;
    heightEstimate: number;
    version: number;
}

export interface TurnBodySnapshot {
    turnId: string;
    fidelity: BodyFidelity;
    text: string | null;
    toolLog: string | null;
    provenance: string | null;
}

export interface LiveTurnModel {
    turnId: string;
    rows: TurnSegment[];
    version: number;
}

export interface ListSnapshot {
    order: readonly string[];
    version: number;
    needsBackfill: boolean;
    budgetPressure: boolean;
}

export interface LiveSnapshot {
    turnIds: readonly string[];
    version: number;
    liveBudgetPressure: boolean;
}

type Unsubscribe = () => void;

export interface TurnStore {
    ingest(actions: TurnStreamAction | readonly TurnStreamAction[]): void;
    subscribeTurn(turnId: string, cb: () => void): Unsubscribe;
    subscribeList(cb: () => void): Unsubscribe;
    subscribeLive(cb: () => void): Unsubscribe;
    getTurnSnapshot(turnId: string): CommittedStub | null;
    getBodySnapshot(turnId: string): TurnBodySnapshot | null;
    getLiveTurn(turnId: string): LiveTurnModel | null;
    /** streaming body for a live turn via the traceRunId→turnId join */
    getLiveBodyForTurn(turnId: string): string | null;
    getListSnapshot(): ListSnapshot;
    getLiveSnapshot(): LiveSnapshot;
    /** T1 projection: committed turn ids in viewport ± overscan */
    getWindow(centerIndex: number, visibleCount: number): readonly string[];
    pinTurn(turnId: string, pinned: boolean): void;
    /** T3 expanded detail cache */
    putDetail(key: string, detail: unknown, pinned?: boolean): void;
    collapseDetail(key: string): void;
    hasDetail(key: string): boolean;
    detailBytes(): number;
    /** scope-generation fetch guard: resolve callbacks from stale scopes drop */
    beginFetch(): number;
    resolveFetch(token: number, apply: () => void): boolean;
    dispose(): void;
    /** test/diagnostic surface */
    stats(): {
        t0Count: number; liveCount: number; t2Turns: number; t2Bytes: number;
        t3Bytes: number; budgetPressure: boolean; liveBudgetPressure: boolean;
    };
}

interface BodyRecord {
    fidelity: BodyFidelity;
    text: string | null;
    toolLog: string | null;
    provenance: string | null;
    snapshot: TurnBodySnapshot | null;
}

export function createTurnStore(
    scopeKey: string,
    options: {
        sessionFilter?: string | null;
        liveBudgetBytes?: number;
        /** test-only budget overrides; production uses the module constants */
        t2MaxBytes?: number;
        t2MaxTurns?: number;
        t3MaxBytes?: number;
    } = {},
): TurnStore {
    let reducerState: TurnStreamState = createTurnStreamState(scopeKey, options.sessionFilter ?? null);
    const liveBudgetBytes = options.liveBudgetBytes ?? 8 * 1024 * 1024;

    // T0 committed index (never evicted before dispose)
    const stubs = new Map<string, CommittedStub>();
    let order: string[] = [];
    let listVersion = 0;
    let listSnapshot: ListSnapshot | null = null;

    // live turns live OUTSIDE the tiers
    const liveTurns = new Map<string, LiveTurnModel>();
    let liveVersion = 0;
    let liveSnapshot: LiveSnapshot | null = null;
    let liveBudgetPressure = false;

    // T2 committed bodies + T3 expanded details
    const bodies = new Map<string, BodyRecord>();
    const t2: TierBudget = createTierBudget(options.t2MaxBytes ?? T2_MAX_BYTES, {
        maxEntries: options.t2MaxTurns ?? T2_MAX_TURNS,
        mode: 'downgrade',
    });
    const t3: TierBudget = createTierBudget(options.t3MaxBytes ?? T3_MAX_BYTES, { mode: 'evict' });
    const details = new Map<string, unknown>();

    const turnSubscribers = new Map<string, Set<() => void>>();
    const listSubscribers = new Set<() => void>();
    const liveSubscribers = new Set<() => void>();

    let generation = 0;
    let disposed = false;

    function bodyFor(turnId: string): BodyRecord | null {
        const hydrated = reducerState.bodies[turnId];
        if (!hydrated) return null;
        const existing = bodies.get(turnId);
        if (existing) return existing;
        const record: BodyRecord = {
            fidelity: 'full',
            text: hydrated.text,
            toolLog: hydrated.toolLog,
            provenance: hydrated.provenance,
            snapshot: null,
        };
        bodies.set(turnId, record);
        touchEntry(t2, turnId, estimateBytes([record.text, record.toolLog]));
        enforceT2();
        return record;
    }

    function applyT2Step(step: { key: string; action: string; to: BodyFidelity | null }): void {
        const record = bodies.get(step.key);
        if (!record || step.to === null || step.to === 'stub') {
            // stub = index-only: the T0 stub keeps the turn addressable and the
            // body re-materializes from the reducer/023 page on next access.
            removeEntry(t2, step.key);
            bodies.delete(step.key);
            return;
        }
        record.fidelity = step.to;
        record.snapshot = null;
        if (step.to === 'preview') record.text = record.text?.slice(0, PREVIEW_CHARS) ?? null;
        else if (step.to === 'summary') { record.text = record.text?.slice(0, SUMMARY_CHARS) ?? null; record.toolLog = null; }
        const entry = t2.entries.get(step.key);
        touchEntry(t2, step.key, estimateBytes([record.text, record.toolLog]), {
            fidelity: step.to,
            pinned: entry?.pinned ?? false,
        });
    }

    function enforceT2(): void {
        enforceBudget(t2, step => applyT2Step(step));
    }

    function enforceT3(): void {
        enforceBudget(t3, step => {
            details.delete(step.key);
            removeEntry(t3, step.key);
        });
    }

    /** fold the reducer state delta into tiers; ONE notify batch per ingest */
    function fold(previous: TurnStreamState): void {
        const changedTurns = new Set<string>();
        const bumped = new Set<string>();
        let listChanged = false;
        let liveChanged = false;

        if (reducerState.rowOrder !== previous.rowOrder
            || reducerState.turnStatus !== previous.turnStatus) {
            // recompute committed/live membership from durable rows; the
            // committed ORDER always follows the reducer's canonical rowOrder
            // (arrival-order independent), never turn_end arrival order
            const seenTurnIds: string[] = [];
            const seen = new Set<string>();
            for (const key of reducerState.rowOrder) {
                const turnId = reducerState.rows[key].turnId;
                if (!seen.has(turnId)) { seen.add(turnId); seenTurnIds.push(turnId); }
            }
            for (const turnId of seenTurnIds) {
                const terminal = reducerState.turnStatus[turnId];
                if (terminal) {
                    const stub = stubs.get(turnId);
                    if (!stub) {
                        // turn_end transaction: leave liveTurns and enter T0 in
                        // the SAME commit (single notify batch)
                        if (liveTurns.delete(turnId)) liveChanged = true;
                        stubs.set(turnId, {
                            turnId,
                            terminalStatus: terminal,
                            heightEstimate: 72,
                            version: 1,
                        });
                        listChanged = true;
                        changedTurns.add(turnId);
                        bumped.add(turnId);
                    } else if (stub.terminalStatus !== terminal) {
                        stubs.set(turnId, { ...stub, terminalStatus: terminal, version: stub.version + 1 });
                        changedTurns.add(turnId);
                        bumped.add(turnId);
                    }
                } else if (!stubs.has(turnId)) {
                    // active/incomplete turn: liveTurns only, never T0
                    const rows = reducerState.rowOrder
                        .filter(key => reducerState.rows[key].turnId === turnId)
                        .map(key => reducerState.rows[key]);
                    const existing = liveTurns.get(turnId);
                    if (!existing || existing.rows.length !== rows.length) {
                        liveTurns.set(turnId, { turnId, rows, version: (existing?.version ?? 0) + 1 });
                        liveChanged = true;
                    }
                }
            }
            if (listChanged) {
                // canonical committed order derived from rowOrder sequence
                order = seenTurnIds.filter(turnId => stubs.has(turnId));
            }
        }

        if (reducerState.bodies !== previous.bodies) {
            for (const turnId of Object.keys(reducerState.bodies)) {
                if (reducerState.bodies[turnId] !== previous.bodies[turnId]) {
                    const record = bodies.get(turnId);
                    if (record) {
                        record.text = reducerState.bodies[turnId].text;
                        record.toolLog = reducerState.bodies[turnId].toolLog;
                        record.provenance = reducerState.bodies[turnId].provenance;
                        record.fidelity = 'full';
                        record.snapshot = null;
                        touchEntry(t2, turnId, estimateBytes([record.text, record.toolLog]), { fidelity: 'full' });
                    }
                    changedTurns.add(turnId);
                }
            }
            enforceT2();
        }

        if (reducerState.liveBodies !== previous.liveBodies) {
            let liveBytes = 0;
            for (const text of Object.values(reducerState.liveBodies)) liveBytes += estimateBytes(text);
            const pressure = liveBytes > liveBudgetBytes;
            if (pressure !== liveBudgetPressure) liveBudgetPressure = pressure;
            liveChanged = true;
        }

        if (reducerState.needsBackfill !== previous.needsBackfill) listChanged = true;

        // single notify batch
        if (listChanged) { listVersion += 1; listSnapshot = null; }
        if (liveChanged) { liveVersion += 1; liveSnapshot = null; }
        for (const turnId of changedTurns) {
            if (bumped.has(turnId)) continue;
            const stub = stubs.get(turnId);
            if (stub) stubs.set(turnId, { ...stub, version: stub.version + 1 });
        }
        const notified = new Set<() => void>();
        for (const turnId of changedTurns) {
            for (const cb of turnSubscribers.get(turnId) ?? []) {
                if (!notified.has(cb)) { notified.add(cb); cb(); }
            }
        }
        if (listChanged) for (const cb of listSubscribers) cb();
        if (liveChanged) for (const cb of liveSubscribers) cb();
    }

    return {
        ingest(input) {
            if (disposed) return;
            const actions = Array.isArray(input) ? input : [input as TurnStreamAction];
            const previous = reducerState;
            reducerState = reduceBatch(reducerState, actions);
            if (reducerState === previous) return;
            // port_change disposes the previous scope before the new snapshot
            const portChange = actions.some(a => a.kind === 'invalidation' && a.reason === 'port_change');
            if (portChange) {
                stubs.clear(); order = []; liveTurns.clear(); bodies.clear();
                t2.entries.clear(); t2.totalBytes = 0;
                t3.entries.clear(); t3.totalBytes = 0; details.clear();
                generation += 1;
                listVersion += 1; listSnapshot = null;
                liveVersion += 1; liveSnapshot = null;
                for (const cb of listSubscribers) cb();
                for (const cb of liveSubscribers) cb();
                return;
            }
            fold(previous);
        },
        subscribeTurn(turnId, cb) {
            let set = turnSubscribers.get(turnId);
            if (!set) { set = new Set(); turnSubscribers.set(turnId, set); }
            set.add(cb);
            return () => { set!.delete(cb); if (!set!.size) turnSubscribers.delete(turnId); };
        },
        subscribeList(cb) {
            listSubscribers.add(cb);
            return () => listSubscribers.delete(cb);
        },
        subscribeLive(cb) {
            liveSubscribers.add(cb);
            return () => liveSubscribers.delete(cb);
        },
        getTurnSnapshot(turnId) {
            return stubs.get(turnId) ?? null;
        },
        getBodySnapshot(turnId) {
            const record = bodyFor(turnId);
            if (!record) return null;
            if (!record.snapshot) {
                record.snapshot = {
                    turnId,
                    fidelity: record.fidelity,
                    text: record.text,
                    toolLog: record.toolLog,
                    provenance: record.provenance,
                };
            }
            return record.snapshot;
        },
        getLiveTurn(turnId) {
            return liveTurns.get(turnId) ?? null;
        },
        getLiveBodyForTurn(turnId) {
            for (const [runId, text] of Object.entries(reducerState.liveBodies)) {
                if (reducerState.runToTurn[runId] === turnId) return text;
            }
            return null;
        },
        getListSnapshot() {
            if (!listSnapshot) {
                listSnapshot = {
                    order: [...order],
                    version: listVersion,
                    needsBackfill: reducerState.needsBackfill,
                    budgetPressure: t2.pressure,
                };
            }
            return listSnapshot;
        },
        getLiveSnapshot() {
            if (!liveSnapshot) {
                liveSnapshot = { turnIds: [...liveTurns.keys()], version: liveVersion, liveBudgetPressure };
            }
            return liveSnapshot;
        },
        getWindow(centerIndex, visibleCount) {
            const half = Math.ceil(visibleCount / 2);
            const start = Math.max(0, centerIndex - half - T1_OVERSCAN_TURNS);
            const end = Math.min(order.length, centerIndex + half + T1_OVERSCAN_TURNS);
            return order.slice(start, end);
        },
        pinTurn(turnId, pinned) {
            bodyFor(turnId);
            setPinned(t2, turnId, pinned);
            enforceT2();
        },
        putDetail(key, detail, pinned = false) {
            details.set(key, detail);
            touchEntry(t3, key, estimateBytes(detail), { pinned });
            enforceT3();
        },
        collapseDetail(key) {
            // collapse/unpin marks the entry as the preferred eviction victim
            setPinned(t3, key, false);
            enforceT3();
        },
        hasDetail(key) {
            return details.has(key);
        },
        detailBytes() {
            return t3.totalBytes;
        },
        beginFetch() {
            return generation;
        },
        resolveFetch(token, apply) {
            if (disposed || token !== generation) return false;
            apply();
            return true;
        },
        dispose() {
            disposed = true;
            generation += 1;
            stubs.clear(); order = []; liveTurns.clear(); bodies.clear();
            details.clear();
            t2.entries.clear(); t3.entries.clear();
            turnSubscribers.clear(); listSubscribers.clear(); liveSubscribers.clear();
        },
        stats() {
            return {
                t0Count: stubs.size,
                liveCount: liveTurns.size,
                t2Turns: t2.entries.size,
                t2Bytes: t2.totalBytes,
                t3Bytes: t3.totalBytes,
                budgetPressure: t2.pressure,
                liveBudgetPressure,
            };
        },
    };
}
