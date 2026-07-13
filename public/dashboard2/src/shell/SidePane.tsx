// 075 — SidePane with tab-registry, keep-alive, and 7-tab support
import { Bell, Calendar, ClipboardList, Code, File, Globe, NotebookPen, Plus, Terminal, X } from '@lucide/icons';
import { Suspense, lazy, useEffect, type JSX } from 'react';
import { useAppScope, type SidePaneTab } from '../state/scope.tsx';
import { Icon } from './Icon.tsx';
import { BrowserPanel } from './panels/BrowserPanel.tsx';
import { FileTreePanel } from './panels/FileTreePanel.tsx';
import { TerminalPanel } from './panels/TerminalPanel.tsx';

// Lazy boundaries — these chunks load only when first selected
const LazyCodeTab = lazy(() => import('../code/index.ts'));
const LazyNotesPanel = lazy(() => import('../features/notes/NotesPanel.tsx').then((m) => ({ default: m.NotesPanel })));
const LazyBoardPanel = lazy(() => import('../features/board/BoardPanel.tsx').then((m) => ({ default: m.BoardPanel })));
const LazyRemindersPanel = lazy(() => import('../features/reminders/RemindersPanel.tsx').then((m) => ({ default: m.RemindersPanel })));

// ── Tab Registry ──────────────────────────────────────────────────────
// Declarative config for all SidePane tabs. `keepAlive` tabs stay mounted
// (display:none) when inactive; others unmount on tab switch.

interface TabDescriptor {
    id: SidePaneTab;
    label: string;
    icon: typeof Terminal;
    placeholder: string;
    /** Category for picker grouping */
    category: 'tool' | 'feature';
    /** Keep-alive: render hidden instead of unmounting */
    keepAlive: boolean;
    /** Requires a selected session to render content */
    needsSession: boolean;
}

const TAB_REGISTRY: TabDescriptor[] = [
    { id: 'terminal', label: 'Terminal', icon: Terminal, placeholder: 'Terminal output will appear here', category: 'tool', keepAlive: false, needsSession: true },
    { id: 'browser', label: 'Browser', icon: Globe, placeholder: 'Browser will appear here', category: 'tool', keepAlive: false, needsSession: false },
    { id: 'files', label: 'Files', icon: File, placeholder: 'Files will appear here', category: 'tool', keepAlive: false, needsSession: false },
    { id: 'code', label: 'Code', icon: Code, placeholder: 'Code conversation will appear here', category: 'tool', keepAlive: false, needsSession: true },
    { id: 'notes', label: 'Notes', icon: NotebookPen, placeholder: 'Notes will appear here', category: 'feature', keepAlive: true, needsSession: true },
    { id: 'board', label: 'Board', icon: ClipboardList, placeholder: 'Board will appear here', category: 'feature', keepAlive: true, needsSession: true },
    { id: 'reminders', label: 'Reminders', icon: Bell, placeholder: 'Reminders will appear here', category: 'feature', keepAlive: false, needsSession: true },
];

const TAB_MAP = new Map(TAB_REGISTRY.map((t) => [t.id, t]));

// ── Tab Content Renderer ──────────────────────────────────────────────

function TabContent({ tabId, active }: { tabId: SidePaneTab; active: boolean }): JSX.Element | null {
    const { selected } = useAppScope();
    const desc = TAB_MAP.get(tabId);
    if (!desc) return null;

    // Session guard for tabs that need one
    if (desc.needsSession && !selected) {
        return active ? (
            <div className="d2-side-pane-placeholder" data-tab={tabId}>
                <Icon icon={desc.icon} size={36} />
                <span>Select a session first</span>
            </div>
        ) : null;
    }

    const port = selected?.port ?? null;

    switch (tabId) {
        case 'terminal':
            return <TerminalPanel port={port} />;
        case 'browser':
            return <BrowserPanel />;
        case 'files':
            return <FileTreePanel />;
        case 'code':
            return (
                <Suspense fallback={<div className="d2-side-pane-placeholder" data-tab="code"><Icon icon={Code} size={36} /><span>Loading Code...</span></div>}>
                    <LazyCodeTab port={port!} />
                </Suspense>
            );
        case 'notes':
            return (
                <Suspense fallback={<div className="d2-side-pane-placeholder" data-tab="notes"><Icon icon={NotebookPen} size={36} /><span>Loading Notes...</span></div>}>
                    <LazyNotesPanel active={active} />
                </Suspense>
            );
        case 'board':
            return (
                <Suspense fallback={<div className="d2-side-pane-placeholder" data-tab="board"><Icon icon={ClipboardList} size={36} /><span>Loading Board...</span></div>}>
                    <LazyBoardPanel active={active} />
                </Suspense>
            );
        case 'reminders':
            return (
                <Suspense fallback={<div className="d2-side-pane-placeholder" data-tab="reminders"><Icon icon={Bell} size={36} /><span>Loading Reminders...</span></div>}>
                    <LazyRemindersPanel active={active} />
                </Suspense>
            );
    }
}

// ── SidePane ──────────────────────────────────────────────────────────

interface SidePaneProps {
    onClose(): void;
}

export function SidePane({ onClose }: SidePaneProps): JSX.Element {
    const { activeSidePaneTab, mountedTabs, setActiveSidePaneTab } = useAppScope();
    const activeDescriptor = activeSidePaneTab ? TAB_MAP.get(activeSidePaneTab) ?? null : null;

   // Cmd+W / Ctrl+W or Escape closes the active tab, or the entire pane if no tab is active
   useEffect(() => {
       const handleKeyDown = (e: KeyboardEvent): void => {
            const isCmdW = (e.metaKey || e.ctrlKey) && e.key === 'w';
            // Escape only when focus is inside the side pane (avoid conflict with composer menus)
            const isEscape = e.key === 'Escape' && !e.defaultPrevented
                && document.querySelector('.d2-side-pane')?.contains(document.activeElement);
            if (isCmdW || isEscape) {
                e.preventDefault();
                e.stopPropagation();
                if (activeSidePaneTab) {
                    setActiveSidePaneTab(null);
                } else {
                    onClose();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [activeSidePaneTab, onClose, setActiveSidePaneTab]);

    // ── Keep-alive rendering ──────────────────────────────────────────
    // Tabs marked keepAlive=true stay mounted (hidden) once activated.
    // Non-keepAlive tabs render only when active.
    const renderTabs = (): JSX.Element[] => {
        const elements: JSX.Element[] = [];
        for (const desc of TAB_REGISTRY) {
            const isActive = activeSidePaneTab === desc.id;
            if (desc.keepAlive) {
                // Keep-alive: render if ever mounted, hide if not active
                if (mountedTabs.has(desc.id)) {
                    elements.push(
                        <div
                            key={desc.id}
                            className="d2-side-pane-tab-slot"
                            data-tab={desc.id}
                            style={{ display: isActive ? undefined : 'none' }}
                            aria-hidden={!isActive}
                        >
                            <TabContent tabId={desc.id} active={isActive} />
                        </div>,
                    );
                }
            } else if (isActive) {
                // Non-keepAlive: render only when active
                elements.push(
                    <div key={desc.id} className="d2-side-pane-tab-slot" data-tab={desc.id}>
                        <TabContent tabId={desc.id} active={true} />
                    </div>,
                );
            }
        }
        return elements;
    };

    // ── Picker (no active tab) ────────────────────────────────────────
    const toolTabs = TAB_REGISTRY.filter((t) => t.category === 'tool');
    const featureTabs = TAB_REGISTRY.filter((t) => t.category === 'feature');

    return (
        <aside className="d2-side-pane" aria-label="Side pane">
            <header className="d2-side-pane-header">
                {activeDescriptor ? (
                    <div className="d2-side-pane-tab-group">
                        <button
                            className="d2-side-pane-pill"
                            type="button"
                            onClick={() => setActiveSidePaneTab(null)}
                            aria-label="Choose another tab"
                            title="Choose another tab"
                        >
                            <Icon icon={activeDescriptor.icon} size={14} />
                            <span>{activeDescriptor.label}</span>
                        </button>
                        <span
                            className="d2-side-pane-tab-close"
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); setActiveSidePaneTab(null); }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setActiveSidePaneTab(null); } }}
                            aria-label={`Close ${activeDescriptor.label}`}
                            title={`Close ${activeDescriptor.label}`}
                        >
                            <Icon icon={X} size={10} />
                        </span>
                    </div>
                ) : null}
                <span className="d2-side-pane-header-spacer" />
                <button
                    className="d2-side-pane-header-button"
                    type="button"
                    onClick={() => setActiveSidePaneTab(null)}
                    aria-label="Open tab"
                    title="Open tab"
                >
                    <Icon icon={Plus} size={14} />
                </button>
                <button
                    className="d2-side-pane-header-button"
                    type="button"
                    onClick={onClose}
                    aria-label="Close side pane"
                    title="Close side pane"
                >
                    <Icon icon={X} size={14} />
                </button>
            </header>

            <div className="d2-side-pane-body">
                {activeSidePaneTab !== null ? (
                    renderTabs()
                ) : (
                    <div className="d2-side-pane-picker">
                        <h2>Open tab</h2>
                        <p>Choose a tab to open in the side pane.</p>
                        <div className="d2-side-pane-picker-section">
                            <span className="d2-side-pane-picker-label">Tools</span>
                            {toolTabs.map((tab) => (
                                <button
                                    key={tab.id}
                                    className="d2-side-pane-picker-button"
                                    type="button"
                                    onClick={() => setActiveSidePaneTab(tab.id)}
                                    data-tab={tab.id}
                                >
                                    <Icon icon={tab.icon} size={18} />
                                    <span>{tab.label}</span>
                                </button>
                            ))}
                        </div>
                        <div className="d2-side-pane-picker-section">
                            <span className="d2-side-pane-picker-label">Features</span>
                            {featureTabs.map((tab) => (
                                <button
                                    key={tab.id}
                                    className="d2-side-pane-picker-button"
                                    type="button"
                                    onClick={() => setActiveSidePaneTab(tab.id)}
                                    data-tab={tab.id}
                                >
                                    <Icon icon={tab.icon} size={18} />
                                    <span>{tab.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </aside>
    );
}
