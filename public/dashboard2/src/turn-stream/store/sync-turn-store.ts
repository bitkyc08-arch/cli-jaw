// 042 — invalidation bridge: subscribes ONCE to the 032 sync-provider
// invalidation surface and forwards reasons as explicit 041 actions.
// No transport logic here — EventSource/generation guard stay provider-owned.
import type { TurnStore } from './turn-store.ts';

export type SyncInvalidationReason = 'replay_gap' | 'reconnect' | 'port_change';

export type SubscribeInvalidation =
    (cb: (reason: SyncInvalidationReason) => void) => () => void;

export function attachSyncInvalidation(
    store: TurnStore,
    subscribeInvalidation: SubscribeInvalidation,
): () => void {
    return subscribeInvalidation((reason) => {
        store.ingest({ kind: 'invalidation', reason });
    });
}
