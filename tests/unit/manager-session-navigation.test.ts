import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import { InstanceListContent } from '../../public/manager/src/components/InstanceListContent.tsx';
import { useActiveSessionDisclosure } from '../../public/manager/src/hooks/useActiveSessionDisclosure.ts';
import { SIDEBAR_GROUP_COLLAPSED_KEY } from '../../public/manager/src/hooks/useSidebarGroupCollapse.ts';
import {
    getSessionListenerCountForTest, loadSessions, resetSessionStoreForTest,
} from '../../public/manager/src/lib/session-store.ts';
import type { DashboardInstance } from '../../public/manager/src/types.ts';

const online: DashboardInstance = {
    port: 3457, url: 'http://localhost:3457', status: 'online', ok: true,
    version: null, uptime: null, instanceId: 'default', homeDisplay: '/fixture',
    workingDir: '/fixture', currentCli: 'codex', currentModel: null,
    serviceMode: 'unknown', lastCheckedAt: '2026-09-08T00:00:00Z', healthReason: null,
};
const second: DashboardInstance = { ...online, port: 3458, url: 'http://localhost:3458' };
const offline: DashboardInstance = { ...online, port: 3459, ok: false, status: 'offline' };
let root: Root | null;
let container: HTMLDivElement;
let globals: PropertyDescriptorMap;
let previousCollapse: string | null;
let previews: number[];
let selections: number[];

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function response(labels: string[]): Response {
    return Response.json({ ok: true, data: {
        sessions: labels.map((label, seq) => ({ id: seq === 0 ? 'default' : `s-${seq}`, seq, label: label || null, message_count: 0 })),
        active: 'default',
    } });
}
function props(selectedInstance: DashboardInstance | null = online): ComponentProps<typeof InstanceListContent> {
    return {
        error: null, loading: false, instances: [online, second, offline], filtered: [online, second, offline],
        selectedInstance, data: null, lifecycleBusyPort: null, transitioningPort: null, transitionAction: null,
        activityUnreadByPort: {}, latestTitleByPort: {}, showLatestActivityTitles: false,
        showInlineLabelEditor: false, showSidebarRuntimeLine: false, showSelectedRowActions: true,
        profiles: [], getLabel: instance => `Jaw ${instance.port}`, formatUptime: () => '—',
        onSelect: instance => { selections.push(instance.port); },
        onPreview: instance => { previews.push(instance.port); },
        onMarkActivitySeen: () => {}, onInstanceLabelSave: async () => {}, onLifecycle: () => {},
    };
}
async function render(selected: DashboardInstance | null = online): Promise<void> {
    await act(async () => { root!.render(createElement(InstanceListContent, props(selected))); });
}
async function click(selector: string): Promise<void> {
    const target = container.querySelector<HTMLButtonElement>(selector);
    assert.ok(target, `missing ${selector}`);
    await act(async () => { target.click(); });
}
function items(): string[] {
    return [...container.querySelectorAll('[aria-label="Chat sessions"] [role="listitem"]')].map(el => el.textContent ?? '');
}
function expanded(): string | null | undefined {
    return container.querySelector('.action-sessions')?.getAttribute('aria-expanded');
}

beforeEach(() => {
    globals = Object.getOwnPropertyDescriptors(globalThis);
    setupWebUiDom();
    // tests/run uses the root tsconfig (classic JSX); Vite uses automatic JSX.
    Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
    previousCollapse = localStorage.getItem(SIDEBAR_GROUP_COLLAPSED_KEY);
    localStorage.removeItem(SIDEBAR_GROUP_COLLAPSED_KEY);
    previews = []; selections = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    for (const port of [3457, 3458, 3459]) assert.equal(getSessionListenerCountForTest(port), 0);
    resetSessionStoreForTest();
    if (previousCollapse === null) localStorage.removeItem(SIDEBAR_GROUP_COLLAPSED_KEY);
    else localStorage.setItem(SIDEBAR_GROUP_COLLAPSED_KEY, previousCollapse);
    resetWebUiDom();
    for (const key of Object.getOwnPropertyNames(globalThis)) {
        if (!(key in globals)) Reflect.deleteProperty(globalThis, key);
    }
    Object.defineProperties(globalThis, globals);
});

test('one default session opens automatically and hook/list share one GET and release listeners', async () => {
    const pending = deferred<Response>();
    let calls = 0;
    resetSessionStoreForTest({ fetchImpl: async () => { calls++; return pending.promise; } });
    await render();
    assert.match(container.querySelector('.instance-session-list')?.textContent ?? '', /Loading sessions/);
    assert.equal(calls, 1);
    assert.equal(getSessionListenerCountForTest(3457), 2);
    await act(async () => { pending.resolve(response([''])); await loadSessions(3457); });
    assert.equal(items().length, 1);
    assert.match(items()[0]!, /Default session/);
    assert.equal(container.querySelector('.action-sessions')?.getAttribute('aria-label'), 'Sessions (1)');
    assert.equal(expanded(), 'true');
    await render();
    assert.equal(calls, 1, 'fresh renders reuse the GET');
    await act(async () => { root!.unmount(); }); root = null;
    assert.equal(getSessionListenerCountForTest(3457), 0);
});

test('five rows stay in DOM; manual collapse and reopen do not select or preview', async () => {
    let calls = 0;
    resetSessionStoreForTest({ fetchImpl: async () => { calls++; return response(['one', 'two', 'three', 'four', 'five']); } });
    await render();
    assert.equal(items().length, 5);
    assert.equal(expanded(), 'true');
    await click('.action-sessions');
    assert.equal(container.querySelector('.instance-session-list'), null);
    assert.equal(expanded(), 'false');
    await click('.action-sessions');
    assert.equal(items().length, 5);
    assert.equal(expanded(), 'true');
    assert.deepEqual(previews, []); assert.deepEqual(selections, []);
    assert.equal(calls, 1);
});

test('port change opens B after collapsing A and ignores a late A refresh', async () => {
    let now = 10_000;
    let aCalls = 0;
    const lateA = deferred<Response>();
    const pendingB = deferred<Response>();
    resetSessionStoreForTest({ now: () => now, fetchImpl: async url => {
        if (String(url).includes('/3458/')) return pendingB.promise;
        return ++aCalls === 1 ? response(['A']) : lateA.promise;
    } });
    await render();
    await click('.action-sessions');
    now += 2_001;
    const refreshingA = loadSessions(3457);
    await render(second);
    assert.equal(getSessionListenerCountForTest(3457), 0);
    assert.match(container.querySelector('.instance-session-list')?.textContent ?? '', /Loading/);
    await act(async () => { pendingB.resolve(response(['B'])); await loadSessions(3458); });
    assert.equal(expanded(), 'true');
    assert.match(items()[0]!, /^B/);
    const bList = container.querySelector('.instance-session-list');
    await act(async () => { lateA.resolve(response(['late A'])); await refreshingA; });
    assert.equal(container.querySelector('.instance-session-list'), bList);
    assert.match(items()[0]!, /^B/);
    assert.equal(items().length, 1);
});

test('same-port refreshed count preserves a manually collapsed disclosure', async () => {
    let now = 10_000;
    let calls = 0;
    resetSessionStoreForTest({ now: () => now, fetchImpl: async () => response(++calls === 1 ? ['one'] : ['one', 'two']) });
    await render();
    await click('.action-sessions');
    now += 2_001;
    await act(async () => { await loadSessions(3457); });
    assert.equal(expanded(), 'false');
    assert.equal(container.querySelector('.action-sessions')?.getAttribute('aria-label'), 'Sessions (2)');
    assert.equal(items().length, 0);
});

test('loaded empty hides list and chevron', async () => {
    resetSessionStoreForTest({ fetchImpl: async () => response([]) });
    await render();
    assert.equal(container.querySelector('.instance-session-list'), null);
    assert.equal(container.querySelector('.action-sessions'), null);
});

test('null or offline selection never requests sessions or exposes disclosure', async () => {
    let calls = 0;
    resetSessionStoreForTest({ fetchImpl: async () => { calls++; return response(['unexpected']); } });
    for (const selected of [null, offline]) {
        await render(selected);
        assert.equal(container.querySelector('.instance-session-list'), null);
        assert.equal(container.querySelector('.action-sessions'), null);
    }
    assert.equal(calls, 0);
});

test('initial load error exposes Retry without chevron and recovers to expanded rows', async () => {
    let calls = 0;
    resetSessionStoreForTest({ fetchImpl: async () => ++calls === 1 ? new Response(null, { status: 503 }) : response(['recovered']) });
    await render();
    assert.match(container.querySelector('.instance-session-list')?.textContent ?? '', /503.*Retry/);
    assert.equal(container.querySelector('.action-sessions'), null);
    await click('.instance-session-retry');
    assert.equal(expanded(), 'true');
    assert.match(items()[0]!, /^recovered/);
    assert.deepEqual(previews, []); assert.deepEqual(selections, []);
});

test('cached load failure and failed switch retain Retry and successful retries restore rows', async () => {
    let now = 10_000;
    let gets = 0;
    let posts = 0;
    resetSessionStoreForTest({ now: () => now, fetchImpl: async (_url, init) => {
        if (init?.method === 'POST') {
            return ++posts === 1 ? Response.json({ error: 'switch refused' }, { status: 503 }) : new Response(null, { status: 200 });
        }
        return ++gets === 2 ? new Response(null, { status: 503 }) : response(['default', 'second']);
    } });
    await render();
    now += 2_001;
    await act(async () => { await assert.rejects(loadSessions(3457), /503/); });
    assert.equal(expanded(), 'true');
    assert.equal(items().length, 0, 'load error takes priority over cached rows');
    await click('.instance-session-retry');
    assert.equal(items().length, 2);
    await click('.instance-session-row:nth-child(2)');
    assert.match(container.querySelector('.instance-session-error')?.textContent ?? '', /switch refused.*Retry/);
    assert.equal(items().length, 2, 'switch error keeps cached rows');
    await click('.instance-session-retry');
    assert.equal(posts, 2);
    assert.equal(container.querySelector('.instance-session-error'), null);
    assert.deepEqual(previews, []); assert.deepEqual(selections, []);
});

test('Active and Running online row clicks preview exactly once; offline rows select', async () => {
    let posts = 0;
    resetSessionStoreForTest({ fetchImpl: async (_url, init) => { if (init?.method === 'POST') posts++; return response(['default']); } });
    await render();
    for (const [group, port] of [['active', 3457], ['running', 3457], ['running', 3458]] as const) {
        previews = []; selections = [];
        await click(`.instance-group[aria-label="${group === 'active' ? 'Selected' : 'Running'} instances"] .instance-row-select[data-instance-port="${port}"]`);
        assert.deepEqual(previews, [port]); assert.deepEqual(selections, []);
    }
    previews = []; selections = [];
    await click('.instance-row-select[data-instance-port="3459"]');
    assert.deepEqual(previews, []); assert.deepEqual(selections, [3459]);
    assert.equal(posts, 0);
});

function HookHarness({ port }: { port: number | null }) {
    const { activeSessionCount, sessionsOpen, setSessionsOpen } = useActiveSessionDisclosure(port);
    return createElement('button', { 'aria-expanded': sessionsOpen, onClick: () => setSessionsOpen(open => !open) }, String(activeSessionCount));
}

test('hook harness resets disclosure only on port changes and hands off subscriptions', async () => {
    resetSessionStoreForTest({ fetchImpl: async () => response(['default']) });
    await act(async () => { root!.render(createElement(HookHarness, { port: 3457 })); });
    assert.equal(container.querySelector('button')?.getAttribute('aria-expanded'), 'true');
    await click('button');
    await act(async () => { root!.render(createElement(HookHarness, { port: 3457 })); });
    assert.equal(container.querySelector('button')?.getAttribute('aria-expanded'), 'false');
    await act(async () => { root!.render(createElement(HookHarness, { port: 3458 })); });
    assert.equal(container.querySelector('button')?.getAttribute('aria-expanded'), 'true');
    assert.equal(getSessionListenerCountForTest(3457), 0);
    assert.equal(getSessionListenerCountForTest(3458), 1);
});
