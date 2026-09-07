import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:43921', pretendToBeVisual: true });
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { RuntimeHeader } = await import('../../public/manager/src/settings/pages/components/agent/RuntimeHeader');
const { RuntimeEmployeeRow } = await import('../../public/manager/src/settings/pages/components/agent/RuntimeEmployeeRow');
const { FlushAgentSection } = await import('../../public/manager/src/settings/pages/components/agent/FlushAgentSection');
const { metaFor, normalizeCliMetaRegistry, orderRuntimeCliOptions } = await import('../../public/manager/src/settings/pages/components/agent/agent-meta');
const { makeDefaultRuntimeEmployee, unwrapRuntimeEmployees } = await import('../../public/manager/src/settings/pages/components/agent/runtime-employees-helpers');
const { preserveRetiredRuntimeOption } = await import('../../public/js/features/retired-runtime-option');
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    }
});
async function surface(t: TestContext, node: ReactNode) {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    await act(async () => root.render(node));
    return container;
}
async function open(container: HTMLElement, id: string) {
    const button = container.querySelector<HTMLButtonElement>(`#${id}`); assert.ok(button);
    await act(async () => button.click());
    return [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}

test('retired metadata cannot become selectable while saved employee identity is preserved', () => {
    const stale = { jwc: { label: 'JWC', models: ['legacy-model'], efforts: ['high'] },
        claude: { label: 'Claude', models: ['sonnet'], efforts: ['high'] } };
    assert.deepEqual(Object.keys(normalizeCliMetaRegistry(stale)), ['claude']);
    assert.deepEqual(orderRuntimeCliOptions(['jwc', 'claude', 'codex-app']), ['claude', 'codex-app']);
    assert.deepEqual(metaFor('jwc', stale), { label: 'JWC (retired)', models: [], efforts: [] });
    assert.equal(makeDefaultRuntimeEmployee(['jwc', 'claude']).cli, 'claude');
    const saved = unwrapRuntimeEmployees([{ id: 'saved', name: 'Saved', cli: 'jwc', model: 'legacy-model', role: '', source: 'db' }]);
    assert.equal(saved[0]?.cli, 'jwc');
    assert.equal(saved[0]?.model, 'legacy-model');
});

test('Classic active and flush selects preserve a retired value without selecting or dispatching another engine', () => {
    for (const id of ['selCli', 'flushCli']) {
        const select = document.createElement('select'); select.id = id;
        select.innerHTML = '<option value="claude">Claude</option><option value="codex-app">Codex</option>';
        let changes = 0; select.addEventListener('change', () => changes++);
        preserveRetiredRuntimeOption(select, 'jwc');
        assert.equal(select.value, 'jwc');
        assert.equal(select.selectedOptions[0]?.disabled, true);
        assert.match(select.selectedOptions[0]?.textContent ?? '', /retired/);
        assert.deepEqual([...select.options].filter(option => !option.disabled).map(option => option.value), ['claude', 'codex-app']);
        preserveRetiredRuntimeOption(select, 'jwc');
        assert.equal(select.options.length, 3);
        assert.equal(changes, 0);
    }
});

test('active retired selection stays visible and inert until an explicit available choice', async t => {
    const choices: string[] = [];
    const container = await surface(t, createElement(RuntimeHeader, {
        cli: 'jwc', cliOptions: ['jwc', 'claude', 'codex-app'], model: 'legacy-model',
        modelOptions: [{ value: 'legacy-model', label: 'legacy-model' }], effort: 'high', effortOptions: ['high'],
        workingDir: '/work', workingDirError: null, onCliChange: value => choices.push(value),
        onModelChange() {}, onEffortChange() {}, onWorkingDirChange() {},
    }));
    assert.match(container.querySelector('#agent-cli')!.textContent!, /JWC \(retired\)/);
    assert.equal(container.querySelector<HTMLButtonElement>('#agent-model')!.disabled, true);
    assert.equal(container.querySelector<HTMLButtonElement>('#agent-effort')!.disabled, true);
    assert.deepEqual(choices, []);
    const options = await open(container, 'agent-cli');
    assert.ok(options.every(option => !option.textContent?.includes('JWC')));
    const claude = options.find(option => option.textContent?.trim() === 'Claude'); assert.ok(claude);
    await act(async () => claude.click());
    assert.deepEqual(choices, ['claude']);
});

test('saved retired employee and flush choices are displayed without reintroducing them to menus', async t => {
    let changes = 0;
    const employee = await surface(t, createElement(RuntimeEmployeeRow, {
        employee: { id: 'old', name: 'Old agent', cli: 'jwc', model: 'old-model', role: '', source: 'db' },
        index: 0, cliOptions: ['jwc', 'claude'], onChange() { changes++; }, onRemove() {},
    }));
    assert.match(employee.querySelector('#runtime-employee-old-cli')!.textContent!, /retired/);
    assert.ok((await open(employee, 'runtime-employee-old-cli')).every(option => !option.textContent?.includes('JWC')));
    const flush = await surface(t, createElement(FlushAgentSection, {
        activeCli: 'claude', flushCli: 'jwc', flushModel: 'old-model', cliOptions: ['jwc', 'claude'],
        modelOptions: [{ value: 'old-model', label: 'old-model' }], onFlushCliChange() { changes++; }, onFlushModelChange() {},
    }));
    assert.match(flush.querySelector('#agent-flush-cli')!.textContent!, /retired/);
    assert.equal(flush.querySelector<HTMLButtonElement>('#agent-flush-model')!.disabled, true);
    assert.ok((await open(flush, 'agent-flush-cli')).every(option => !option.textContent?.includes('JWC')));
    assert.equal(changes, 0);
});

test('discarding an explicit runtime draft reloads the saved retired value without a write', { timeout: 10_000 }, async t => {
    await import('../../public/manager/src/settings/pages/Agent');
    const { SettingsShell } = await import('../../public/manager/src/settings/SettingsShell');
    let reads = 0;
    const saved = { cli: 'jwc', workingDir: '/work', permissions: 'auto', locale: 'en',
        runtimeDefaultMigration: null, multiSession: { enabled: false }, activeOverrides: {},
        perCli: { jwc: { model: 'legacy-model', effort: 'high' }, claude: { model: 'sonnet', effort: 'low' } } };
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
        assert.equal(options?.method ?? 'GET', 'GET', 'render, local edit and Discard must never write');
        const url = new URL(String(input), 'http://localhost:43921');
        assert.ok(url.pathname.startsWith('/i/43921/api/'), `expected selected-instance proxy: ${url.pathname}`);
        const path = url.pathname.slice('/i/43921'.length);
        const bodies: Record<string, unknown> = {
            '/api/settings': saved,
            '/api/cli-registry': { data: { claude: { label: 'Claude', models: ['sonnet'], efforts: ['low'] } } },
            '/api/cli-status': { jwc: { available: false, probeState: 'fresh' }, claude: { available: true, probeState: 'fresh' } },
            '/api/memory-files': { cli: 'jwc', model: 'legacy-model' },
            '/api/employees': { ok: true, data: [] },
        };
        assert.ok(Object.hasOwn(bodies, path), `unexpected read: ${url.pathname}`);
        if (path === '/api/settings') reads++;
        return new Response(JSON.stringify(bodies[path]), { headers: { 'content-type': 'application/json' } });
    });
    const container = await surface(t, createElement(SettingsShell, { port: 43921, instanceUrl: 'http://localhost:43921' }));
    assert.match(container.querySelector('#agent-cli')?.textContent ?? '', /JWC \(retired\)/);
    const options = await open(container, 'agent-cli');
    const claude = options.find(option => option.textContent?.trim() === 'Claude'); assert.ok(claude);
    await act(async () => claude.click());
    assert.match(container.querySelector('#agent-cli')?.textContent ?? '', /Claude/);
    const discard = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Discard');
    assert.ok(discard);
    await act(async () => discard.click());
    assert.match(container.querySelector('#agent-cli')?.textContent ?? '', /JWC \(retired\)/);
    assert.ok(reads >= 2, 'Discard must restore from the authoritative settings read');
    assert.equal(saved.cli, 'jwc');
});
