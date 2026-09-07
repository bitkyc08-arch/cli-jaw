import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import type { SaveHandler, SettingsClient } from '../../public/manager/src/settings/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    // The root tsx runner uses classic JSX for imported Manager components.
    React: await import('react'),
};
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Display } = await import('../../public/manager/src/settings/pages/Display');

after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globals[key];
    }
});

function settingsClient(initial: Record<string, unknown>, wrapped = false) {
    let snapshot = initial;
    let failure: Error | null = null;
    let pendingPut: Promise<void> | null = null;
    let reads = 0;
    const writes: { path: string; body: unknown }[] = [];
    const client: SettingsClient = {
        async get<T>(path: string) {
            assert.equal(path, '/api/settings');
            reads += 1;
            return snapshot as T;
        },
        async put<T>(path: string, body: unknown) {
            writes.push({ path, body });
            if (pendingPut) await pendingPut;
            if (failure) throw failure;
            snapshot = { ...snapshot, ...(body as Record<string, unknown>) };
            return (wrapped ? { data: snapshot } : snapshot) as T;
        },
        async post() { throw new Error('Unexpected POST'); },
        async delete() { throw new Error('Unexpected DELETE'); },
    };
    return {
        client, writes, fail: (error: Error | null) => { failure = error; }, reads: () => reads,
        deferPut() {
            const deferred = Promise.withResolvers<void>();
            pendingPut = deferred.promise;
            return deferred;
        },
    };
}

async function mountDisplay(t: TestContext, client: SettingsClient) {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.append(container);
    const root = createRoot(container);
    const dirty = createDirtyStore();
    let save: SaveHandler | null = null;
    let mounted = true;
    const registerSave = (handler: SaveHandler | null) => { save = handler; };
    const render = async (nextClient: SettingsClient, port = 3457) => {
        await act(async () => {
            root.render(createElement(Display, { port, instanceUrl: `/i/${port}`, client: nextClient, dirty, registerSave }));
        });
    };
    const unmount = async () => {
        if (!mounted) return;
        await act(async () => { root.unmount(); });
        mounted = false;
        container.remove();
    };
    t.after(unmount);
    await render(client);
    const control = () => {
        const button = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label^="Presentation:"]');
        assert.ok(button, 'mounted Display must expose the Presentation SelectField');
        return button;
    };
    const choose = async (label: string) => {
        await act(async () => { control().click(); });
        const option = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
            .find(button => button.textContent === label);
        assert.ok(option, `missing presentation option: ${label}`);
        await act(async () => { option.click(); });
    };
    return {
        container, dirty, render, unmount, control, choose,
        registered: () => save,
        save: async () => {
            const handler = save;
            assert.ok(handler);
            await act(async () => { await handler(); });
        },
        submit: async () => {
            const form = container.querySelector('form');
            assert.ok(form);
            await act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
        },
    };
}

test('fresh absent preference renders Activity, and reverting a draft clears its dirty entry', async t => {
    const api = settingsClient(Object.freeze({ tui: Object.freeze({ themeSeed: 'jaw-dark' }) }));
    const view = await mountDisplay(t, api.client);
    assert.equal(view.control().textContent, 'Activity (default)');
    assert.equal(view.dirty.isDirty(), false);
    await view.choose('Legacy transcript');
    assert.deepEqual(view.dirty.pending.get('presentation.mode'), { value: 'legacy', original: 'activity', valid: true });
    await view.choose('Activity (default)');
    assert.equal(view.dirty.isDirty(), false);
    await view.save();
    assert.deepEqual(api.writes, []);
});

for (const wrapped of [false, true]) {
    test(`registered save sends only the presentation patch and reloads persisted legacy (${wrapped ? 'wrapped' : 'direct'})`, async t => {
        const initial = Object.freeze({ tui: Object.freeze({ themeSeed: 'jaw-dark' }), permissions: 'manual' });
        const api = settingsClient(initial, wrapped);
        const view = await mountDisplay(t, api.client);
        await view.choose('Legacy transcript');
        await view.save();
        assert.deepEqual(api.writes, [{ path: '/api/settings', body: { presentation: { mode: 'legacy' } } }]);
        assert.ok(api.reads() >= 2, 'successful save refreshes settings');
        assert.equal(view.dirty.isDirty(), false);
        assert.equal(view.control().textContent, 'Legacy transcript');
        assert.deepEqual(initial, { tui: { themeSeed: 'jaw-dark' }, permissions: 'manual' });
        await view.choose('Activity (default)');
        assert.deepEqual(view.dirty.pending.get('presentation.mode'), { value: 'activity', original: 'legacy', valid: true });
        await view.unmount();
        const reloaded = await mountDisplay(t, api.client);
        assert.equal(reloaded.control().textContent, 'Legacy transcript');
        assert.equal(reloaded.dirty.isDirty(), false);
    });
}

test('registered save rejects to the shell while retaining the draft and dirty entry', async t => {
    const api = settingsClient({});
    const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    api.fail(new Error('Settings write rejected'));
    await assert.rejects(view.save(), /Settings write rejected/);
    assert.equal(view.control().textContent, 'Legacy transcript');
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'legacy' });
    assert.equal(view.container.querySelector('[role="alert"]'), null, 'registered errors belong to SettingsShell');
    api.fail(null);
    await view.save();
    assert.equal(view.dirty.isDirty(), false);
});

test('inline submit catches rejection visibly, retains draft, and clears error after successful retry', async t => {
    const api = settingsClient({});
    const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    api.fail(new Error('Settings write rejected'));
    await view.submit();
    assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? '', /Settings write rejected/);
    assert.equal(view.control().textContent, 'Legacy transcript');
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'legacy' });
    api.fail(null);
    await view.submit();
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.equal(view.dirty.isDirty(), false);
});

test('instance change resets legacy draft, dirty state and inline error to the new absent default', async t => {
    const first = settingsClient({});
    const second = settingsClient({});
    const view = await mountDisplay(t, first.client);
    await view.choose('Legacy transcript');
    first.fail(new Error('Old instance failure'));
    await view.submit();
    await view.render(second.client, 4567);
    assert.equal(view.control().textContent, 'Activity (default)');
    assert.equal(view.dirty.isDirty(), false);
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    await view.choose('Legacy transcript');
    await view.save();
    assert.deepEqual(second.writes, [{ path: '/api/settings', body: { presentation: { mode: 'legacy' } } }]);
    assert.equal(first.writes.length, 1);
});

test('unmount removes the presentation cleanup key and releases registered save', async t => {
    const view = await mountDisplay(t, settingsClient({}).client);
    await view.choose('Legacy transcript');
    view.dirty.set('unrelated.value', { value: 1, original: 0, valid: true });
    await view.unmount();
    assert.equal(view.dirty.pending.has('presentation.mode'), false);
    assert.equal(view.dirty.pending.has('unrelated.value'), true);
    assert.equal(view.registered(), null);
});

test('late PUT from the previous instance preserves the new instance snapshot, draft and dirty entry', async t => {
    const first = settingsClient({ tui: { themeSeed: 'jaw-dark' } });
    const second = settingsClient({ presentation: { mode: 'legacy' }, tui: { themeSeed: 'jaw-light' } });
    const deferred = first.deferPut();
    const view = await mountDisplay(t, first.client);
    await view.choose('Legacy transcript');
    const handler = view.registered();
    assert.ok(handler);
    let pending: Promise<void>;
    await act(async () => { pending = handler(); });
    assert.equal(first.writes.length, 1);
    await view.render(second.client, 4567);
    await view.choose('Activity (default)');
    const before = view.container.innerHTML;
    const entries = [...view.dirty.pending];
    await act(async () => { deferred.resolve(); await pending; });
    assert.equal(view.container.innerHTML, before, 'late PUT must not replace B draft or displayed data');
    assert.deepEqual([...view.dirty.pending], entries, 'late PUT must not clear B dirty state');
    assert.equal(second.reads(), 1, 'late PUT must not refresh B');
    await view.choose('Legacy transcript');
    assert.equal(view.dirty.isDirty(), false, 'B original snapshot must still be legacy');
});

test('late PUT after unmount does not clear the shared dirty store', async t => {
    const api = settingsClient({});
    const deferred = api.deferPut();
    const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    const handler = view.registered();
    assert.ok(handler);
    let pending: Promise<void>;
    await act(async () => { pending = handler(); });
    await view.unmount();
    view.dirty.set('presentation.mode', { value: 'activity', original: 'legacy', valid: true });
    await act(async () => { deferred.resolve(); await pending; });
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'activity' });
    assert.equal(api.reads(), 1);
});

test('late inline PUT rejection does not show an old instance error in the new instance', async t => {
    const first = settingsClient({});
    const second = settingsClient({ presentation: { mode: 'legacy' } });
    const deferred = first.deferPut();
    const view = await mountDisplay(t, first.client);
    await view.choose('Legacy transcript');
    await view.submit();
    await view.render(second.client, 4567);
    await view.choose('Activity (default)');
    await act(async () => { deferred.reject(new Error('Old instance failure')); });
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.equal(view.control().textContent, 'Activity (default)');
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'activity' });
});

test('one pending save disables Display fields and ignores an already-open option without losing the draft', async t => {
    const api = settingsClient({});
    const gate = api.deferPut();
    const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    await act(async () => { view.control().click(); });
    const option = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find(button => button.textContent === 'Activity (default)')!;
    assert.ok(option);
    const handler = view.registered()!;
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => { first = handler(); second = handler(); });
    assert.equal(first, second); assert.equal(api.writes.length, 1);
    assert.equal(view.control().disabled, true);
    assert.ok([...view.container.querySelectorAll<HTMLInputElement>('input')].every(input => input.disabled));
    await act(async () => { option.click(); });
    assert.equal(view.control().textContent, 'Legacy transcript');
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'legacy' });
    await act(async () => { gate.resolve(); await Promise.all([first, second]); });
    assert.equal(view.control().disabled, false); assert.equal(view.control().textContent, 'Legacy transcript');
    assert.equal(view.dirty.isDirty(), false);
});

test('save acknowledges only captured dirty entries and retains a newer unrelated entry', async t => {
    const api = settingsClient({});
    const gate = api.deferPut();
    const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    let pending!: Promise<void>;
    await act(async () => { pending = view.registered()!(); });
    view.dirty.set('unrelated.value', { value: 2, original: 1, valid: true });
    await act(async () => { gate.resolve(); await pending; });
    assert.deepEqual(view.dirty.saveBundle(), { 'unrelated.value': 2 });
    assert.deepEqual(api.writes, [{ path: '/api/settings', body: { presentation: { mode: 'legacy' } } }]);
});

test('A to B to A never reuses the first A save generation', async t => {
    const first = settingsClient({}); const second = settingsClient({ presentation: { mode: 'legacy' } });
    const gate = first.deferPut();
    const view = await mountDisplay(t, first.client);
    await view.choose('Legacy transcript');
    let pending!: Promise<void>;
    await act(async () => { pending = view.registered()!(); });
    await view.render(second.client, 4567);
    await view.render(first.client, 3457);
    await view.choose('Legacy transcript');
    const before = view.container.innerHTML, dirty = [...view.dirty.pending], reads = first.reads();
    await act(async () => { gate.resolve(); await pending; });
    assert.equal(view.container.innerHTML, before); assert.deepEqual([...view.dirty.pending], dirty);
    assert.equal(first.reads(), reads, 'old completion cannot refresh the re-mounted A generation');
    assert.equal(view.control().disabled, false);
});

test('Discard clears the presentation draft and restores the actual saved mode without a PUT', async t => {
    const api = settingsClient({}); const view = await mountDisplay(t, api.client);
    await view.choose('Legacy transcript');
    await act(async () => { view.dirty.clear(); });
    assert.equal(view.control().textContent, 'Activity (default)');
    assert.equal(view.dirty.isDirty(), false); assert.deepEqual(api.writes, []);
});

test('a newer same-field dirty entry remains the displayed intent after an older save completes', async t => {
    const api = settingsClient({}); const gate = api.deferPut();
    const view = await mountDisplay(t, api.client); await view.choose('Legacy transcript');
    let pending!: Promise<void>;
    await act(async () => { pending = view.registered()!(); });
    await act(async () => { view.dirty.set('presentation.mode', { value: 'activity', original: 'legacy', valid: true }); });
    await act(async () => { gate.resolve(); await pending; });
    assert.equal(view.control().textContent, 'Activity (default)');
    assert.deepEqual(view.dirty.saveBundle(), { 'presentation.mode': 'activity' });
});
