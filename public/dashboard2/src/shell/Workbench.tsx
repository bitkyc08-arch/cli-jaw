import { PanelRightOpen, X } from '@lucide/icons';
import type { JSX } from 'react';
import { useAppScope, type SessionScope } from '../state/scope.tsx';
import { ChatView } from '../chat/ChatView.tsx';
import { Icon } from './Icon.tsx';

interface PaneDescriptor {
    id: 'primary' | 'side';
    title: string;
    closeable: boolean;
}

function PaneScope({ scope }: { scope: SessionScope | null }): JSX.Element {
    if (!scope) {
        return <div className="d2-pane-empty">No session selected</div>;
    }
    return (
        <div className="d2-pane-scope">
            <span>port {scope.port}</span>
            <span>/</span>
            <span>session {scope.sessionId}</span>
        </div>
    );
}

export function Workbench(): JSX.Element {
    const { selected, sidePaneOpen, openSidePane, closeSidePane } = useAppScope();
    const panes: PaneDescriptor[] = [
        { id: 'primary', title: 'Primary', closeable: false },
        ...(sidePaneOpen
            ? [{ id: 'side', title: 'Side pane', closeable: true } as const]
            : []),
    ];

    return (
        <section className="d2-workbench" aria-label="Session workbench">
            <header className="d2-workbench-header">
                <div>
                    <strong>Workbench</strong>
                    <span>{selected ? `Port ${selected.port}` : 'No active scope'}</span>
                </div>
                {!sidePaneOpen ? (
                    <button type="button" className="d2-command-button" onClick={openSidePane}>
                        <Icon icon={PanelRightOpen} />
                        <span>Open side pane</span>
                    </button>
                ) : null}
            </header>

            <div className={`d2-pane-grid d2-pane-grid-${panes.length}`}>
                {panes.map((pane) => (
                    <article className="d2-pane" key={pane.id} data-pane={pane.id}>
                        <header className="d2-pane-header">
                            <span>{pane.title}</span>
                            {pane.closeable ? (
                                <button
                                    className="d2-icon-button"
                                    type="button"
                                    onClick={closeSidePane}
                                    aria-label="Close side pane"
                                    title="Close side pane"
                                >
                                    <Icon icon={X} />
                                </button>
                            ) : null}
                        </header>
                        <div className="d2-pane-body">
                            {pane.id === 'primary' && selected ? (
                                <ChatView scope={selected} />
                            ) : (
                                <PaneScope scope={selected} />
                            )}
                        </div>
                    </article>
                ))}
            </div>
        </section>
    );
}
