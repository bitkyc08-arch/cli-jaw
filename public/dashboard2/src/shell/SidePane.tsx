// 089.04 — instance-based SidePane with explicit-close lifecycle.
import { Bell, ChevronDown, ClipboardList, Code, File, FileText, Globe, NotebookPen, Plus, Terminal, Users, X } from '@lucide/icons';
import { Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useManagerApi } from '../providers/api-provider.tsx';
import { useDesktopBridge } from '../providers/desktop-bridge-provider.tsx';
import {
    useAppScope,
    type SidePanePanelInstance,
    type SidePanePanelType,
} from '../state/scope.tsx';
import { Icon } from './Icon.tsx';
import { PanelErrorBoundary } from './PanelErrorBoundary.tsx';
import { BrowserPanel } from './panels/BrowserPanel.tsx';
import { FileTreePanel } from './panels/FileTreePanel.tsx';
import { TerminalPanel } from './panels/TerminalPanel.tsx';
import {
    initialTerminalRequestLedger,
    dispatchTerminalShortcutIntent,
    normalizeTerminalShortcutAction,
    terminalRequestLedgerReducer,
    type TerminalRequestLedger,
} from './panels/terminal-session-requests.ts';
import type { TerminalTarget } from './panels/terminal-session-state.ts';
import { isWidgetPanelPayload, type WidgetPanelPayload } from '../turn-stream/widgets/widget-panel-key.ts';
import { widgetUiStore } from '../turn-stream/widgets/widget-ui-store.ts';
import '../styles/side-pane-v4.css';

const LazyCodeTab = lazy(() => import('../code/index.ts'));
const LazyNotesPanel = lazy(() => import('../features/notes/NotesPanel.tsx').then((m) => ({ default: m.NotesPanel })));
const LazyBoardPanel = lazy(() => import('../features/board/BoardPanel.tsx').then((m) => ({ default: m.BoardPanel })));
const LazyRemindersPanel = lazy(() => import('../features/reminders/RemindersPanel.tsx').then((m) => ({ default: m.RemindersPanel })));
const LazyEmployeesPanel = lazy(() => import('../features/employees/EmployeesPanel.tsx').then((m) => ({ default: m.EmployeesPanel })));
const LazyDocPanel = lazy(() => import('../features/panels/DocPanel.tsx').then((m) => ({ default: m.DocPanel })));
const LazyDesignPanel = lazy(() => import('../features/panels/DesignPanel.tsx').then((m) => ({ default: m.DesignPanel })));
const LazyDiffPanel = lazy(() => import('../features/panels/DiffPanel.tsx').then((m) => ({ default: m.DiffPanel })));

interface TabDescriptor {
    id: SidePanePanelType;
    label: string;
    icon: typeof Terminal;
    category: 'tool' | 'feature';
    keepAlive: boolean;
    needsSession: boolean;
}

const TAB_REGISTRY: TabDescriptor[] = [
    { id: 'terminal', label: 'Terminal', icon: Terminal, category: 'tool', keepAlive: true, needsSession: true },
    { id: 'browser', label: 'Browser', icon: Globe, category: 'tool', keepAlive: true, needsSession: false },
    { id: 'files', label: 'Files', icon: File, category: 'tool', keepAlive: false, needsSession: false },
    { id: 'code', label: 'Code', icon: Code, category: 'tool', keepAlive: false, needsSession: true },
    { id: 'doc', label: 'Document', icon: FileText, category: 'tool', keepAlive: false, needsSession: false },
    { id: 'design', label: 'Design', icon: Globe, category: 'tool', keepAlive: false, needsSession: false },
    { id: 'diff', label: 'Diff', icon: Code, category: 'tool', keepAlive: false, needsSession: true },
    { id: 'notes', label: 'Notes', icon: NotebookPen, category: 'feature', keepAlive: true, needsSession: true },
    { id: 'board', label: 'Board', icon: ClipboardList, category: 'feature', keepAlive: true, needsSession: true },
    { id: 'reminders', label: 'Reminders', icon: Bell, category: 'feature', keepAlive: false, needsSession: true },
    { id: 'employees', label: 'Employees', icon: Users, category: 'feature', keepAlive: false, needsSession: true },
];

const TAB_MAP = new Map(TAB_REGISTRY.map((tab) => [tab.id, tab]));

/* ── Overflow constants ── */
const INLINE_TAB_LIMIT = 6;

type DocPayload = { path?: string; content?: string; truncated?: boolean; binary?: boolean };
type DesignPayload = { kind: 'url'; url: string } | WidgetPanelPayload;

function payloadObject(payload: unknown): Record<string, unknown> {
    return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
}

interface TabContentProps {
    panel: SidePanePanelInstance;
    active: boolean;
    terminalRequests: TerminalRequestLedger;
    consumeTerminalRequests(token: number): void;
    consumeTerminalFocus(token: number): void;
}

function TabContent({ panel, active, terminalRequests, consumeTerminalRequests, consumeTerminalFocus }: TabContentProps): JSX.Element | null {
    const { selected } = useAppScope();
    const api = useManagerApi();
    const [terminalWorkingDirectory, setTerminalWorkingDirectory] = useState<TerminalTarget | null>(null);
    const [terminalWorkingDirError, setTerminalWorkingDirError] = useState<string | null>(null);
    const cwdRequestGeneration = useRef(0);
    const desc = TAB_MAP.get(panel.type);

    useEffect(() => {
        const generation = ++cwdRequestGeneration.current;
        setTerminalWorkingDirectory(null);
        setTerminalWorkingDirError(null);
        if (panel.type !== 'terminal' || !selected) return;
        const requestedPort = selected.port;

        void api.fetchInstances().then((instances) => {
            if (cwdRequestGeneration.current !== generation) return;
            const instance = instances.find((candidate) => candidate.port === requestedPort);
            if (!instance?.workingDir) {
                setTerminalWorkingDirError('No working directory for this instance');
                return;
            }
            setTerminalWorkingDirectory({ port: requestedPort, cwd: instance.workingDir });
        }).catch((error: unknown) => {
            if (cwdRequestGeneration.current !== generation) return;
            setTerminalWorkingDirError(error instanceof Error ? error.message : 'Unable to load instance working directory');
        });
    }, [api, panel.type, selected?.port]);

    if (!desc) return null;
    if (desc.needsSession && !selected) {
        return active ? (
            <div className="d2-side-pane-placeholder" data-tab={panel.type}>
                <Icon icon={desc.icon} size={36} />
                <span>Select a session first</span>
            </div>
        ) : null;
    }

    const port = selected?.port ?? null;
    switch (panel.type) {
        case 'terminal':
            return (
                <TerminalPanel
                    port={port}
                    workingDirectory={terminalWorkingDirectory}
                    workingDirectoryError={terminalWorkingDirError}
                    terminalRequests={terminalRequests}
                    consumeTerminalRequests={consumeTerminalRequests}
                    consumeTerminalFocus={consumeTerminalFocus}
                />
            );
        case 'browser':
            return <BrowserPanel panelId={panel.id} />;
        case 'files':
            return <FileTreePanel />;
        case 'code':
            return <Suspense fallback={<div className="d2-side-pane-placeholder">Loading Code...</div>}><LazyCodeTab port={port!} /></Suspense>;
        case 'doc': {
            const raw = payloadObject(panel.payload);
            const payload: DocPayload = {
                ...(typeof raw['path'] === 'string' ? { path: raw['path'] } : {}),
                ...(typeof raw['content'] === 'string' ? { content: raw['content'] } : {}),
                ...(typeof raw['truncated'] === 'boolean' ? { truncated: raw['truncated'] } : {}),
                ...(typeof raw['binary'] === 'boolean' ? { binary: raw['binary'] } : {}),
            };
            return <Suspense fallback={<div className="d2-side-pane-placeholder">Loading document...</div>}><LazyDocPanel active={active} source="native-file" payload={payload} /></Suspense>;
        }
        case 'design': {
            const raw = payloadObject(panel.payload);
            const widgetPayload = isWidgetPanelPayload(panel.payload) && panel.key === panel.payload.panelKey
                ? panel.payload
                : null;
            const payload: DesignPayload | undefined = widgetPayload
                ?? (typeof raw['url'] === 'string' ? { kind: 'url', url: raw['url'] } : undefined);
            return <Suspense fallback={<div className="d2-side-pane-placeholder">Loading design...</div>}><LazyDesignPanel active={active} payload={payload} /></Suspense>;
        }
        case 'diff': {
            const raw = payloadObject(panel.payload);
            const rawMode: unknown = raw['mode'];
            const mode: 'staged' | 'unstaged' | undefined = rawMode === 'staged' || rawMode === 'unstaged' ? rawMode : undefined;
            const payload = {
                ...(typeof raw['repoRoot'] === 'string' ? { repoRoot: raw['repoRoot'] } : {}),
                ...(typeof raw['filePath'] === 'string' ? { filePath: raw['filePath'] } : {}),
                ...(mode ? { mode } : {}),
            };
            return <Suspense fallback={<div className="d2-side-pane-placeholder">Loading diff...</div>}><LazyDiffPanel active={active} payload={payload} /></Suspense>;
        }
        case 'notes':
            return <Suspense fallback={<div className="d2-side-pane-placeholder">Loading Notes...</div>}><LazyNotesPanel active={active} /></Suspense>;
        case 'board':
            return <Suspense fallback={<div className="d2-side-pane-placeholder">Loading Board...</div>}><LazyBoardPanel active={active} /></Suspense>;
        case 'reminders':
            return <Suspense fallback={<div className="d2-side-pane-placeholder">Loading Reminders...</div>}><LazyRemindersPanel active={active} /></Suspense>;
        case 'employees':
            return <Suspense fallback={<div className="d2-side-pane-placeholder">Loading Employees...</div>}><LazyEmployeesPanel active={active} port={port!} /></Suspense>;
    }
}

/* ── Overflow picker dropdown ── */
interface OverflowPickerProps {
    panels: readonly SidePanePanelInstance[];
    activePanelId: string | null;
    onSelect(id: string): void;
}

function OverflowPicker({ panels, activePanelId, onSelect }: OverflowPickerProps): JSX.Element {
    const [focusIndex, setFocusIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // Group panels by category
    const grouped = useMemo(() => {
        const tools: SidePanePanelInstance[] = [];
        const features: SidePanePanelInstance[] = [];
        for (const p of panels) {
            const desc = TAB_MAP.get(p.type);
            if (desc?.category === 'feature') features.push(p);
            else tools.push(p);
        }
        return { tools, features };
    }, [panels]);

    // Flat ordered list for keyboard navigation
    const flatItems = useMemo(
        () => [...grouped.tools, ...grouped.features],
        [grouped],
    );

    useEffect(() => {
        // Focus the first item on mount
        const first = listRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
        first?.focus();
    }, []);

    const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
        const len = flatItems.length;
        if (len === 0) return;
        let next = focusIndex;
        switch (event.key) {
            case 'ArrowDown':
                next = (focusIndex + 1) % len;
                break;
            case 'ArrowUp':
                next = (focusIndex - 1 + len) % len;
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = len - 1;
                break;
            case 'Enter':
            case ' ': {
                event.preventDefault();
                const item = flatItems[focusIndex];
                if (item) onSelect(item.id);
                return;
            }
            default:
                return;
        }
        event.preventDefault();
        setFocusIndex(next);
        const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
        buttons?.[next]?.focus();
    }, [flatItems, focusIndex, onSelect]);

    const renderItem = (panel: SidePanePanelInstance, idx: number): JSX.Element => {
        const desc = TAB_MAP.get(panel.type);
        const isActive = panel.id === activePanelId;
        return (
            <button
                key={panel.id}
                role="menuitem"
                type="button"
                className="d2-side-pane-overflow-item"
                aria-current={isActive ? 'true' : undefined}
                data-focused={idx === focusIndex ? 'true' : undefined}
                tabIndex={idx === focusIndex ? 0 : -1}
                onClick={() => onSelect(panel.id)}
                onMouseEnter={() => setFocusIndex(idx)}
            >
                {desc ? <Icon icon={desc.icon} size={14} /> : null}
                <span>{panel.title}</span>
            </button>
        );
    };

    // Compute the running index offset for features group
    const toolCount = grouped.tools.length;

    return (
        <div
            ref={listRef}
            className="d2-side-pane-overflow-dropdown"
            role="menu"
            aria-label="More tabs"
            onKeyDown={handleKeyDown}
        >
            {grouped.tools.length > 0 ? (
                <>
                    <div className="d2-side-pane-overflow-group-label">Tools</div>
                    {grouped.tools.map((p, i) => renderItem(p, i))}
                </>
            ) : null}
            {grouped.tools.length > 0 && grouped.features.length > 0 ? (
                <div className="d2-side-pane-overflow-sep" />
            ) : null}
            {grouped.features.length > 0 ? (
                <>
                    <div className="d2-side-pane-overflow-group-label">Features</div>
                    {grouped.features.map((p, i) => renderItem(p, toolCount + i))}
                </>
            ) : null}
        </div>
    );
}

interface SidePaneProps {
    open: boolean;
    onClose(): void;
}

export function SidePane({ open, onClose }: SidePaneProps): JSX.Element {
    const bridge = useDesktopBridge();
    const paneRef = useRef<HTMLElement>(null);
    const {
        panelInstances,
        activePanelId,
        panelOpenError,
        openPanel,
        guardedActivatePanel,
        guardedClosePanel,
        guardedCloseActivePanel,
        showPanelPicker,
    } = useAppScope();
    const [terminalRequests, dispatchTerminalRequest] = useReducer(
        terminalRequestLedgerReducer,
        initialTerminalRequestLedger,
    );
    const widgetSnapshot = useSyncExternalStore(
        widgetUiStore.subscribe,
        widgetUiStore.getSnapshot,
        widgetUiStore.getSnapshot,
    );
    const consumeTerminalRequests = useCallback((token: number) => {
        dispatchTerminalRequest({ type: 'consume-new-tab-through', token });
    }, []);
    const consumeTerminalFocus = useCallback((token: number) => {
        dispatchTerminalRequest({ type: 'consume-focus-through', token });
    }, []);
    const paneTabRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
    const [overflowOpen, setOverflowOpen] = useState(false);

    // Determine which tabs render inline vs overflow
    const needsOverflow = panelInstances.length > INLINE_TAB_LIMIT;
    const inlineTabs = needsOverflow ? panelInstances.slice(0, INLINE_TAB_LIMIT) : panelInstances;
    const overflowTabs = needsOverflow ? panelInstances : [];
    const overflowCount = needsOverflow ? panelInstances.length - INLINE_TAB_LIMIT : 0;

    // Close overflow when panel list changes
    useEffect(() => { setOverflowOpen(false); }, [panelInstances.length]);

    const handleOverflowSelect = useCallback(async (id: string) => {
        if (!await guardedActivatePanel(id)) return;
        setOverflowOpen(false);
        // Restore focus to the tab if it's inline, otherwise to the overflow trigger
        requestAnimationFrame(() => {
            const tabEl = paneTabRefs.current.get(id);
            if (tabEl) {
                tabEl.focus();
            } else {
                paneRef.current?.querySelector<HTMLButtonElement>('.d2-side-pane-overflow-trigger')?.focus();
            }
        });
    }, [guardedActivatePanel]);

    const handleTabActivate = useCallback((id: string) => {
        void guardedActivatePanel(id).then(activated => {
            if (!activated && activePanelId) paneTabRefs.current.get(activePanelId)?.focus();
        });
    }, [activePanelId, guardedActivatePanel]);

    const handlePaneTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>): void => {
        // Roving tabindex operates only over inline-visible tabs
        const ids = inlineTabs.map(p => p.id);
        const currentIndex = ids.indexOf(activePanelId ?? '');
        let nextIndex: number | null = null;
        switch (event.key) {
            case 'ArrowRight':
                nextIndex = (currentIndex + 1) % ids.length;
                break;
            case 'ArrowLeft':
                nextIndex = (currentIndex - 1 + ids.length) % ids.length;
                break;
            case 'Home':
                nextIndex = 0;
                break;
            case 'End':
                nextIndex = ids.length - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        const nextId = ids[nextIndex]!;
        void guardedActivatePanel(nextId).then(activated => {
            if (activated) paneTabRefs.current.get(nextId)?.focus();
        });
    }, [inlineTabs, activePanelId, guardedActivatePanel]);

    useEffect(() => {
        for (const state of Object.values(widgetSnapshot)) {
            if (state.handoff !== 'queued' || !state.request) continue;
            const request = state.request;
            openPanel({
                type: 'design',
                key: request.panelKey,
                title: request.descriptor.title,
                payload: request,
                keepAlive: true,
            });
            widgetUiStore.markPromotionDispatched(request.panelKey);
        }
    }, [openPanel, widgetSnapshot]);

    useEffect(() => {
        const mountedWidgetKeys = new Set(panelInstances.flatMap(panel => (
            panel.type === 'design'
            && isWidgetPanelPayload(panel.payload)
            && panel.key === panel.payload.panelKey
                ? [panel.key]
                : []
        )));
        widgetUiStore.reconcilePanelInstances(mountedWidgetKeys, panelOpenError);
    }, [panelInstances, panelOpenError, widgetSnapshot]);

    useEffect(() => {
        const shortcuts = bridge.shell.shortcuts.nativeAvailable ? bridge.shell.shortcuts.native : null;
        if (!shortcuts) return;
        return shortcuts.onAction((action) => {
            const intent = normalizeTerminalShortcutAction(action);
            if (!intent) return;
            dispatchTerminalShortcutIntent(intent, {
                openPanel: () => openPanel({ type: 'terminal', key: 'terminal', title: 'Terminal', keepAlive: true }),
                issueNewTab: () => dispatchTerminalRequest({ type: 'issue-new-tab' }),
                issueFocus: () => dispatchTerminalRequest({ type: 'issue-focus' }),
            });
        });
    }, [bridge.shell.shortcuts.native, bridge.shell.shortcuts.nativeAvailable, openPanel]);

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent): void => {
            const isCmdW = (event.metaKey || event.ctrlKey) && event.key === 'w';
            const isEscape = event.key === 'Escape' && !event.defaultPrevented;

            // Scope check: only intercept when focus is inside the side pane
            const paneEl = paneRef.current;
            const activeEl = document.activeElement;
            const focusInPane = paneEl != null && (paneEl === activeEl || paneEl.contains(activeEl));

            if (isCmdW) {
                // Only intercept Cmd+W when focus is inside the pane
                if (!focusInPane) return;
                event.preventDefault();
                event.stopPropagation();
                if (activePanelId) {
                    void guardedCloseActivePanel().then(closed => {
                        if (closed) requestAnimationFrame(() => {
                            const nextActive = paneEl?.querySelector<HTMLElement>('.d2-side-pane-tab-group [role="tab"][aria-selected="true"]');
                            nextActive?.focus();
                        });
                    });
                } else {
                    void onClose();
                }
            } else if (isEscape) {
                if (!focusInPane) return;
                // Close overflow dropdown first if open
                if (overflowOpen) {
                    event.preventDefault();
                    setOverflowOpen(false);
                    paneRef.current?.querySelector<HTMLButtonElement>('.d2-side-pane-overflow-trigger')?.focus();
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                if (activePanelId) {
                    void guardedCloseActivePanel().then(closed => {
                        if (closed) requestAnimationFrame(() => {
                            const nextActive = paneEl?.querySelector<HTMLElement>('.d2-side-pane-tab-group [role="tab"][aria-selected="true"]');
                            nextActive?.focus();
                        });
                    });
                } else {
                    void onClose();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [activePanelId, guardedCloseActivePanel, onClose, open, overflowOpen]);

    const toolTabs = TAB_REGISTRY.filter((tab) => tab.category === 'tool');
    const featureTabs = TAB_REGISTRY.filter((tab) => tab.category === 'feature');
    const openDescriptor = (tab: TabDescriptor): void => {
        openPanel({ type: tab.id, key: tab.id, title: tab.label, keepAlive: tab.keepAlive });
    };

    return (
        <aside ref={paneRef} className="d2-side-pane" aria-label="Side pane">
            <header className="d2-side-pane-header">
                <div className="d2-side-pane-tab-group" role="tablist" aria-label="Open side panels">
                    {inlineTabs.map((panel) => (
                        <span key={panel.id} className="d2-side-pane-pill">
                            <button
                                ref={(el) => { paneTabRefs.current.set(panel.id, el); }}
                                id={`d2-pane-tab-${panel.id}`}
                                type="button"
                                role="tab"
                                aria-selected={panel.id === activePanelId}
                                aria-controls={`d2-pane-panel-${panel.id}`}
                                tabIndex={panel.id === activePanelId ? 0 : -1}
                                onKeyDown={handlePaneTabKeyDown}
                                onClick={() => handleTabActivate(panel.id)}
                                title={panel.title}
                            >
                                {panel.title}
                            </button>
                            <button type="button" className="d2-side-pane-tab-close" onClick={() => void guardedClosePanel(panel.id)} aria-label={`Close ${panel.title}`} title={`Close ${panel.title}`}>
                                <Icon icon={X} size={10} />
                            </button>
                        </span>
                    ))}
                    {needsOverflow ? (
                        <span className="d2-side-pane-overflow-anchor">
                            <button
                                type="button"
                                className="d2-side-pane-overflow-trigger"
                                aria-expanded={overflowOpen}
                                aria-haspopup="menu"
                                onClick={() => setOverflowOpen(prev => !prev)}
                                title={`${overflowCount} more tab${overflowCount === 1 ? '' : 's'}`}
                            >
                                <span>+{overflowCount}</span>
                                <Icon icon={ChevronDown} size={12} />
                            </button>
                            {overflowOpen ? (
                                <>
                                    <div className="d2-side-pane-overflow-backdrop" onClick={() => setOverflowOpen(false)} />
                                    <OverflowPicker
                                        panels={overflowTabs}
                                        activePanelId={activePanelId}
                                        onSelect={handleOverflowSelect}
                                    />
                                </>
                            ) : null}
                        </span>
                    ) : null}
                </div>
                <span className="d2-side-pane-header-spacer" />
                <button className="d2-side-pane-header-button" type="button" onClick={showPanelPicker} aria-label="Open panel" title="Open panel"><Icon icon={Plus} size={14} /></button>
                <button className="d2-side-pane-header-button" type="button" onClick={() => void onClose()} aria-label="Close side pane" title="Close side pane"><Icon icon={X} size={14} /></button>
            </header>

            <div className="d2-side-pane-body">
                {panelOpenError ? <div className="d2-side-pane-placeholder" role="alert">{panelOpenError}</div> : null}
                {panelInstances.map((panel) => {
                    const active = open && panel.id === activePanelId;
                    return (
                        <div key={panel.id} className="d2-side-pane-tab-slot" role="tabpanel" id={`d2-pane-panel-${panel.id}`} aria-labelledby={`d2-pane-tab-${panel.id}`} data-tab={panel.type} style={{ display: active ? undefined : 'none' }} inert={!active} aria-hidden={!active}>
                            <PanelErrorBoundary panelId={panel.id} guardedClosePanel={guardedClosePanel}>
                                <TabContent
                                    panel={panel}
                                    active={active}
                                    terminalRequests={terminalRequests}
                                    consumeTerminalRequests={consumeTerminalRequests}
                                    consumeTerminalFocus={consumeTerminalFocus}
                                />
                            </PanelErrorBoundary>
                        </div>
                    );
                })}
                {activePanelId === null ? (
                    <div className="d2-side-pane-picker">
                        <h2>Open panel</h2>
                        <p>Choose a panel to open in the side pane.</p>
                        <div className="d2-side-pane-picker-section">
                            <span className="d2-side-pane-picker-label">Tools</span>
                            {toolTabs.map((tab) => <button key={tab.id} className="d2-side-pane-picker-button" type="button" onClick={() => openDescriptor(tab)} data-tab={tab.id}><Icon icon={tab.icon} size={18} /><span>{tab.label}</span></button>)}
                        </div>
                        <div className="d2-side-pane-picker-section">
                            <span className="d2-side-pane-picker-label">Features</span>
                            {featureTabs.map((tab) => <button key={tab.id} className="d2-side-pane-picker-button" type="button" onClick={() => openDescriptor(tab)} data-tab={tab.id}><Icon icon={tab.icon} size={18} /><span>{tab.label}</span></button>)}
                        </div>
                    </div>
                ) : null}
            </div>
        </aside>
    );
}
