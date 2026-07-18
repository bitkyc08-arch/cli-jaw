import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Execution-level preload passthrough: the real preload module runs against a
// mocked electron package, and the exposed terminal.onData must forward the
// seq watermark emitted by main (C1: seq was silently dropped at this seam).
const electronRequire = createRequire(new URL('../../electron/package.json', import.meta.url));
const electronModulePath = electronRequire.resolve('electron');

const exposed = new Map<string, unknown>();
const channelListeners = new Map<string, Set<(...args: unknown[]) => void>>();

mock.module(electronModulePath, {
    namedExports: {
        contextBridge: {
            exposeInMainWorld: (key: string, api: unknown) => { exposed.set(key, api); },
        },
        ipcRenderer: {
            invoke: async () => ({}),
            on: (channel: string, handler: (...args: unknown[]) => void) => {
                let listeners = channelListeners.get(channel);
                if (!listeners) {
                    listeners = new Set();
                    channelListeners.set(channel, listeners);
                }
                listeners.add(handler);
            },
            removeListener: (channel: string, handler: (...args: unknown[]) => void) => {
                channelListeners.get(channel)?.delete(handler);
            },
        },
        webUtils: {},
    },
});

await import('../../electron/src/preload/index.ts');

test('preload terminal.onData forwards the seq watermark to renderer callbacks', () => {
    const api = [...exposed.values()]
        .map(value => (value as Record<string, unknown>)?.['terminal'])
        .find(terminal => terminal && typeof (terminal as Record<string, unknown>)['onData'] === 'function') as {
            onData(cb: (id: string, data: string, seq?: number) => void): () => void;
        } | undefined;
    assert.ok(api, 'terminal bridge api was exposed');

    const seen: Array<{ id: string; data: string; seq: number | undefined }> = [];
    const unsubscribe = api.onData((id, data, seq) => { seen.push({ id, data, seq }); });
    const handlers = channelListeners.get('terminal:data');
    assert.ok(handlers && handlers.size > 0, 'preload subscribed to terminal:data');
    for (const handler of handlers) handler({}, 'term_1', 'chunk-a', 7);
    assert.deepEqual(seen, [{ id: 'term_1', data: 'chunk-a', seq: 7 }]);

    unsubscribe();
    for (const handler of handlers) handler({}, 'term_1', 'chunk-b', 8);
    assert.equal(seen.length, 1, 'unsubscribe detaches the preload listener');
});
