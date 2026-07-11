import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ManagerApiProvider } from './providers/api-provider.tsx';
import { DesktopBridgeProvider } from './providers/desktop-bridge-provider.tsx';
import { ManagerPreferencesProvider } from './providers/preferences-provider.tsx';
import { ManagerShortcutProvider } from './providers/shortcut-provider.tsx';
import { ManagerSyncProvider } from './providers/sync-provider.tsx';
import { AppScopeProvider } from './state/scope.tsx';
import { TrayRoot } from './shell/TrayRoot.tsx';
import './styles/base.css';

const trayMode = new URLSearchParams(window.location.search).get('tray') === '1';
const rootEl = document.getElementById('dashboard2-root');
if (!rootEl) throw new Error('dashboard2 root element missing');

// Provider stack (032, audited order): Api > Preferences > DesktopBridge >
// Shortcut > AppScope > Sync. Sync mounts exactly once per app lifetime and
// is intentionally absent from the tray branch.
createRoot(rootEl).render(
    trayMode ? (
        <TrayRoot />
    ) : (
        <ManagerApiProvider>
            <ManagerPreferencesProvider>
                <DesktopBridgeProvider>
                    <ManagerShortcutProvider>
                        <AppScopeProvider>
                            <ManagerSyncProvider>
                                <App />
                            </ManagerSyncProvider>
                        </AppScopeProvider>
                    </ManagerShortcutProvider>
                </DesktopBridgeProvider>
            </ManagerPreferencesProvider>
        </ManagerApiProvider>
    ),
);
