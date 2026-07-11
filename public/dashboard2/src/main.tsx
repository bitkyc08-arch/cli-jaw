import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ManagerApiProvider } from './providers/api-provider.tsx';
import { AppScopeProvider } from './state/scope.tsx';
import { TrayRoot } from './shell/TrayRoot.tsx';
import './styles/base.css';

const trayMode = new URLSearchParams(window.location.search).get('tray') === '1';
const rootEl = document.getElementById('dashboard2-root');
if (!rootEl) throw new Error('dashboard2 root element missing');

createRoot(rootEl).render(
    trayMode ? (
        <TrayRoot />
    ) : (
        <ManagerApiProvider>
            <AppScopeProvider>
                <App />
            </AppScopeProvider>
        </ManagerApiProvider>
    ),
);
