import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('tray manager preserves left-click for reminders and right-click for server menu', () => {
    const trayManager = read('electron/src/main/lib/tray-manager.ts');

    assert.ok(trayManager.includes('let currentMenu: Menu | null = null'));
    assert.ok(trayManager.includes('let onTrayClick: (() => void) | null = null'));
    assert.ok(trayManager.includes("tray.on('click', () => (onTrayClick ? onTrayClick() : cb.onOpenDashboard()))"));
    assert.ok(trayManager.includes("tray.on('right-click', () => popUpTrayMenu())"));
    assert.ok(trayManager.includes('export function setTrayClickHandler'));
    assert.ok(trayManager.includes('export function popUpTrayMenu'));
    assert.ok(trayManager.includes('export function getTrayBoundsSafe'));
    assert.ok(trayManager.includes('currentMenu = menu'));
    assert.equal(trayManager.includes('tray.setContextMenu(menu)'), false);
});

test('main process wires reminder popover, typed IPC bridge, and origin guard', () => {
    const index = read('electron/src/main/index.ts');
    const preload = read('electron/src/preload/index.ts');
    const desktopBridge = read('public/manager/src/panels/desktop-bridge.ts');

    assert.match(index, /import \{ app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, screen, session, shell \} from 'electron';/);
    assert.ok(index.includes("from './lib/reminder-popover.js'"));
    assert.ok(index.includes('setTrayClickHandler'));
    assert.ok(index.includes('popUpTrayMenu'));
    assert.ok(index.includes('getTrayBoundsSafe'));
    assert.ok(index.includes("ipcMain.on('tray:popup-menu'"));
    assert.ok(index.includes('if (!isAllowedSender(event)) return;'));
    assert.ok(index.includes('installTrayReminders();'));
    assert.ok(index.includes('destroyTrayReminders();'));

    assert.ok(preload.includes('trayReminders'));
    assert.ok(preload.includes("popUpMenu: () => ipcRenderer.send('tray:popup-menu')"));
    assert.ok(desktopBridge.includes('export type TrayRemindersBridgeApi'));
    assert.ok(desktopBridge.includes('trayReminders?: TrayRemindersBridgeApi | undefined'));
});

test('main process registers and unregisters tray reminders shortcut', () => {
    const index = read('electron/src/main/index.ts');

    assert.match(index, /globalShortcut, ipcMain/);
    assert.ok(index.includes("TRAY_REMINDERS_ACCELERATOR = 'CommandOrControl+Shift+M'"));
    assert.ok(index.includes('globalShortcut.register(TRAY_REMINDERS_ACCELERATOR, toggleTrayRemindersPopover)'));
    assert.ok(index.includes("ringBuffer.append('[tray-reminders] shortcut registration failed\\n')"));
    assert.ok(index.includes('globalShortcut.unregister(TRAY_REMINDERS_ACCELERATOR)'));
    assert.ok(index.includes('setTrayClickHandler(toggleTrayRemindersPopover)'));
});
