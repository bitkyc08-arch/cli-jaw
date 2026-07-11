import { useSyncExternalStore } from 'react';
import type { PendingItem } from '../../../../../src/shared/chat-events.ts';
import {
    PendingQueueMachine,
    type PendingQueueAction,
    type PendingQueueSnapshot,
} from './pending-queue-machine.ts';

const EMPTY_SNAPSHOT: PendingQueueSnapshot = { scope: '', rows: [], version: -1 };

export interface PendingQueueStore {
    subscribe(listener: () => void): () => void;
    getSnapshot(): PendingQueueSnapshot;
    setScope(scope: string): void;
    ingest(scope: string, items: readonly PendingItem[]): void;
    activate(itemId: string, action: PendingQueueAction): void;
    dispose(): void;
}

export function createPendingQueueStore(machine: PendingQueueMachine): PendingQueueStore {
    return {
        subscribe: machine.subscribe,
        getSnapshot: machine.getSnapshot,
        setScope: scope => machine.setScope(scope),
        ingest: (scope, items) => machine.reconcile(scope, items),
        activate: (itemId, action) => machine.activate(itemId, action),
        dispose: () => machine.dispose(),
    };
}

export function usePendingQueue(store: PendingQueueStore): PendingQueueSnapshot {
    return useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY_SNAPSHOT);
}
