/**
 * The tray's structural and routing decisions, extracted from tray-manager.ts
 * so they can be tested without an Electron runtime.
 *
 * tray-manager.ts imports Tray/Menu/app directly, so importing it in node
 * throws. Its decisions — what the left and right click do, how the badge
 * title reads, whether a notification shows, what the menu items are — are
 * pure, so they live here and tray-manager delegates to them.
 */

/** Left click: a custom handler if one is set, else open the dashboard. */
export function decideTrayLeftClick(hasCustomHandler: boolean): 'custom' | 'open-dashboard' {
    return hasCustomHandler ? 'custom' : 'open-dashboard';
}

/** The badge title: a space-prefixed count, or empty when there is nothing. */
export function trayBadgeTitle(count: number): string {
    return count > 0 ? ` ${count}` : '';
}

/** Whether a crash notification can show at all on this platform. */
export function decideCrashNotification(notificationSupported: boolean): 'notify' | 'skip' {
    return notificationSupported ? 'notify' : 'skip';
}

export interface TrayMenuItem {
    kind: 'status' | 'open-dashboard' | 'copy-url' | 'restart-server' | 'checkbox' | 'separator' | 'install-cli' | 'quit';
    label?: string;
    checked?: boolean;
    enabled?: boolean;
    /** Which preference a checkbox toggles, so the manager need not match by label. */
    pref?: 'keepRunning' | 'startAtLogin';
}

/**
 * The menu's shape as data. The labels and checked/enabled states are the
 * decisions; tray-manager maps these onto Electron's MenuItemConstructorOptions.
 * Keeping the shape here means a test can assert the menu's structure and the
 * checkbox states without building a real Menu.
 */
export function buildTrayMenuPlan(input: {
    serverStatus: string;
    keepRunning: boolean;
    startAtLogin: boolean;
    cliInstalled: boolean;
    isPackaged: boolean;
}): TrayMenuItem[] {
    return [
        { kind: 'status', label: input.serverStatus, enabled: false },
        { kind: 'separator' },
        { kind: 'open-dashboard', label: 'Open Dashboard' },
        { kind: 'copy-url', label: 'Copy URL' },
        { kind: 'restart-server', label: 'Restart Server' },
        { kind: 'separator' },
        { kind: 'checkbox', label: 'Keep Running in Background', checked: input.keepRunning, pref: 'keepRunning' },
        { kind: 'checkbox', label: 'Start at Login', checked: input.startAtLogin, pref: 'startAtLogin' },
        {
            kind: 'install-cli',
            label: input.cliInstalled ? 'CLI Installed ✓' : 'Install CLI to Terminal',
            enabled: input.isPackaged && !input.cliInstalled,
        },
        { kind: 'separator' },
        { kind: 'quit', label: 'Quit cli-jaw' },
    ];
}

/**
 * Maps one menu-plan item to its Electron template entry, with the side
 * effects injected so a node test can drive them. tray-manager calls this
 * with its real callbacks; the test calls it with spies. Kept here (not in
 * tray-manager) so it stays importable without the electron module.
 */
export interface TrayMenuEffects {
    onOpenDashboard: () => void;
    onCopyUrl: () => void;
    onRestartServer: () => void;
    onQuit: () => void;
    onToggleKeepRunning: (checked: boolean) => void;
    onToggleStartAtLogin: (checked: boolean) => void;
    onInstallCli: () => Promise<void>;
}

export function mapTrayMenuItem(item: TrayMenuItem, fx: TrayMenuEffects): Record<string, unknown> {
    switch (item.kind) {
        case 'status': return { label: item.label, enabled: false };
        case 'separator': return { type: 'separator' };
        case 'checkbox': return {
            label: item.label, type: 'checkbox', checked: item.checked,
            click: (mi: { checked: boolean }) => {
                if (item.pref === 'keepRunning') fx.onToggleKeepRunning(mi.checked);
                else if (item.pref === 'startAtLogin') fx.onToggleStartAtLogin(mi.checked);
            },
        };
        case 'install-cli': return { label: item.label, enabled: item.enabled, click: fx.onInstallCli };
        case 'quit': return { label: item.label, click: fx.onQuit };
        case 'open-dashboard': return { label: item.label, click: fx.onOpenDashboard };
        case 'copy-url': return { label: item.label, click: fx.onCopyUrl };
        case 'restart-server': return { label: item.label, click: fx.onRestartServer };
        default: return { label: item.label };
    }
}
