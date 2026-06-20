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

test('reminder popover shell uses hardened BrowserWindow options and tray URL', () => {
    const popover = read('electron/src/main/lib/reminder-popover.ts');

    assert.ok(popover.includes('export interface ReminderPopover'));
    assert.ok(popover.includes('export function createReminderPopover'));
    assert.ok(popover.includes('width: POPOVER_WIDTH'));
    assert.ok(popover.includes('height: POPOVER_HEIGHT'));
    assert.ok(popover.includes('frame: false'));
    assert.ok(popover.includes('show: false'));
    assert.ok(popover.includes('resizable: false'));
    assert.ok(popover.includes('contextIsolation: true'));
    assert.ok(popover.includes('sandbox: true'));
    assert.ok(popover.includes('nodeIntegration: false'));
    assert.ok(popover.includes('webSecurity: true'));
    assert.ok(popover.includes('allowRunningInsecureContent: false'));
    assert.ok(popover.includes("new URL('?sidebar=reminders&tray=1', opts.managerUrl)"));
});

test('reminder popover clamps to display and denies external navigation', () => {
    const popover = read('electron/src/main/lib/reminder-popover.ts');

    assert.ok(popover.includes('screen.getDisplayNearestPoint'));
    assert.ok(popover.includes('screen.getPrimaryDisplay'));
    assert.ok(popover.includes("window.webContents.on('will-navigate'"));
    assert.ok(popover.includes("window.webContents.on('will-redirect'"));
    assert.ok(popover.includes('window.webContents.setWindowOpenHandler'));
    assert.ok(popover.includes('new URL(raw).origin === opts.managerOrigin'));
    assert.ok(popover.includes("window.on('blur'"));
    assert.ok(popover.includes('target.setBounds'));
});
