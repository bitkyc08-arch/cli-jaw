import { CornerUpRight, Trash2, X } from '@lucide/icons';
import { useEffect, useMemo, type JSX } from 'react';
import { useManagerSync } from '../../providers/sync-provider.tsx';
import { Icon } from '../../shell/Icon.tsx';
import { useAppScope } from '../../state/scope.tsx';
import { createPendingQueueApi } from './pending-queue-api.ts';
import { PendingQueueMachine, type PendingQueueAction } from './pending-queue-machine.ts';
import { createPendingQueueStore, usePendingQueue, type PendingQueueStore } from './pending-queue-store.ts';
import './pending-queue.css';

function actionLabel(action: PendingQueueAction, phase: string | undefined): string {
    if (phase === 'armed') return `Cancel ${action}`;
    if (phase === 'submitting') return `${action} in progress`;
    return action === 'steer' ? 'Steer with this message' : 'Delete queued message';
}

export function PendingQueueView(props: { store: PendingQueueStore }): JSX.Element | null {
    const snapshot = usePendingQueue(props.store);
    if (snapshot.rows.length === 0) return null;

    return (
        <section className="d2-pending" aria-label="Pending messages">
            <header className="d2-pending-header">
                <h2>Pending</h2>
                <span>{snapshot.rows.length}</span>
            </header>
            <ol className="d2-pending-list">
                {snapshot.rows.map(({ item, overlay }) => {
                    const armed = overlay?.phase === 'armed';
                    const disabled = overlay?.phase === 'submitting';
                    const status = armed
                        ? `${overlay.action === 'steer' ? 'Steer' : 'Delete'} armed. Activate again to cancel.`
                        : overlay?.phase === 'error' ? overlay.message : null;
                    return (
                        <li className="d2-pending-row" data-phase={overlay?.phase ?? 'synced'} key={item.id}>
                            <div className="d2-pending-copy">
                                <p>{item.prompt}</p>
                                <span>{item.source}</span>
                                <span className="d2-pending-status" aria-live="polite" aria-atomic="true">
                                    {status}
                                </span>
                            </div>
                            <div className="d2-pending-actions">
                                <button
                                    type="button"
                                    aria-label={actionLabel('steer', overlay?.action === 'steer' ? overlay.phase : undefined)}
                                    aria-pressed={armed && overlay.action === 'steer'}
                                    disabled={disabled}
                                    onClick={() => props.store.activate(item.id, 'steer')}
                                    title="Steer with this message"
                                >
                                    <Icon icon={armed && overlay.action === 'steer' ? X : CornerUpRight} />
                                </button>
                                <button
                                    type="button"
                                    aria-label={actionLabel('delete', overlay?.action === 'delete' ? overlay.phase : undefined)}
                                    aria-pressed={armed && overlay.action === 'delete'}
                                    disabled={disabled}
                                    onClick={() => props.store.activate(item.id, 'delete')}
                                    title="Delete queued message"
                                >
                                    <Icon icon={armed && overlay.action === 'delete' ? X : Trash2} />
                                </button>
                            </div>
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}

export function PendingQueue(): JSX.Element | null {
    const { selected } = useAppScope();
    const sync = useManagerSync();
    const port = selected?.port ?? null;
    const scope = selected ? `${selected.port}:${selected.sessionId}` : '';
    const binding = useMemo(() => {
        if (port === null) return null;
        const api = createPendingQueueApi(port);
        return { api, store: createPendingQueueStore(new PendingQueueMachine(api)) };
    }, [port]);
    const store = binding?.store ?? null;

    useEffect(() => {
        if (!binding) return;
        const { api, store: activeStore } = binding;
        activeStore.setScope(scope);
        const unsubscribeQueue = sync.subscribeQueueUpdate(payload => activeStore.ingest(scope, payload.queued));
        const unsubscribeInvalidation = sync.subscribeInvalidation(() => {
            void api.refetch().then(items => activeStore.ingest(scope, items)).catch(() => undefined);
        });
        void api.refetch().then(items => activeStore.ingest(scope, items)).catch(() => undefined);
        return () => {
            unsubscribeQueue();
            unsubscribeInvalidation();
        };
    }, [binding, scope, sync]);

    useEffect(() => () => store?.dispose(), [store]);
    return store ? <PendingQueueView store={store} /> : null;
}
