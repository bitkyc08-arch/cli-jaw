// 042 — versioned snapshot + viewport index selectors over the TurnStore.
// Pure functions; referential stability is owned by the store snapshots.
import type { CommittedStub, ListSnapshot, TurnStore } from './turn-store.ts';

/** committed stubs for the T1 window (viewport ± overscan) */
export function selectWindowStubs(
    store: TurnStore,
    centerIndex: number,
    visibleCount: number,
): CommittedStub[] {
    const out: CommittedStub[] = [];
    for (const key of store.getWindow(centerIndex, visibleCount)) {
        if (key.startsWith('msg:')) continue; // legacy rows carry no stub
        const stub = store.getTurnSnapshot(key.startsWith('turn:') ? key.slice(5) : key);
        if (stub) out.push(stub);
    }
    return out;
}

/** index of a turn in the transcript order, -1 when absent */
export function selectTurnIndex(list: ListSnapshot, turnId: string): number {
    return list.order.indexOf(`turn:${turnId}`);
}

/** true when the list needs a 048 history backfill merge */
export function selectNeedsBackfill(list: ListSnapshot): boolean {
    return list.needsBackfill;
}
