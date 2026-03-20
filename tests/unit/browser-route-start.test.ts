import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrowserStartOptions } from '../../src/routes/browser.ts';

test('BRS-001: browser start defaults to manual mode', () => {
    const start = resolveBrowserStartOptions({ body: {}, query: {} } as any);
    assert.equal(start.mode, 'manual');
    assert.equal(start.headless, false);
});

test('BRS-002: browser start preserves agent mode and headless flag', () => {
    const start = resolveBrowserStartOptions({
        body: { mode: 'agent', headless: true, port: 4444 },
        query: {},
    } as any);
    assert.equal(start.mode, 'agent');
    assert.equal(start.headless, true);
    assert.equal(start.port, 4444);
});

test('BRS-003: browser start preserves debug mode for route-level rejection', () => {
    const start = resolveBrowserStartOptions({
        body: { mode: 'debug' },
        query: {},
    } as any);
    assert.equal(start.mode, 'debug');
});

test('BRS-004: query port wins over body port', () => {
    const start = resolveBrowserStartOptions({
        query: { port: '3333' },
        body: { port: 2222 },
    } as any);
    assert.equal(start.port, 3333);
});
