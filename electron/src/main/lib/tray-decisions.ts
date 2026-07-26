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
    kind: 'status' | 'action' | 'checkbox' | 'separator' | 'install-cli' | 'quit';
    label?: string;
    checked?: boolean;
    enabled?: boolean;
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
        { kind: 'action', label: 'Open Dashboard' },
        { kind: 'action', label: 'Copy URL' },
        { kind: 'action', label: 'Restart Server' },
        { kind: 'separator' },
        { kind: 'checkbox', label: 'Keep Running in Background', checked: input.keepRunning },
        { kind: 'checkbox', label: 'Start at Login', checked: input.startAtLogin },
        {
            kind: 'install-cli',
            label: input.cliInstalled ? 'CLI Installed ✓' : 'Install CLI to Terminal',
            enabled: input.isPackaged && !input.cliInstalled,
        },
        { kind: 'separator' },
        { kind: 'quit', label: 'Quit cli-jaw' },
    ];
}
