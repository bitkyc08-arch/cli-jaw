import { useCallback, useEffect, useState } from 'react';
import { sendInstanceMessage } from '../api';
import { usePanelLayout } from '../panels/PanelLayoutProvider';
import { getDesktop } from '../panels/desktop-bridge';
import type { RightSidebarOpenTab } from '../panels/types';
import { createDesignPage, createDesignSnapshot, DesignApiUnavailableError, designPreviewUrl, exportDesignPage, fetchDesignStoreVersion, getDesignLocalPaths, listDesignPages } from './design-api';
import type { DesignPageSummary } from './design-types';
import { DesignPageSelector } from './DesignPageSelector';
import { DesignViewport } from './DesignViewport';
import './design-panel.css';

type DesignPanelProps = {
    tab: RightSidebarOpenTab;
    /** Selected instance's primary projectDir at render time (OD-2 snapshot source). */
    primaryProjectDir: string | null;
    /** Run enqueues a design-run prompt into the CURRENTLY selected instance (OD-1). */
    selectedInstancePort?: number | null | undefined;
    /** Opens the sandboxed preview in a new Browser module tab (186 Phase 5 handoff). */
    onOpenInBrowser?: ((url: string) => void) | undefined;
};

type StoreState =
    | { kind: 'loading' }
    | { kind: 'unavailable' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; pages: DesignPageSummary[] };

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5];

/**
 * Design module tab body (186 Phase 1): one toolbar row + full-viewport
 * sandboxed preview. No inner tabs, no composer — multiple design surfaces
 * are multiple outer Design module tabs. Per-tab state (pageId, projectKey
 * snapshot, zoom) lives in tab metadata so it survives tab switches and
 * restarts (only the active tab body mounts).
 */
export function DesignPanel(props: DesignPanelProps) {
    const { dispatch } = usePanelLayout();
    const tabId = props.tab.id;
    const design = props.tab.design ?? {};
    const zoom = design.zoom && design.zoom > 0 ? design.zoom : 1;
    const [store, setStore] = useState<StoreState>({ kind: 'loading' });
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [newTitle, setNewTitle] = useState('');

    // OD-2: freeze the bound project key at tab create. applyDesignTabState
    // only fills projectKey when absent, so later instance switches never
    // retarget an existing tab.
    useEffect(() => {
        if (design.projectKey === undefined || design.projectKey === null) {
            dispatch({ type: 'SET_DESIGN_TAB_STATE', tabId, patch: { projectKey: props.primaryProjectDir } });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const projectKey = design.projectKey ?? props.primaryProjectDir ?? null;

    const reload = useCallback(async () => {
        setStore({ kind: 'loading' });
        try {
            const pages = await listDesignPages(projectKey);
            setStore({ kind: 'ready', pages });
        } catch (error) {
            if (error instanceof DesignApiUnavailableError) setStore({ kind: 'unavailable' });
            else setStore({ kind: 'error', message: (error as Error).message });
        }
    }, [projectKey]);

    useEffect(() => {
        void reload();
    }, [reload]);

    // Auto-refresh: the design store bumps a version on any page write (agent
    // direct writes included). Poll it while the panel is mounted; a change
    // reloads the list, and the preview URL's ?rev cache-bust follows the new
    // revision automatically.
    useEffect(() => {
        let disposed = false;
        let lastVersion = -1;
        const interval = window.setInterval(() => {
            void fetchDesignStoreVersion().then(version => {
                if (disposed) return;
                if (lastVersion !== -1 && version !== lastVersion) void reload();
                lastVersion = version;
            }).catch(() => { /* store unavailable; Reload stays manual */ });
        }, 3000);
        return () => {
            disposed = true;
            window.clearInterval(interval);
        };
    }, [reload]);

    const handleCreate = useCallback(() => {
        const title = newTitle.trim();
        if (!title) return;
        setStatusMessage('Creating page...');
        void createDesignPage({ title, projectKey })
            .then(page => {
                setCreating(false);
                setNewTitle('');
                setStatusMessage(`Created ${page.title}`);
                dispatch({ type: 'SET_DESIGN_TAB_STATE', tabId, patch: { pageId: page.id } });
                return reload();
            })
            .catch(error => setStatusMessage((error as Error).message));
    }, [dispatch, newTitle, projectKey, reload, tabId]);

    const pages = store.kind === 'ready' ? store.pages : [];
    const selectedPage = pages.find(page => page.id === design.pageId) ?? pages[0] ?? null;

    // Keep the persisted pageId aligned with what is actually shown.
    useEffect(() => {
        const shownId = selectedPage?.id ?? null;
        if (store.kind === 'ready' && shownId !== (design.pageId ?? null)) {
            dispatch({ type: 'SET_DESIGN_TAB_STATE', tabId, patch: { pageId: shownId } });
        }
    }, [design.pageId, dispatch, selectedPage?.id, store.kind, tabId]);

    // Tab label follows the selected page title (OD-4), falling back to the
    // ordinal default which the reducer already provides.
    useEffect(() => {
        if (selectedPage) {
            dispatch({ type: 'SET_RIGHT_SIDEBAR_TAB_META', tabId, patch: { specificName: selectedPage.title, sourceLabel: selectedPage.id } });
        }
    }, [dispatch, selectedPage, tabId]);

    const handleSelect = useCallback((pageId: string | null) => {
        dispatch({ type: 'SET_DESIGN_TAB_STATE', tabId, patch: { pageId } });
    }, [dispatch, tabId]);

    // OD-1: Run = enqueue the generation request into the selected instance.
    // The panel stays a viewer; the instance's agent edits artifact.html via
    // the file-first store (jaw design CLI / direct writes) and Reload/rescan
    // picks the result up.
    const handleRun = useCallback(() => {
        if (!selectedPage) return;
        if (props.selectedInstancePort == null) {
            setStatusMessage('Select an instance before running a design generation.');
            return;
        }
        setStatusMessage('Queueing design run...');
        // Guardrail: a before-snapshot is a hard gate on run start — taken
        // server-side, not merely requested from the agent.
        void createDesignSnapshot(selectedPage.id, 'before')
            .then(() => getDesignLocalPaths(selectedPage.id))
            .then(paths => sendInstanceMessage(props.selectedInstancePort!, [
                'Design run request',
                '',
                `Page: ${selectedPage.title} (${selectedPage.id})`,
                `Page directory (your ONLY write target for this run): ${paths.pageDir}`,
                `Artifact: ${paths.artifactPath}`,
                `Brief: ${paths.promptPath} — read it first; it holds the page requirements.`,
                '',
                'Update artifact.html in place (direct file write or `jaw design files ... write --stdin`).',
                'Write allowlist inside the page directory: artifact.html, prompt.md, page.json, assets/*.',
                "Preview is CSP-locked (script-src 'none'): produce STATIC self-contained HTML/CSS — no <script>, no external CDN references; inline styles/SVG only.",
                'A before-snapshot was already taken; restore points live under the page snapshots/ directory.',
                'Do not write anywhere else; the user reviews the result live in the Manager Design tab.',
                'If the design skill is active, follow its "Design run request" agent contract.',
            ].join('\n')))
            .then(result => {
                setStatusMessage(result.ok
                    ? `Design run queued on instance ${props.selectedInstancePort}.`
                    : `Run enqueue failed (${result.status}).`);
            })
            .catch(error => setStatusMessage((error as Error).message));
    }, [props.selectedInstancePort, selectedPage]);

    const handleOpenInBrowser = useCallback(() => {
        if (!selectedPage || !props.onOpenInBrowser) return;
        props.onOpenInBrowser(`${window.location.origin}${designPreviewUrl(selectedPage.id, selectedPage.revision)}`);
    }, [props, selectedPage]);

    const handleReveal = useCallback(() => {
        if (!selectedPage) return;
        void getDesignLocalPaths(selectedPage.id)
            .then(paths => getDesktop()?.folder?.revealPath?.(paths.pageDir))
            .catch(error => setStatusMessage((error as Error).message));
    }, [selectedPage]);

    const handleExport = useCallback(() => {
        if (!selectedPage) return;
        setStatusMessage('Exporting...');
        void exportDesignPage(selectedPage.id)
            .then(result => {
                setStatusMessage(`Exported to ${result.exportedTo}`);
                // 186 Phase 5 handoff: surface the change in the Diff tab.
                dispatch({ type: 'FOCUS_OR_CREATE_FIRST_RIGHT_SIDEBAR_TAB', kind: 'diff' });
            })
            .catch(error => setStatusMessage((error as Error).message));
    }, [dispatch, selectedPage]);

    const handleZoomCycle = useCallback(() => {
        const index = ZOOM_STEPS.indexOf(zoom);
        const next = ZOOM_STEPS[(index + 1) % ZOOM_STEPS.length] ?? 1;
        dispatch({ type: 'SET_DESIGN_TAB_STATE', tabId, patch: { zoom: next } });
    }, [dispatch, tabId, zoom]);

    const previewUrl = selectedPage ? designPreviewUrl(selectedPage.id, selectedPage.revision) : null;
    const emptyMessage = store.kind === 'loading' ? 'Loading design pages...'
        : store.kind === 'unavailable' ? 'Design store unavailable — update and restart the manager server (Phase 2 backend).'
        : store.kind === 'error' ? `Design store error: ${store.message}`
        : 'No design pages yet. Create one with `jaw design create` or an agent run.';

    return (
        <div className="design-panel">
            <div className="design-toolbar">
                <div className="design-toolbar-group">
                    <button type="button" className="design-toolbar-btn" title="Reveal page directory" aria-label="Reveal page directory" disabled={!selectedPage} onClick={handleReveal}>
                        Reveal
                    </button>
                    <button type="button" className="design-toolbar-btn" title="Export to project" aria-label="Export to project" disabled={!selectedPage} onClick={handleExport}>
                        Export
                    </button>
                    <button type="button" className="design-toolbar-btn" title="Reload from disk" aria-label="Reload from disk" onClick={() => void reload()}>
                        Reload
                    </button>
                </div>
                <DesignPageSelector
                    pages={pages}
                    selectedPageId={selectedPage?.id ?? null}
                    disabled={store.kind !== 'ready'}
                    onSelect={handleSelect}
                />
                <button type="button" className="design-toolbar-btn" title="New design page" aria-label="New design page" disabled={store.kind !== 'ready'} onClick={() => setCreating(v => !v)}>
                    +
                </button>
                <div className="design-toolbar-group">
                    <button type="button" className="design-toolbar-btn" title="Cycle zoom" aria-label={`Zoom ${Math.round(zoom * 100)}%`} onClick={handleZoomCycle}>
                        {Math.round(zoom * 100)}%
                    </button>
                    <button type="button" className="design-toolbar-btn" title="Run: queue a design generation on the selected instance" aria-label="Run design generation" disabled={!selectedPage} onClick={handleRun}>
                        Run
                    </button>
                    <button type="button" className="design-toolbar-btn" title="Open preview in a Browser tab" aria-label="Open in Browser" disabled={!selectedPage || !props.onOpenInBrowser} onClick={handleOpenInBrowser}>
                        Browser
                    </button>
                </div>
            </div>
            {creating && (
                <div className="design-create-row">
                    <input
                        className="design-create-input"
                        type="text"
                        value={newTitle}
                        placeholder="New page title..."
                        aria-label="New page title"
                        onChange={event => setNewTitle(event.target.value)}
                        onKeyDown={event => { if (event.key === 'Enter') handleCreate(); if (event.key === 'Escape') setCreating(false); }}
                    />
                    <button type="button" className="design-toolbar-btn" disabled={!newTitle.trim()} onClick={handleCreate}>Create</button>
                    <button type="button" className="design-toolbar-btn" onClick={() => setCreating(false)}>Cancel</button>
                </div>
            )}
            {statusMessage && (
                <div className="design-status" role="status">
                    <span className="design-status-text">{statusMessage}</span>
                    <button type="button" className="design-status-dismiss" aria-label="Dismiss" onClick={() => setStatusMessage(null)}>×</button>
                </div>
            )}
            <DesignViewport previewUrl={previewUrl} zoom={zoom} emptyMessage={emptyMessage} />
        </div>
    );
}
