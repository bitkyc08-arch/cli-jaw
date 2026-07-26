// wp7b — the IPC trust boundary: every dangerous channel requires the Manager
// window's own webContents, not just its origin.
//
// DEFECT-E: the tray reminders popover shares the Manager origin AND used to
// share its preload, so an origin-only check let the popover's renderer call
// all 35 origin-guarded channels (folder writes, git ops, terminal spawn).
// These are now promoted to isManagerSender, and the guard is driven here with
// a popover sender to prove the denial.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    isAllowedSender,
    isManagerSender,
    setAllowedOrigin,
    setManagerWindowIdGetter,
} from '../../electron/src/main/lib/ipc-origin-guard.ts';

const ORIGIN = 'http://127.0.0.1:24578';
const MANAGER_ID = 17;
const POPOVER_ID = 99;

function event(originUrl: string, senderId: number) {
    return { senderFrame: { url: originUrl }, sender: { id: senderId } } as never;
}

setAllowedOrigin(ORIGIN);
setManagerWindowIdGetter(() => MANAGER_ID);

test('isAllowedSender accepts the manager origin, rejects any other', () => {
    assert.equal(isAllowedSender(event(`${ORIGIN}/dashboard2/`, MANAGER_ID)), true);
    assert.equal(isAllowedSender(event('https://evil.example/', MANAGER_ID)), false);
    assert.equal(isAllowedSender(event('about:blank', MANAGER_ID)), false);
});

test('isManagerSender accepts the manager webContents, rejects the popover even at the same origin', () => {
    // Same origin as the manager, but a DIFFERENT webContents — the popover.
    assert.equal(isManagerSender(event(`${ORIGIN}/?sidebar=reminders&tray=1`, POPOVER_ID)), false);
    assert.equal(isManagerSender(event(`${ORIGIN}/dashboard2/`, MANAGER_ID)), true);
});

test('isManagerSender rejects when the manager window is gone', () => {
    setManagerWindowIdGetter(() => null);
    assert.equal(isManagerSender(event(`${ORIGIN}/dashboard2/`, MANAGER_ID)), false);
    setManagerWindowIdGetter(() => MANAGER_ID);
});

// The channel×guard matrix: every dangerous channel must route through
// isManagerSender, and only the two tray-reminder channels (which the popover
// legitimately calls) may stay origin-guarded.
const DOMAINS = [
    'electron/src/main/lib/folder/ipc.ts',
    'electron/src/main/lib/git/ipc.ts',
    'electron/src/main/lib/terminal/index.ts',
    'electron/src/main/lib/window/ipc.ts',
    'electron/src/main/lib/clipboard/ipc.ts',
    'electron/src/main/lib/permission-diagnostics/ipc.ts',
];

test('all 34 dangerous channels use isManagerSender, none uses origin-only', () => {
    const root = resolve(import.meta.dirname, '..', '..');
    let guarded = 0;
    for (const file of DOMAINS) {
        const src = readFileSync(join(root, file), 'utf8');
        assert.ok(src.includes("from '../ipc-origin-guard.js'"), `${file} imports the guard`);
        assert.ok(!src.includes('isAllowedSender(event)'), `${file} must not use origin-only isAllowedSender`);
        const count = (src.match(/isManagerSender\(event\)/g) ?? []).length;
        assert.ok(count > 0, `${file} must use isManagerSender`);
        guarded += count;
    }
    assert.equal(guarded, 34, 'folder 15 + git 10 + terminal 5 + window 2 + clipboard 1 + perm-diag 1');
});

test('the browser IPC keeps its own manager-webContents guard', () => {
    const src = readFileSync(join(resolve(import.meta.dirname, '..', '..'), 'electron/src/main/lib/browser/ipc.ts'), 'utf8');
    assert.ok(src.includes('isManagerSender'), 'browser IPC uses the manager guard');
    const handles = (src.match(/ipcMain\.handle\(/g) ?? []).length;
    const guarded = (src.match(/isManagerSender\(event\)/g) ?? []).length;
    assert.equal(guarded, handles, 'every browser channel is guarded');
});

test('the tray-reminder channels stay origin-guarded because the popover calls them', () => {
    const src = readFileSync(join(resolve(import.meta.dirname, '..', '..'), 'electron/src/main/index.ts'), 'utf8');
    assert.ok(src.includes("ipcMain.on('tray:popup-menu'"));
    assert.ok(src.includes("ipcMain.on('tray:open-dashboard'"));
    // These two are the popover's legitimate bridge, so they keep isAllowedSender.
    const trayBlock = src.slice(src.indexOf("ipcMain.on('tray:popup-menu'"), src.indexOf("ipcMain.on('tray:open-dashboard'") + 200);
    assert.ok(trayBlock.includes('isAllowedSender(event)'), 'tray channels remain origin-guarded for the popover');
});
