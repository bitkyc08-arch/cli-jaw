import '../styles/base.css';
import '../styles/tokens-v4.css';
import '../models/model-picker.css';
import '../features/settings/settings.css';
import { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsWorkspace } from '../features/settings/SettingsWorkspace.tsx';
import { ManagerSyncProvider } from '../providers/sync-provider.tsx';
import { ManagerPreferencesProvider } from '../providers/preferences-provider.tsx';
import { AppScopeProvider, useAppScope } from '../state/scope.tsx';

let root: Root | null = null;

function SelectedSettings() {
    const scope = useAppScope();
    useEffect(() => scope.selectSession(3506, 'wp4-settings-session'), []);
    return <SettingsWorkspace />;
}

function Harness() {
    return (
        <ManagerPreferencesProvider>
            <AppScopeProvider>
                <ManagerSyncProvider>
                    <SelectedSettings />
                </ManagerSyncProvider>
            </AppScopeProvider>
        </ManagerPreferencesProvider>
    );
}

export function mountSettingsHarness(target: HTMLElement): void {
    root?.unmount();
    root = createRoot(target);
    root.render(<Harness />);
}

export function unmountSettingsHarness(): void {
    root?.unmount();
    root = null;
}
