import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserWindow } from 'electron';
import { parseJawDeepLink, routeJawDeepLink } from '../../electron/src/main/lib/deep-link.ts';

function windowHarness(): { window: BrowserWindow; loaded: string[]; focused: string[] } {
    const loaded: string[] = [];
    const focused: string[] = [];
    const window = {
        isDestroyed: () => false,
        isMinimized: () => false,
        show: () => focused.push('show'),
        focus: () => focused.push('focus'),
        loadURL: async (url: string) => {
            loaded.push(url);
        },
    } as unknown as BrowserWindow;
    return { window, loaded, focused };
}

test('electron deep links reject unsafe paths', () => {
    assert.equal(parseJawDeepLink('jaw://open?path=https%3A%2F%2Fexample.com'), null);
    assert.equal(parseJawDeepLink('jaw://open?path=%2F%2Fevil.example'), null);
    assert.equal(parseJawDeepLink('jaw://unknown?path=%2Fprojects'), null);
});

test('electron deep links preserve the dashboard2 manager base path', async () => {
    const harness = windowHarness();
    const routed = await routeJawDeepLink('jaw://open?path=%2Fprojects%2Fdemo', {
        managerUrl: 'http://127.0.0.1:24577/dashboard2/?qa=wp1',
        getWindow: () => harness.window,
        ensureReady: async () => {},
    });

    assert.equal(routed, true);
    assert.deepEqual(harness.loaded, ['http://127.0.0.1:24577/dashboard2/projects/demo']);
    assert.deepEqual(harness.focused, ['show', 'focus']);
});

test('electron deep links preserve explicit root-manager routing', async () => {
    const harness = windowHarness();
    const routed = await routeJawDeepLink('jaw://open?path=%2Fprojects%2Fdemo', {
        managerUrl: 'http://127.0.0.1:24576/',
        getWindow: () => harness.window,
        ensureReady: async () => {},
    });

    assert.equal(routed, true);
    assert.deepEqual(harness.loaded, ['http://127.0.0.1:24576/projects/demo']);
});
