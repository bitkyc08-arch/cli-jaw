import { createRoot } from 'react-dom/client';
import type { PendingItem } from '../../../../../src/shared/chat-events.ts';
import { PendingQueueView } from './PendingQueue.tsx';
import { PendingQueueMachine, type PendingQueueMutationApi } from './pending-queue-machine.ts';
import { createPendingQueueStore, type PendingQueueStore } from './pending-queue-store.ts';

export function mountPendingQueueHarness(target: HTMLElement, items: readonly PendingItem[]): PendingQueueStore {
    const api: PendingQueueMutationApi = {
        hold: async () => undefined,
        releaseHold: async () => undefined,
        steer: async () => undefined,
        delete: async () => undefined,
        refetch: async () => items,
    };
    const store = createPendingQueueStore(new PendingQueueMachine(api));
    store.setScope('browser');
    store.ingest('browser', items);
    createRoot(target).render(<PendingQueueView store={store} />);
    return store;
}
