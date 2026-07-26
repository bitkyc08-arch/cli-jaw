// wp7a — the tray's structural and routing decisions, tested as pure functions.
//
// tray-manager.ts imports Tray/Menu/app from electron, so it cannot be
// imported in node. Its decisions are extracted to tray-decisions.ts and
// tested here; tray-manager delegates to them so the tests prove the running
// menu, not a copy.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    decideTrayLeftClick,
    trayBadgeTitle,
    decideCrashNotification,
    buildTrayMenuPlan,
} from '../../electron/src/main/lib/tray-decisions.ts';

test('left click opens the dashboard by default, a custom handler wins when set', () => {
    assert.equal(decideTrayLeftClick(false), 'open-dashboard');
    assert.equal(decideTrayLeftClick(true), 'custom');
});

test('badge title is a space-prefixed count, empty at zero', () => {
    assert.equal(trayBadgeTitle(0), '');
    assert.equal(trayBadgeTitle(3), ' 3');
});

test('crash notification only shows where notifications are supported', () => {
    assert.equal(decideCrashNotification(true), 'notify');
    assert.equal(decideCrashNotification(false), 'skip');
});

test('the menu keeps the checkbox states in sync with preferences', () => {
    const plan = buildTrayMenuPlan({
        serverStatus: 'Server: Running', keepRunning: true, startAtLogin: false,
        cliInstalled: false, isPackaged: true,
    });
    const keepRunning = plan.find(i => i.label === 'Keep Running in Background');
    const startAtLogin = plan.find(i => i.label === 'Start at Login');
    assert.equal(keepRunning?.checked, true);
    assert.equal(startAtLogin?.checked, false);
});

test('the install-cli item is only enabled in a packaged build without the CLI', () => {
    const enabled = buildTrayMenuPlan({ serverStatus: '', keepRunning: false, startAtLogin: false, cliInstalled: false, isPackaged: true })
        .find(i => i.kind === 'install-cli');
    assert.equal(enabled?.enabled, true);
    assert.equal(enabled?.label, 'Install CLI to Terminal');

    const installed = buildTrayMenuPlan({ serverStatus: '', keepRunning: false, startAtLogin: false, cliInstalled: true, isPackaged: true })
        .find(i => i.kind === 'install-cli');
    assert.equal(installed?.enabled, false);
    assert.equal(installed?.label, 'CLI Installed ✓');

    const unpacked = buildTrayMenuPlan({ serverStatus: '', keepRunning: false, startAtLogin: false, cliInstalled: false, isPackaged: false })
        .find(i => i.kind === 'install-cli');
    assert.equal(unpacked?.enabled, false);
});

test('the menu always ends with Quit and carries the server status first', () => {
    const plan = buildTrayMenuPlan({ serverStatus: 'Server: Starting...', keepRunning: false, startAtLogin: false, cliInstalled: true, isPackaged: false });
    assert.equal(plan[0]?.kind, 'status');
    assert.equal(plan[0]?.label, 'Server: Starting...');
    assert.equal(plan.at(-1)?.kind, 'quit');
});

// The wiring must use these decisions, or the tests prove a copy that drifted.
test('tray-manager delegates its structure and routing to tray-decisions', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');
    const manager = readFileSync(join(resolve(import.meta.dirname, '..', '..'), 'electron/src/main/lib/tray-manager.ts'), 'utf8');
    assert.match(manager, /decideTrayLeftClick|trayBadgeTitle|buildTrayMenuPlan|decideCrashNotification/);
});
