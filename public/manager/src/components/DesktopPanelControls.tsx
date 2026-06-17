import { usePanelActions, usePanelLayout } from '../panels/PanelLayoutProvider';
import { currentManagerSurface, panelCapabilityEnabled, resolvePanelCapabilities } from '../panels/panel-capabilities';

function TerminalIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="3" y="4" width="14" height="12" rx="1.5" />
            <path d="M6 9l3 2-3 2" />
            <path d="M11 13h3" />
        </svg>
    );
}

function PanelRightIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="3" y="4" width="14" height="12" rx="1.5" />
            <path d="M13 4v12" />
        </svg>
    );
}

export function DesktopPanelControls() {
    const panelLayout = usePanelLayout();
    const panelActions = usePanelActions();
    const surface = currentManagerSurface();

    if (surface !== 'electron') return null;

    const capabilities = resolvePanelCapabilities(surface);
    const terminalCapability = capabilities.terminal;
    const rightCapability = capabilities.folder;
    const terminalEnabled = panelCapabilityEnabled(terminalCapability);
    const rightEnabled = panelCapabilityEnabled(rightCapability);

    const bottomOpen = panelLayout.state.bottomPanel.open;
    const rightOpen = panelLayout.effectiveRightOpen;

    return (
        <div className="command-panel-controls" aria-label="Desktop panels">
            <button
                className={`command-panel-toggle${bottomOpen ? ' is-active' : ''}`}
                type="button"
                disabled={!terminalEnabled}
                onClick={() => {
                    if (!terminalEnabled) return;
                    if (bottomOpen) {
                        panelActions.toggleBottomPanel();
                    } else {
                        panelActions.openBottomTab('terminal');
                    }
                }}
                aria-label="Toggle terminal panel"
                aria-pressed={bottomOpen}
                title={terminalCapability.reason ?? 'Terminal (Ctrl+`)'}
            >
                <TerminalIcon />
            </button>
            <button
                className={`command-panel-toggle${rightOpen ? ' is-active' : ''}`}
                type="button"
                disabled={!rightEnabled}
                onClick={() => {
                    if (!rightEnabled) return;
                    if (rightOpen) {
                        panelActions.toggleRightPanel();
                    } else {
                        panelActions.openRightPanel('folder');
                    }
                }}
                aria-label="Toggle right panel"
                aria-pressed={rightOpen}
                title={rightCapability.reason ?? 'Side panel (Command+B)'}
            >
                <PanelRightIcon />
            </button>
        </div>
    );
}
