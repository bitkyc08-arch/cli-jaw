import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let read: () => Promise<unknown> = async () => ({});
const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
let response: (snapshot: unknown) => Response = snapshot => new Response(JSON.stringify({ ok: true, data: snapshot }),
    { headers: { 'content-type': 'application/json' } });
mock.module('../../public/js/api.js', { namedExports: { API_BASE: '/i/4567', getAuthToken: async () => 'fixture-token' } });
globalThis.fetch = (async (path, init) => {
    assert.equal(String(path), '/i/4567/api/settings'); assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-token');
    return response(await read());
}) as typeof fetch;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const pref = await import('../../public/js/features/presentation-preference.js');
const dom = new JSDOM('<!doctype html><html></html>');
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
test.after(() => {
    dom.window.close(); mock.restoreAll(); globalThis.fetch = originalFetch;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete (globalThis as unknown as Record<string, unknown>)['document'];
});

test('absence defaults to Activity; explicit legacy and invalid mode use canonical normalization', () => {
    pref.applyPresentationSettings({});
    assert.equal(pref.getPresentationMode(), 'activity');
    pref.applyPresentationSettings({ presentation: { mode: 'legacy' } });
    assert.equal(document.documentElement.dataset['presentationMode'], 'legacy');
    pref.applyPresentationSettings({ presentation: { mode: 'native' } });
    assert.equal(pref.getPresentationMode(), 'activity');
});

test('a failed refresh preserves last applied preference', async () => {
    pref.applyPresentationSettings({ presentation: { mode: 'legacy' } });
    read = async () => null;
    await assert.rejects(pref.refreshPresentationSettings(), /presentation_settings_unavailable/);
    assert.equal(pref.getPresentationMode(), 'legacy');
});

test('settings change during an in-flight read fetches and applies the newer snapshot', async () => {
    let release!: (value: unknown) => void;
    let calls = 0;
    read = () => ++calls === 1 ? new Promise(resolve => { release = resolve; })
        : Promise.resolve({ presentation: { mode: 'legacy' } });
    const first = pref.refreshPresentationSettings();
    await tick();
    const second = pref.refreshPresentationSettings();
    release({ presentation: { mode: 'activity' } });
    await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.equal(pref.getPresentationMode(), 'legacy');
});

test('old loadSettings response cannot overwrite a newer event refresh', async () => {
    const oldLoad = pref.beginPresentationRead();
    read = async () => ({ presentation: { mode: 'legacy' } });
    await pref.refreshPresentationSettings();
    pref.applyPresentationSettings({ presentation: { mode: 'activity' } }, oldLoad);
    assert.equal(pref.getPresentationMode(), 'legacy');
});

test('a failed superseded read still services the queued settings change', async () => {
    let release!: (value: unknown) => void;
    let calls = 0;
    read = () => ++calls === 1 ? new Promise(resolve => { release = resolve; })
        : Promise.resolve({ presentation: { mode: 'legacy' } });
    const first = pref.refreshPresentationSettings();
    await tick();
    const latest = pref.refreshPresentationSettings();
    release(null);
    await Promise.all([first, latest]);
    assert.equal(calls, 2);
    assert.equal(pref.getPresentationMode(), 'legacy');
});

test('old event refresh cannot overwrite a later initial settings read', async () => {
    let release!: (value: unknown) => void;
    read = () => new Promise(resolve => { release = resolve; });
    const pending = pref.refreshPresentationSettings();
    await tick();
    const freshLoad = pref.beginPresentationRead();
    pref.applyPresentationSettings({ presentation: { mode: 'activity' } }, freshLoad);
    release({ presentation: { mode: 'legacy' } });
    await pending;
    assert.equal(pref.getPresentationMode(), 'activity');
});

test('bounded reader accepts direct settings and rejects malformed envelopes without resetting legacy', async () => {
    const original = response;
    response = snapshot => new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } });
    try {
        read = async () => ({ presentation: { mode: 'legacy' } });
        await pref.refreshPresentationSettings(); assert.equal(pref.getPresentationMode(), 'legacy');
        for (const invalid of [null, [], 'invalid', { ok: false, data: {} }, { ok: true, data: [] }]) {
            read = async () => invalid;
            await assert.rejects(pref.refreshPresentationSettings(), /presentation_settings_unavailable/);
            assert.equal(pref.getPresentationMode(), 'legacy');
        }
        read = async () => ({ ok: true, data: { presentation: { mode: 'activity' } } });
        await pref.refreshPresentationSettings(); assert.equal(pref.getPresentationMode(), 'activity');
    } finally { response = original; }
});

for (const stage of ['headers', 'body'] as const) {
    test(`${stage} deadline releases the refresh latch and retains the applied preference`, async t => {
        pref.applyPresentationSettings({ presentation: { mode: 'legacy' } });
        const controller = new AbortController();
        const timeout = t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 15000); return controller.signal; });
        const normalFetch = globalThis.fetch;
        let bodyCancelled = false;
        globalThis.fetch = (async () => stage === 'headers' ? new Promise<Response>(() => {})
            : new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
        try {
            const pending = pref.refreshPresentationSettings();
            const rejected = assert.rejects(pending, /presentation_settings_unavailable/);
            await tick(); controller.abort(new DOMException('fixture timeout', 'TimeoutError')); await rejected;
            assert.equal(pref.getPresentationMode(), 'legacy');
            if (stage === 'body') assert.equal(bodyCancelled, true);
        } finally { timeout.mock.restore(); globalThis.fetch = normalFetch; }
        read = async () => ({ presentation: { mode: 'activity' } });
        await pref.refreshPresentationSettings(); assert.equal(pref.getPresentationMode(), 'activity');
    });
}

test('oversize and invalid JSON bodies fail boundedly and preserve the last applied mode', async () => {
    const original = response;
    try {
        pref.applyPresentationSettings({ presentation: { mode: 'legacy' } });
        read = async () => ({});
        for (const body of ['{broken', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
            response = () => new Response(body, { headers: { 'content-type': 'application/json' } });
            await assert.rejects(pref.refreshPresentationSettings(), /presentation_settings_unavailable/);
            assert.equal(pref.getPresentationMode(), 'legacy');
        }
    } finally { response = original; }
    await pref.refreshPresentationSettings(); assert.equal(pref.getPresentationMode(), 'activity');
});
