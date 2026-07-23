import '../styles/base.css';
import '../styles/tokens-v4.css';
import '../styles/side-pane-v4.css';
import '../styles/workbench-v4.css';
import { useEffect, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ManagerApiProvider } from '../providers/api-provider.tsx';
import { DesktopBridgeProvider } from '../providers/desktop-bridge-provider.tsx';
import { AppScopeProvider, type SidePanePanelType, useAppScope } from '../state/scope.tsx';
import { SidePane } from '../shell/SidePane.tsx';
import { getRenderCache } from '../turn-stream/render/render-cache.ts';
import { getHighlightService } from '../turn-stream/render/highlight-service.ts';

if (import.meta.env.PROD) {
    throw new Error('panel-budget-harness is dev/test-only and must not ship in production bundles');
}

export type BudgetPanelType = Extract<
    SidePanePanelType,
    'terminal' | 'browser' | 'files' | 'notes' | 'board' | 'reminders' | 'doc' | 'diff' | 'design'
>;

export interface PanelBudgetCacheCounters {
    markdown: { count: number; bytes: number };
    height: { count: number; bytes: number };
    highlight: { count: number; bytes: number; requests: number; hits: number };
    totalBytes: number;
    liveSlots: number;
}

export interface PanelBudgetHarness {
    open(type: BudgetPanelType): void;
    closeActive(): Promise<boolean>;
    activate(type: BudgetPanelType): Promise<boolean>;
    snapshot(): { activeType: BudgetPanelType | null; panelCount: number; selected: boolean };
    cacheCounters(): PanelBudgetCacheCounters;
}

const TITLES: Record<BudgetPanelType, string> = {
    terminal: 'Terminal', browser: 'Browser', files: 'Files', notes: 'Notes', board: 'Board',
    reminders: 'Reminders', doc: 'Document', diff: 'Diff', design: 'Design',
};

function payload(type: BudgetPanelType): unknown {
    const frameUrl = `${window.location.origin}/panel-budget-frame.html`;
    if (type === 'browser' || type === 'design') return { kind: 'url', url: frameUrl };
    if (type === 'doc') return { path: '/fixture/README.md', content: '# Budget fixture\n\nRetained panel measurement.' };
    if (type === 'diff') return { repoRoot: '/fixture', filePath: 'src/example.ts', mode: 'unstaged' };
    return undefined;
}

function cacheCounters(): PanelBudgetCacheCounters {
    const cache = getRenderCache();
    const service = getHighlightService();
    const markdown = cache.stats('markdown');
    const height = cache.stats('height');
    const highlight = cache.stats('highlight');
    return {
        markdown,
        height,
        highlight: { ...highlight, requests: service.metrics.requests, hits: service.metrics.cacheHits },
        totalBytes: cache.estimatedBytes(),
        liveSlots: cache.getLiveMarkdown('panel-budget') ? 1 : 0,
    };
}

function Controller(): JSX.Element {
    const scope = useAppScope();
    useEffect(() => { void scope.guardedSelectSession(4242, 'panel-budget-session'); }, [scope.guardedSelectSession]);
    useEffect(() => {
        const handle: PanelBudgetHarness = {
            open(type) {
                scope.openPanel({
                    type,
                    key: `budget:${type}`,
                    title: TITLES[type],
                    payload: payload(type),
                    keepAlive: type === 'terminal' || type === 'browser' || type === 'notes' || type === 'board',
                });
            },
            closeActive: () => scope.guardedCloseActivePanel(),
            async activate(type) {
                const panel = scope.panelInstances.find((candidate) => candidate.type === type);
                return panel ? scope.guardedActivatePanel(panel.id) : false;
            },
            snapshot: () => ({
                activeType: scope.panelInstances.find((panel) => panel.id === scope.activePanelId)?.type as BudgetPanelType | undefined ?? null,
                panelCount: scope.panelInstances.length,
                selected: scope.selected !== null,
            }),
            cacheCounters,
        };
        window.__jawPanelBudget = handle;
        return () => { delete window.__jawPanelBudget; };
    }, [scope]);
    return <main style={{ width: '640px', height: '100%', marginLeft: 'auto' }}><SidePane open onClose={() => {}} /></main>;
}

declare global {
    interface Window { __jawPanelBudget?: PanelBudgetHarness }
}

let root: Root | null = null;
export function mountPanelBudgetHarness(target: HTMLElement): void {
    window.localStorage.removeItem('d2.sidepane.v1');
    root?.unmount();
    root = createRoot(target);
    root.render(
        <ManagerApiProvider>
            <DesktopBridgeProvider>
                <AppScopeProvider>
                    <Controller />
                </AppScopeProvider>
            </DesktopBridgeProvider>
        </ManagerApiProvider>,
    );
}
