import '../styles/base.css';
import '../styles/tokens-v4.css';
import '../styles/sidebar-v4.css';
import { createRoot, type Root } from 'react-dom/client';
import type { DashboardRegistry } from '../../../../src/manager/types.ts';
import { ManagerApiProvider } from '../providers/api-provider.tsx';
import { ManagerPreferencesProvider } from '../providers/preferences-provider.tsx';
import { ManagerSyncProvider } from '../providers/sync-provider.tsx';
import { AppScopeProvider } from '../state/scope.tsx';
import { Sidebar } from '../shell/Sidebar.tsx';

let root: Root | null = null;

const registry = {
    ui: {
        uiTheme: 'auto',
        locale: 'ko',
        dashboardShortcutsEnabled: true,
        dashboardShortcutKeymap: {},
        chatLinkPreviewsEnabled: false,
    },
} as unknown as DashboardRegistry;

const preferencesClient = {
    load: async () => ({ registry, status: {} }),
    patch: async () => ({ registry, status: {} }),
};

export function mountLifecycleConvergenceHarness(target: HTMLElement): void {
    root?.unmount();
    root = createRoot(target);
    root.render(
        <ManagerApiProvider>
            <ManagerPreferencesProvider client={preferencesClient}>
                <AppScopeProvider>
                    <ManagerSyncProvider>
                        <Sidebar />
                    </ManagerSyncProvider>
                </AppScopeProvider>
            </ManagerPreferencesProvider>
        </ManagerApiProvider>,
    );
}

export function unmountLifecycleConvergenceHarness(): void {
    root?.unmount();
    root = null;
}
