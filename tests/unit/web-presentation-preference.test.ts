import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let read: () => Promise<unknown> = async () => ({});
mock.module('../../public/js/api.js', { namedExports: { api: () => read() } });
const pref = await import('../../public/js/features/presentation-preference.js');
const dom = new JSDOM('<!doctype html><html></html>');
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
test.after(() => { dom.window.close(); mock.restoreAll(); });

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
    const freshLoad = pref.beginPresentationRead();
    pref.applyPresentationSettings({ presentation: { mode: 'activity' } }, freshLoad);
    release({ presentation: { mode: 'legacy' } });
    await pending;
    assert.equal(pref.getPresentationMode(), 'activity');
});
