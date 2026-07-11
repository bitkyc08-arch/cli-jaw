// 042 — useSyncExternalStore bridge (the only React-facing surface of the
// TurnStore). Server snapshots are deterministic empties: dashboard2 is
// client-only but tests/hydration must not warn.
import { useSyncExternalStore } from 'react';
import type {
    CommittedStub, ListSnapshot, LiveSnapshot, TurnBodySnapshot, TurnStore,
} from './turn-store.ts';

const EMPTY_LIST: ListSnapshot = {
    order: [], version: -1, needsBackfill: false, budgetPressure: false,
};
const EMPTY_LIVE: LiveSnapshot = { turnIds: [], version: -1, liveBudgetPressure: false };

export function useTurn(store: TurnStore, turnId: string): CommittedStub | null {
    return useSyncExternalStore(
        (cb) => store.subscribeTurn(turnId, cb),
        () => store.getTurnSnapshot(turnId),
        () => null,
    );
}

export function useTurnBody(store: TurnStore, turnId: string): TurnBodySnapshot | null {
    return useSyncExternalStore(
        (cb) => store.subscribeTurn(turnId, cb),
        () => store.getBodySnapshot(turnId),
        () => null,
    );
}

export function useTurnList(store: TurnStore): ListSnapshot {
    return useSyncExternalStore(
        (cb) => store.subscribeList(cb),
        () => store.getListSnapshot(),
        () => EMPTY_LIST,
    );
}

export function useLiveTurns(store: TurnStore): LiveSnapshot {
    return useSyncExternalStore(
        (cb) => store.subscribeLive(cb),
        () => store.getLiveSnapshot(),
        () => EMPTY_LIVE,
    );
}
