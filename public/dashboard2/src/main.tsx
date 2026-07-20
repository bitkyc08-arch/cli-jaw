// CSS boot order contract (B-008 §7 + 049): token/style sheets load BEFORE the
// component tree so component-level css (composer.css, pending css) layers on
// top of tokens. tokens-v4.css is the sole token source.
// Import order == injection order in vite.
import './styles/base.css';
import './styles/tokens-v4.css';
import './styles/sidebar-v4.css';
import './styles/workbench-v4.css';
import './styles/turn-stream.css';
import './styles/render-content.css';
import './models/model-picker.css';
import './features/hover-dock/hover-dock.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ManagerApiProvider } from './providers/api-provider.tsx';
import { DesktopBridgeProvider } from './providers/desktop-bridge-provider.tsx';
import { ManagerPreferencesProvider } from './providers/preferences-provider.tsx';
import { ManagerShortcutProvider } from './providers/shortcut-provider.tsx';
import { ManagerSyncProvider } from './providers/sync-provider.tsx';
import { AppScopeProvider } from './state/scope.tsx';
import { TrayRoot } from './shell/TrayRoot.tsx';

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
