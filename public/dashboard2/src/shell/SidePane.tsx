// 089.04 — instance-based SidePane with explicit-close lifecycle.
import { Bell, ClipboardList, Code, File, FileText, Globe, NotebookPen, Plus, Terminal, Users, X } from '@lucide/icons';
import { Suspense, lazy, useCallback, useEffect, useReducer, useRef, useState, type JSX } from 'react';
import { useManagerApi } from '../providers/api-provider.tsx';
import { useDesktopBridge } from '../providers/desktop-bridge-provider.tsx';
import {
    useAppScope,
    type SidePanePanelInstance,
    type SidePanePanelType,
} from '../state/scope.tsx';
import { Icon } from './Icon.tsx';
import { BrowserPanel } from './panels/BrowserPanel.tsx';
import { FileTreePanel } from './panels/FileTreePanel.tsx';
import { TerminalPanel } from './panels/TerminalPanel.tsx';
import {
    initialTerminalRequestLedger,
    terminalRequestLedgerReducer,
    type TerminalRequestLedger,
} from './panels/terminal-session-requests.ts';
import type { TerminalTarget } from './panels/terminal-session-state.ts';

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

type DocPayload = { path?: string; content?: string; truncated?: boolean; binary?: boolean };
type DesignPayload = { url?: string };

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
}

function TabContent({ panel, active, terminalRequests, consumeTerminalRequests }: TabContentProps): JSX.Element | null {
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
            const payload: DesignPayload = typeof raw['url'] === 'string' ? { url: raw['url'] } : {};
            return <Suspense fallback={<div className="d2-side-pane-placeholder">Loading design...</div>}><LazyDesignPanel active={active} url={payload.url} /></Suspense>;
        }
        case 'diff': {
            const raw = payloadObject(panel.payload);
            const payload = {
                ...(typeof raw['repoRoot'] === 'string' ? { repoRoot: raw['repoRoot'] } : {}),
                ...(typeof raw['filePath'] === 'string' ? { filePath: raw['filePath'] } : {}),
                ...(raw['mode'] === 'staged' || raw['mode'] === 'unstaged' ? { mode: raw['mode'] } : {}),
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

interface SidePaneProps {
    open: boolean;
    onClose(): void;
}

export function SidePane({ open, onClose }: SidePaneProps): JSX.Element {
    const bridge = useDesktopBridge();
    const {
        panelInstances,
        activePanelId,
        panelOpenError,
        openPanel,
        activatePanel,
        closePanel,
        closeActivePanel,
        showPanelPicker,
    } = useAppScope();
    const [terminalRequests, dispatchTerminalRequest] = useReducer(
        terminalRequestLedgerReducer,
        initialTerminalRequestLedger,
    );
    const consumeTerminalRequests = useCallback((token: number) => {
        dispatchTerminalRequest({ type: 'consume-through', token });
    }, []);

    useEffect(() => {
        const shortcuts = bridge.shell.shortcuts.nativeAvailable ? bridge.shell.shortcuts.native : null;
        if (!shortcuts) return;
        return shortcuts.onAction((action) => {
            if (action !== 'terminalNewTab') return;
            dispatchTerminalRequest({ type: 'issue' });
            openPanel({ type: 'terminal', key: 'terminal', title: 'Terminal', keepAlive: true });
        });
    }, [bridge.shell.shortcuts.native, bridge.shell.shortcuts.nativeAvailable, openPanel]);

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent): void => {
            const isCmdW = (event.metaKey || event.ctrlKey) && event.key === 'w';
            const isEscape = event.key === 'Escape' && !event.defaultPrevented
                && document.querySelector('.d2-side-pane')?.contains(document.activeElement);
            if (!isCmdW && !isEscape) return;
            event.preventDefault();
            event.stopPropagation();
            if (activePanelId) closeActivePanel();
            else onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [activePanelId, closeActivePanel, onClose, open]);

    const toolTabs = TAB_REGISTRY.filter((tab) => tab.category === 'tool');
    const featureTabs = TAB_REGISTRY.filter((tab) => tab.category === 'feature');
    const openDescriptor = (tab: TabDescriptor): void => {
        openPanel({ type: tab.id, key: tab.id, title: tab.label, keepAlive: tab.keepAlive });
    };

    return (
        <aside className="d2-side-pane" aria-label="Side pane">
            <header className="d2-side-pane-header">
                <div className="d2-side-pane-tab-group" role="tablist" aria-label="Open side panels">
                    {panelInstances.map((panel) => (
                        <span key={panel.id} className="d2-side-pane-pill">
                            <button type="button" role="tab" aria-selected={panel.id === activePanelId} onClick={() => activatePanel(panel.id)} title={panel.title}>
                                {panel.title}
                            </button>
                            <button type="button" className="d2-side-pane-tab-close" onClick={() => closePanel(panel.id)} aria-label={`Close ${panel.title}`} title={`Close ${panel.title}`}>
                                <Icon icon={X} size={10} />
                            </button>
                        </span>
                    ))}
                </div>
                <span className="d2-side-pane-header-spacer" />
                <button className="d2-side-pane-header-button" type="button" onClick={showPanelPicker} aria-label="Open panel" title="Open panel"><Icon icon={Plus} size={14} /></button>
                <button className="d2-side-pane-header-button" type="button" onClick={onClose} aria-label="Close side pane" title="Close side pane"><Icon icon={X} size={14} /></button>
            </header>

            <div className="d2-side-pane-body">
                {panelOpenError ? <div className="d2-side-pane-placeholder" role="alert">{panelOpenError}</div> : null}
                {panelInstances.map((panel) => {
                    const active = open && panel.id === activePanelId;
                    return (
                        <div key={panel.id} className="d2-side-pane-tab-slot" data-tab={panel.type} style={{ display: active ? undefined : 'none' }} inert={!active} aria-hidden={!active}>
                            <TabContent
                                panel={panel}
                                active={active}
                                terminalRequests={terminalRequests}
                                consumeTerminalRequests={consumeTerminalRequests}
                            />
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
