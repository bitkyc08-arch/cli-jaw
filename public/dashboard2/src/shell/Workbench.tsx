import { PanelLeft, PanelRight, Settings } from '@lucide/icons';
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { DashboardInstance } from '../../../../src/manager/types.ts';
import { ChatView } from '../chat/ChatView.tsx';
import { HoverDock } from '../features/hover-dock/HoverDock.tsx';
import { useManagerApi } from '../providers/api-provider.tsx';
import { useAppScope } from '../state/scope.tsx';
import { Icon } from './Icon.tsx';
import { SidePane } from './SidePane.tsx';

const LazySettingsWorkspace = lazy(() =>
    import('../features/settings/SettingsWorkspace.tsx').then((m) => ({ default: m.SettingsWorkspace })),
);

const PANE_MIN = 280;
const CHAT_MIN = 280;
const DIVIDER_WIDTH = 1;
const PANE_DEFAULT = 340;

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
    const { selected, sidePaneOpen, openSidePane, guardedCloseSidePane, workspaceMode, guardedSetWorkspaceMode } = useAppScope();
    const [instanceNames, setInstanceNames] = useState<Map<number, string>>(() => new Map());
    const wbRef = useRef<HTMLElement>(null);
    const toggleButtonRef = useRef<HTMLButtonElement>(null);
    const [paneWidth, setPaneWidth] = useState(PANE_DEFAULT);

    // CF-4 — one bounds helper for the state, the CSS, the pointer drag, and
    // ARIA. The initial PANE_DEFAULT can exceed the max on a narrow workbench,
    // and the drag clamp can dip below the min when the max itself is smaller,
    // which produced aria-valuenow > aria-valuemax and aria-valuenow <
    // aria-valuemin.
    const paneBounds = useCallback((): { min: number; max: number } => {
        const wb = wbRef.current;
        const rect = wb?.getBoundingClientRect();
        const max = rect ? Math.max(PANE_MIN, rect.width - CHAT_MIN - DIVIDER_WIDTH) : 600;
        return { min: PANE_MIN, max };
    }, []);
    const clampPaneWidth = useCallback((value: number): number => {
        const { min, max } = paneBounds();
        return Math.max(min, Math.min(max, value));
    }, [paneBounds]);

    // Keep the state and CSS inside bounds whenever the bounds change (resize
    // or first open), so the initial width cannot exceed the max.
    useEffect(() => {
        const clamped = clampPaneWidth(paneWidth);
        if (clamped !== paneWidth) setPaneWidth(clamped);
        wbRef.current?.style.setProperty('--d2-pane-w', `${clamped}px`);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sidePaneOpen, clampPaneWidth]);

    const closeSidePaneWithFocusRestore = useCallback(async () => {
        const focusWasInsidePane = Boolean(
            wbRef.current?.querySelector('.d2-side-pane')?.contains(document.activeElement),
        );
        const closed = await guardedCloseSidePane();
        if (closed && focusWasInsidePane) {
            requestAnimationFrame(() => toggleButtonRef.current?.focus());
        }
    }, [guardedCloseSidePane]);

    const toggleSidePane = sidePaneOpen ? () => void closeSidePaneWithFocusRestore() : openSidePane;

    const dragListenersRef = useRef<{ move: (ev: PointerEvent) => void; up: () => void } | null>(null);

    const onDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const handle = e.currentTarget;
        handle.classList.add('is-dragging');
        handle.setPointerCapture(e.pointerId);

        const move = (ev: PointerEvent) => {
            const wb = wbRef.current;
            if (!wb) return;
            const rect = wb.getBoundingClientRect();
            const paneWidth = clampPaneWidth(rect.right - ev.clientX);
            wb.style.setProperty('--d2-pane-w', `${paneWidth}px`);
            setPaneWidth(paneWidth);
        };
        const up = (): void => {
            handle.classList.remove('is-dragging');
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            document.removeEventListener('pointercancel', up);
            dragListenersRef.current = null;
        };
        // CF-5 — the document listeners must not outlive the component if it
        // unmounts mid-drag. Track them so the unmount effect can release.
        dragListenersRef.current = { move, up };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        document.addEventListener('pointercancel', up);
    }, []);

    // CF-5 — release any in-flight drag listeners on unmount, so a drag that
    // outlives the component does not leave document listeners behind.
    useEffect(() => () => {
        const listeners = dragListenersRef.current;
        if (listeners) {
            document.removeEventListener('pointermove', listeners.move);
            document.removeEventListener('pointerup', listeners.up);
            document.removeEventListener('pointercancel', listeners.up);
            dragListenersRef.current = null;
        }
    }, []);

    const getPaneMax = useCallback((): number => {
        const wb = wbRef.current;
        if (!wb) return 600;
        const rect = wb.getBoundingClientRect();
        return rect.width - CHAT_MIN - DIVIDER_WIDTH;
    }, []);

    const onDividerKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
        const { max: paneMax } = paneBounds();
        let next = paneWidth;
        const step = e.shiftKey ? 50 : 10;
        switch (e.key) {
            case 'ArrowLeft':
                next = clampPaneWidth(paneWidth + step);
                break;
            case 'ArrowRight':
                next = clampPaneWidth(paneWidth - step);
                break;
            case 'Home':
                next = PANE_MIN;
                break;
            case 'End':
                next = paneMax;
                break;
            default:
                return;
        }
        e.preventDefault();
        setPaneWidth(next);
        const wb = wbRef.current;
        if (wb) {
            wb.style.setProperty('--d2-pane-w', `${next}px`);
        }
    }, [paneWidth, getPaneMax]);

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
                            // Shell hands focus here when the sidebar closes, so the
                            // class is part of that contract, not just styling.
                            className="d2-workbench-header-button d2-workbench-side-toggle-open"
                            type="button"
                            onClick={onOpenSidebar}
                            aria-label="Open sidebar"
                            title="Open sidebar"
                            aria-expanded={!sidebarCollapsed}
                        >
                            <Icon icon={PanelLeft} />
                        </button>
                    ) : null}
                    <span className="d2-workbench-title">
                        {workspaceMode === 'settings'
                            ? 'Settings'
                            : selected
                            ? instanceNames.get(selected.port) ?? `Port ${selected.port}`
                            : 'No session selected'}
                    </span>
                    {workspaceMode === 'chat' ? (
                        <button
                            className="d2-workbench-header-button"
                            type="button"
                            onClick={() => void guardedSetWorkspaceMode('settings')}
                            aria-label="Open settings"
                            title="Settings"
                        >
                            <Icon icon={Settings} />
                        </button>
                    ) : null}
                    {workspaceMode === 'chat' ? (
                        <HoverDock key={selected?.port ?? 'none'} port={selected?.port ?? null} />
                    ) : null}
                    <button
                        ref={toggleButtonRef}
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

                <div className="d2-workbench-chat" id="d2-chat-area">
                    <div
                        data-workspace-surface="settings"
                        style={{ display: workspaceMode === 'settings' ? 'grid' : 'none', gridArea: '1 / 1', width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', containerType: 'inline-size' }}
                        inert={workspaceMode !== 'settings'}
                        aria-hidden={workspaceMode !== 'settings'}
                    >
                        <Suspense fallback={<div className="d2-pane-empty">Loading settings...</div>}>
                            <LazySettingsWorkspace />
                        </Suspense>
                    </div>
                    <div
                        data-workspace-surface="chat"
                        style={{ display: workspaceMode === 'chat' ? 'grid' : 'none', gridArea: '1 / 1', width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' }}
                        inert={workspaceMode !== 'chat'}
                        aria-hidden={workspaceMode !== 'chat'}
                    >
                        {selected ? <ChatView scope={selected} /> : <div className="d2-pane-empty">No session selected</div>}
                    </div>
                </div>
            </div>

            {sidePaneOpen ? (
                <div
                    className="d2-workbench-divider-drag"
                    role="separator"
                    aria-orientation="vertical"
                    aria-valuenow={paneWidth}
                    aria-valuemin={PANE_MIN}
                    aria-valuemax={paneBounds().max}
                    tabIndex={0}
                    onPointerDown={onDividerDown}
                    onKeyDown={onDividerKeyDown}
                />
            ) : null}
            <div
                className="d2-workbench-side-pane-slot"
                style={{ display: sidePaneOpen ? undefined : 'none' }}
                inert={!sidePaneOpen}
                aria-hidden={!sidePaneOpen}
            >
                <SidePane open={sidePaneOpen} onClose={closeSidePaneWithFocusRestore} />
            </div>
        </section>
    );
}
