import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import { expandPatch } from '../../public/manager/src/settings/pages/path-utils';
import type { PerCliEntry } from '../../public/manager/src/settings/pages/components/agent/agent-meta';
import type { SaveHandler, SettingsClient } from '../../public/manager/src/settings/types';
import {
    canSelectRuntimeTransport,
    transportFieldPatch,
    transportFieldValue,
} from '../../public/manager/src/settings/pages/components/runtime-transport-field';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    // Imported Manager JSX uses the root tsx runner's classic JSX transform.
    React: await import('react'),
    fetch: () => { throw new Error('Unexpected direct network request'); },
};
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PerCliRow } = await import('../../public/manager/src/settings/pages/components/PerCliRow');
const { default: ModelProvider } = await import('../../public/manager/src/settings/pages/ModelProvider');

after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globals[key];
    }
});

const eligible = ['cursor', 'grok', 'claude'];
const ineligible = ['codex', 'codex-app', 'pi', 'agy', 'ai-e', 'claude-e', 'jwc', 'gemini', 'kiro-code', 'opencode', 'copilot', '', 'Cursor', 'cursor.transport'];

test('only the three selectable runtimes accept a transport patch', () => {
    for (const cli of ineligible) {
        assert.equal(canSelectRuntimeTransport(cli), false, cli);
        for (const value of ['native', 'print']) {
            assert.throws(() => transportFieldPatch(cli, value), /^Error: runtime_transport_not_selectable$/);
        }
    }
    for (const cli of eligible) {
        assert.equal(canSelectRuntimeTransport(cli), true);
        for (const value of ['native', 'print']) {
            assert.deepEqual(transportFieldPatch(cli, value), { [`perCli.${cli}.transport`]: value });
        }
    }
});

test('absent form values normalize to print while explicit native remains native', () => {
    for (const value of [undefined, null, '', 'print', 'Native', 'acp', true, {}, []]) {
        assert.equal(transportFieldValue(value), 'print');
    }
    assert.equal(transportFieldValue('native'), 'native');
});

test('invalid transport selections fail instead of emitting a patch', () => {
    for (const cli of eligible) {
        for (const value of ['', 'Native', 'native ', 'acp', 'activity', 'legacy']) {
            assert.throws(() => transportFieldPatch(cli, value), /^Error: invalid_runtime_transport$/);
        }
    }
});

function mountRoot(t: TestContext) {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.append(container);
    const root = createRoot(container);
    t.after(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
    });
    return { root, container };
}

function control(container: HTMLElement, cli: string) {
    const button = container.querySelector<HTMLButtonElement>(`#percli-${cli}-transport`);
    assert.ok(button, `mounted ${cli} row must expose its transport SelectField`);
    assert.equal(button.getAttribute('role'), 'combobox');
    return button;
}

async function choose(container: HTMLElement, cli: string, label: string) {
    await act(async () => { control(container, cli).click(); });
    const option = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
        .find(button => button.textContent === label);
    assert.ok(option, `missing transport option: ${label}`);
    await act(async () => { option.click(); });
}

async function mountRow(t: TestContext, cli: string, original: PerCliEntry, draft = original) {
    const { root, container } = mountRoot(t);
    const dirty = createDirtyStore();
    let current = draft;
    function Harness() {
        const [value, setValue] = useState(draft);
        current = value;
        return createElement(PerCliRow, {
            cli, meta: { label: cli, models: ['model-a'], efforts: ['low', 'high'] },
            original, value, setValue, setEntry: dirty.set,
        });
    }
    await act(async () => { root.render(createElement(Harness)); });
    return { container, dirty, current: () => current };
}

test('mounted ineligible providers have no transport UI even with explicit native settings', async t => {
    for (const cli of ineligible.filter(Boolean)) {
        const view = await mountRow(t, cli, Object.freeze({ transport: 'native', model: 'model-a' }));
        assert.equal(view.container.querySelector('[aria-label^="Runtime transport:"]'), null, cli);
        assert.equal(view.dirty.isDirty(), false);
        assert.equal(view.current().transport, 'native');
    }
});

for (const cli of eligible) {
    test(`mounted ${cli} selection preserves other draft fields and reverting clears only its transport entry`, async t => {
        const original = Object.freeze({ provider: 'provider-a', model: 'model-a', effort: 'low', fastMode: true, contextWindowSize: 32000 });
        const draft = { ...original, effort: 'high' };
        const view = await mountRow(t, cli, original, draft);
        const effortEntry = { value: 'high', original: 'low', valid: true };
        view.dirty.set(`perCli.${cli}.effort`, effortEntry);
        assert.equal(control(view.container, cli).textContent, 'Print compatibility');
        await choose(view.container, cli, 'Native session');
        assert.deepEqual(view.current(), { ...draft, transport: 'native' });
        assert.deepEqual(view.dirty.pending.get(`perCli.${cli}.transport`), { value: 'native', original: 'print', valid: true });
        assert.deepEqual(expandPatch(view.dirty.saveBundle()), { perCli: { [cli]: { effort: 'high', transport: 'native' } } });
        assert.equal(Object.hasOwn(original, 'transport'), false);
        assert.equal(original.effort, 'low');
        await choose(view.container, cli, 'Print compatibility');
        assert.deepEqual([...view.dirty.pending], [[`perCli.${cli}.effort`, effortEntry]]);
        assert.deepEqual(view.current(), { ...draft, transport: 'print' });
    });

    test(`mounted ${cli} preserves unverified native and supports keyboard selection`, async t => {
        const original = Object.freeze({ model: 'model-a', transport: 'native' as const });
        const view = await mountRow(t, cli, original);
        const button = control(view.container, cli);
        assert.equal(button.textContent, 'Native session');
        assert.equal(button.disabled, false);
        assert.equal(view.dirty.isDirty(), false);
        for (const key of ['Enter', 'End', 'Enter']) {
            await act(async () => { button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true })); });
        }
        assert.deepEqual(view.dirty.pending.get(`perCli.${cli}.transport`), { value: 'print', original: 'native', valid: true });
        assert.equal(original.transport, 'native');
        await choose(view.container, cli, 'Native session');
        assert.equal(view.dirty.isDirty(), false);
    });
}

test('ModelProvider explains transport once and saves the selected field through its existing save owner', async t => {
    const original = Object.freeze({
        perCli: Object.freeze({
            cursor: Object.freeze({ model: 'model-a', effort: 'high', fastMode: true }),
            grok: Object.freeze({ transport: 'native' as const }),
            claude: Object.freeze({}),
            pi: Object.freeze({ transport: 'native' as const }),
        }),
        presentation: Object.freeze({ mode: 'legacy' }),
        permissions: 'manual',
    });
    let snapshot: typeof original = original;
    const writes: { path: string; body: unknown }[] = [];
    const client: SettingsClient = {
        async get<T>(path: string) {
            if (path === '/api/settings') return snapshot as T;
            assert.equal(path, '/api/cli-registry');
            return {} as T;
        },
        async put<T>(path: string, body: unknown) {
            writes.push({ path, body });
            assert.deepEqual(body, { perCli: { cursor: { transport: 'native' } } });
            snapshot = { ...original, perCli: { ...original.perCli, cursor: { ...original.perCli.cursor, ...{ transport: 'native' } } } };
            return { data: snapshot } as T;
        },
        async post() { throw new Error('Unexpected POST'); },
        async delete() { throw new Error('Unexpected DELETE'); },
    };
    const { root, container } = mountRoot(t);
    const dirty = createDirtyStore();
    let save: SaveHandler | null = null;
    const registerSave = (handler: SaveHandler | null) => { save = handler; };
    await act(async () => {
        root.render(createElement(ModelProvider, { port: 41824, instanceUrl: '/i/41824', client, dirty, registerSave }));
    });
    const notes = Array.from(container.querySelectorAll('.settings-percli-note'))
        .filter(note => note.textContent?.includes('Transport changes apply to the next run.'));
    assert.equal(notes.length, 1);
    assert.match(notes[0].textContent ?? '', /Changing presentation does not change this selection\./);
    const firstRow = container.querySelector('.settings-percli-row');
    assert.ok(firstRow);
    assert.ok(notes[0].compareDocumentPosition(firstRow) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(container.querySelectorAll('[aria-label^="Runtime transport:"]').length, 3);
    await choose(container, 'cursor', 'Native session');
    assert.deepEqual(writes, [], 'selecting a transport must not send a request');
    assert.deepEqual(dirty.saveBundle(), { 'perCli.cursor.transport': 'native' });
    const handler = save as SaveHandler | null;
    assert.ok(handler);
    await act(async () => { await handler(); });
    assert.deepEqual(writes, [{ path: '/api/settings', body: { perCli: { cursor: { transport: 'native' } } } }]);
    assert.equal(dirty.isDirty(), false);
    assert.equal(control(container, 'cursor').textContent, 'Native session');
    assert.equal(snapshot.presentation, original.presentation);
    assert.equal(snapshot.permissions, 'manual');
    assert.equal(Object.hasOwn(original.perCli.cursor, 'transport'), false);
    assert.deepEqual(snapshot.perCli.cursor, { model: 'model-a', effort: 'high', fastMode: true, transport: 'native' });
});
