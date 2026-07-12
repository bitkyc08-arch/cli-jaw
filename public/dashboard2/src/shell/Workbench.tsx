import { PanelLeft, PanelRight } from '@lucide/icons';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { DashboardInstance } from '../../../../src/manager/types.ts';
import { ChatView } from '../chat/ChatView.tsx';
import { useManagerApi } from '../providers/api-provider.tsx';
import { useAppScope } from '../state/scope.tsx';
import { Icon } from './Icon.tsx';
import { SidePane } from './SidePane.tsx';

export interface WorkbenchProps {
    sidebarCollapsed?: boolean;
    onOpenSidebar?(): void;
}

function instanceName(instance: DashboardInstance): string {
    const label = instance.label?.trim();
    if (label) return label;
    const workingDir = instance.workingDir?.replace(/[\\/]+$/, '');
    return workingDir?.split(/[\\/]/).pop() || `Instance ${instance.port}`;
}

export function Workbench({
    sidebarCollapsed = false,
    onOpenSidebar,
}: WorkbenchProps): JSX.Element {
    const api = useManagerApi();
    const { selected, sidePaneOpen, openSidePane, closeSidePane } = useAppScope();
    const [instanceNames, setInstanceNames] = useState<Map<number, string>>(() => new Map());
    const PANE_MIN = 280;
    const PANE_MAX_RATIO = 0.55;
    const toggleSidePane = sidePaneOpen ? closeSidePane : openSidePane;
    const wbRef = useRef<HTMLElement>(null);

    const onDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const handle = e.currentTarget;
        handle.classList.add('is-dragging');
        handle.setPointerCapture(e.pointerId);

        const move = (ev: PointerEvent) => {
            const wb = wbRef.current;
            if (!wb) return;
            const rect = wb.getBoundingClientRect();
            const paneWidth = Math.max(PANE_MIN, Math.min(rect.width * PANE_MAX_RATIO, rect.right - ev.clientX));
            wb.style.setProperty('--d2-pane-w', `${paneWidth}px`);
        };
        const up = () => {
            handle.classList.remove('is-dragging');
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
    }, []);

    useEffect(() => {
        let mounted = true;
        void api.fetchInstances().then((instances) => {
            if (!mounted) return;
            setInstanceNames(new Map(instances.map((instance) => [instance.port, instanceName(instance)])));
        }).catch(() => {
            // The port remains a stable fallback when instance discovery is unavailable.
        });
        return () => { mounted = false; };
    }, [api]);

    return (
        <section
            ref={wbRef}
            className={`d2-workbench${sidePaneOpen ? ' d2-workbench-side-open' : ''}`}
            aria-label="Session workbench"
        >
            <div className="d2-workbench-left">
                <header className="d2-workbench-left-header">
                    {sidebarCollapsed ? (
                        <button
                            className="d2-workbench-header-button"
                            type="button"
                            onClick={onOpenSidebar}
                            aria-label="Open sidebar"
                            title="Open sidebar"
                        >
                            <Icon icon={PanelLeft} />
                        </button>
                    ) : null}
                    <span className="d2-workbench-title">
                        {selected
                            ? instanceNames.get(selected.port) ?? `Port ${selected.port}`
                            : 'No session selected'}
                    </span>
                    <button
                        className="d2-workbench-header-button d2-workbench-side-toggle"
                        type="button"
                        onClick={toggleSidePane}
                        aria-label={sidePaneOpen ? 'Close side pane' : 'Open side pane'}
                        title={sidePaneOpen ? 'Close side pane' : 'Open side pane'}
                        aria-pressed={sidePaneOpen}
                    >
                        <Icon icon={PanelRight} />
                    </button>
                </header>

                <div className="d2-workbench-chat">
                    {selected ? (
                        <ChatView scope={selected} />
                    ) : (
                        <div className="d2-pane-empty">No session selected</div>
                    )}
                </div>
            </div>

            {sidePaneOpen ? <div className="d2-workbench-divider-drag" aria-hidden="true" onPointerDown={onDividerDown} /> : null}
            {sidePaneOpen ? <SidePane onClose={closeSidePane} /> : null}
        </section>
    );
}
