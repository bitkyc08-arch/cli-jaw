// wp7a — the tray menu's click routing and checkbox preferences, tested
// behaviorally with injected side effects.
//
// tray-manager.ts imports electron directly so it cannot be imported in node,
// but the mapping from a menu-plan item to its handler lives in
// mapTrayMenuItem with the effects injected. Driving that with spies proves
// the routing the running menu uses, which a regex-over-source guard cannot.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mapTrayMenuItem, buildTrayMenuPlan } from '../../electron/src/main/lib/tray-decisions.ts';

function spies() {
    const calls: string[] = [];
    return {
        calls,
        fx: {
            onOpenDashboard: () => calls.push('open'),
            onCopyUrl: () => calls.push('copy'),
            onRestartServer: () => calls.push('restart'),
            onQuit: () => calls.push('quit'),
            onToggleKeepRunning: (c: boolean) => calls.push(`keepRunning:${c}`),
            onToggleStartAtLogin: (c: boolean) => calls.push(`startAtLogin:${c}`),
            onInstallCli: async () => { calls.push('install'); },
        },
    };
}

function click(entry: Record<string, unknown>, checked = false): void {
    (entry['click'] as (mi: { checked: boolean }) => void)({ checked });
}

test('every action item routes its click to the matching effect', () => {
    const { calls, fx } = spies();
    const plan = buildTrayMenuPlan({ serverStatus: '', keepRunning: false, startAtLogin: false, cliInstalled: true, isPackaged: true });
    for (const item of plan) {
        const entry = mapTrayMenuItem(item, fx);
        if (typeof entry['click'] === 'function' && item.kind !== 'install-cli' && item.kind !== 'checkbox') click(entry);
    }
    assert.deepEqual(calls.sort(), ['copy', 'open', 'quit', 'restart'].sort());
});

test('the keep-running checkbox toggles the keepRunning pref with the new value', () => {
    const { calls, fx } = spies();
    const plan = buildTrayMenuPlan({ serverStatus: '', keepRunning: false, startAtLogin: false, cliInstalled: true, isPackaged: true });
    const keepRunning = plan.find(i => i.pref === 'keepRunning')!;
    click(mapTrayMenuItem(keepRunning, fx), true);
    assert.deepEqual(calls, ['keepRunning:true']);
});

test('the start-at-login checkbox toggles the startAtLogin pref', () => {
    const { calls, fx } = spies();
    const plan = buildTrayMenuPlan({ serverStatus: '', keepRunning: false, startAtLogin: false, cliInstalled: true, isPackaged: true });
    const startAtLogin = plan.find(i => i.pref === 'startAtLogin')!;
    click(mapTrayMenuItem(startAtLogin, fx), false);
    assert.deepEqual(calls, ['startAtLogin:false']);
});

test('the install-cli item fires its async effect', async () => {
    const { calls, fx } = spies();
    const plan = buildTrayMenuPlan({ serverStatus: '', keepRunning: false, startAtLogin: false, cliInstalled: false, isPackaged: true });
    const install = plan.find(i => i.kind === 'install-cli')!;
    const entry = mapTrayMenuItem(install, fx);
    await (entry['click'] as () => Promise<void>)();
    assert.deepEqual(calls, ['install']);
});

test('no item falls through to a default handler', () => {
    const plan = buildTrayMenuPlan({ serverStatus: '', keepRunning: false, startAtLogin: false, cliInstalled: true, isPackaged: true });
    const { fx } = spies();
    for (const item of plan) {
        if (['status', 'separator'].includes(item.kind)) continue;
        const entry = mapTrayMenuItem(item, fx);
        assert.equal(typeof entry['click'], 'function', `${item.kind} must have a click handler`);
    }
});
