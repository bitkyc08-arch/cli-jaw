import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
let dispatch: (event: Record<string, unknown>) => void, opened: () => void;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) { if (topic === '*') dispatch = callback; return () => {}; },
    onChannelOpen(callback: () => void) { opened = callback; }, onChannelDisconnect() {}, onChannelUnavailable() {},
} });
mock.module('../../public/js/features/trace-drawer.js', { namedExports: {
    closeTraceDrawer() {}, openTraceDrawer() { assert.fail('unexpected raw Trace action'); },
} });
let ui: typeof import('../../public/js/ui.ts'), ws: typeof import('../../public/js/ws.ts');
let live: typeof import('../../public/js/features/activity-live.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let vs: ReturnType<typeof import('../../public/js/virtual-scroll.ts')['getVirtualScroll']>;
let activeRun: Record<string, unknown> | null = null, serial = 0;
const bootstrapLoad = Promise.withResolvers<void>();
const bootstrapRelease = Promise.withResolvers<void>();
const bootstrapDone = Promise.withResolvers<void>();
const sidebarDone = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
const unexpectedRequests: string[] = [], requests: string[] = [];
test.before(async () => {
    setupWebUiDom();
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('../../public/css/activity.css', import.meta.url), 'utf8');
    document.head.append(style);
    const container = document.getElementById('chatMessages')!;
    for (const [key, value] of Object.entries({ clientWidth: 900, clientHeight: 600, offsetWidth: 900, offsetHeight: 600 }))
        Object.defineProperty(container, key, { configurable: true, value });
    container.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600, toJSON() { return {}; } });
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
        const key = `${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${url.pathname}${url.search}`;
        requests.push(key);
        try {
            assert.equal(url.origin, window.location.origin); assert.ok(key.startsWith('GET '));
            if (url.pathname === '/api/messages') {
                assert.deepEqual([...url.searchParams], [['limit', '3000'], ['withSession', '1']]);
                return Response.json({ ok: true, data: { sessionId: 'chat', messages: [] } });
            }
            if (url.pathname === '/api/runtime/requests') {
                assert.deepEqual([...url.searchParams], [['sessionId', 'chat']]);
                return Response.json({ ok: true, data: { requests: [] } });
            }
            if (url.pathname === '/api/traces/activity-runs') {
                assert.deepEqual([...url.searchParams], [['session', 'chat'], ['after', '']]);
                return Response.json({ ok: true, data: { runs: [], pageSize: 40 } });
            }
            if (/^\/api\/traces\/echo-\d+\/activity$/.test(url.pathname)) {
                assert.deepEqual([...url.searchParams], [['session', 'chat'], ['after', '0'], ['limit', '40']]);
                return Response.json({ ok: false, error: 'activity_unavailable' }, { status: 503 });
            }
            if (url.pathname === '/api/bgtask' && url.search === '?status=running') return Response.json({ tasks: [] });
            if (!url.search) {
                if (url.pathname === '/api/orchestrate/snapshot') return Response.json({
                    activityIdentity: { sessionId: 'chat', scope: 'local:chat' }, orc: { state: 'IDLE', scope: 'local:chat', ctx: null },
                    heartbeat: { pending: 0, deferredPending: 0 }, workers: [], runtime: { queuePending: 0, busy: !!activeRun }, queued: [], activeRun,
                });
                if (url.pathname === '/api/auth/token') return Response.json({ token: 'fixture-token' });
                if (url.pathname === '/api/settings') return Response.json({ workingDir: process.env.CLI_JAW_HOME });
                if (url.pathname === '/api/goal') return Response.json({ ok: true, goal: null });
                if (url.pathname === '/api/messages/count') return Response.json({ ok: true, data: { count: 0 } });
                if (url.pathname === '/api/memory-files' || url.pathname === '/api/memory/status')
                    return Response.json({ error: 'fixture_sidebar_unavailable' }, { status: 503 });
            }
            throw new Error('Unexpected HTTP route');
        } catch (error) { unexpectedRequests.push(`${key}: ${String(error)}`); throw error; }
    });
    ui = await import('../../public/js/ui.ts');
    mock.module('../../public/js/ui.js', { namedExports: { ...ui,
        async loadMessages() { bootstrapLoad.resolve(); await bootstrapRelease.promise; return ui.loadMessages(); },
        reconcileChatBottomAfterRestore: (...args: Parameters<typeof ui.reconcileChatBottomAfterRestore>) => {
            ui.reconcileChatBottomAfterRestore(...args);
            if (args[0] === 'reconnect') bootstrapDone.resolve();
        },
    } });
    const memory = await import('../../public/js/features/memory.ts');
    const background = await import('../../public/js/features/bgtask-badge.ts');
    mock.module('../../public/js/features/memory.js', { namedExports: { ...memory,
        async refreshMemorySidebar() { await memory.refreshMemorySidebar(); sidebarDone[0]!.resolve(); },
    } });
    mock.module('../../public/js/features/bgtask-badge.js', { namedExports: { ...background,
        async refreshBgtaskBadge() { await background.refreshBgtaskBadge(); sidebarDone[1]!.resolve(); },
    } });
    live = await import('../../public/js/features/activity-live.ts');
    ({ state } = await import('../../public/js/state.ts'));
    vs = (await import('../../public/js/virtual-scroll.ts')).getVirtualScroll();
    ws = await import('../../public/js/ws.ts'); ws.connect(); opened();
    await bootstrapLoad.promise;
    try {
        assert.equal(state.activityIdentity, null, 'held real history cannot admit the snapshot');
        assert.equal(requests.some(key => key.includes('/api/orchestrate/snapshot')), false);
    } finally {
        bootstrapRelease.resolve(); await bootstrapDone.promise;
        await Promise.all(sidebarDone.map(done => done.promise));
    }
    assert.deepEqual(state.activityIdentity, { sessionId: 'chat', scope: 'local:chat' });
    const historyRead = requests.indexOf('GET /api/messages?limit=3000&withSession=1');
    assert.ok(historyRead >= 0 && historyRead < requests.indexOf('GET /api/orchestrate/snapshot'));
    assert.deepEqual(unexpectedRequests, []);
});

for (const status of ['stopped', 'error'] as const) test(`Legacy exposes the canonical ${status} label without Activity details or a made-up final`, async () => {
    document.documentElement.dataset['presentationMode'] = 'legacy';
    try {
        ui.addMessage('user', 'OWNED_REQUEST');
        const run = start();
        runtime(run, 2, { kind: 'tool', itemId: 'read', name: 'Read', status: 'running' });
        runtime(run, 3, { kind: 'turn-end', status, finalText: null, ...(status === 'error' ? { error: 'OWNED_FAILURE' } : {}) });
        vs.invalidateLayout(); for (let i = 0; i < 20; i++) await tick();
        const root = document.querySelector<HTMLElement>('.activity-turn')!; assert.ok(root);
        assert.equal(root.dataset['status'], status, root.outerHTML);
        assert.notEqual(window.getComputedStyle(root).display, 'none', root.outerHTML);
        assert.equal(root.querySelector('.activity-status')?.textContent, status === 'stopped' ? 'Stopped' : 'Failed');
        assert.equal(window.getComputedStyle(root.querySelector<HTMLElement>('.activity-disclosure')!).display, 'none');
        assert.equal(document.querySelector('.msg-agent .msg-content')?.getAttribute('data-raw'), '');
        assert.equal(document.querySelectorAll('.orchestrate-placeholder').length, 0);
    } finally { delete document.documentElement.dataset['presentationMode']; }
});
test.beforeEach(async () => {
    activeRun = null; ui.cleanupToolActivity(); live.clearLiveActivity(); vs.clear();
    document.getElementById('chatMessages')!.replaceChildren();
    await ws.syncOrchestrateSnapshot('reset', { hydrateRun: true });
});
test.afterEach(() => { assert.deepEqual(unexpectedRequests, []); });
test.after(() => {
    ui.cleanupToolActivity(); live.clearLiveActivity(); vs.clear(); resetWebUiDom(); mock.restoreAll();
    assert.deepEqual(unexpectedRequests, []);
});
function runtime(runId: string, seq: number, body: RuntimeEventBody) {
    dispatch({ event: 'agent_runtime', version: 1, runId, sessionId: 'chat', scope: 'local:chat', turnId: 'turn', seq, ...body });
}
function start() {
    const run = 'echo-' + ++serial; dispatch({ event: 'agent_status', running: true });
    runtime(run, 1, { kind: 'turn-start', provider: 'claude' }); return run;
}
for (const mode of ['activity', 'legacy']) test(`late user echo cannot virtualize the in-flight ${mode} placeholder`, async () => {
    document.documentElement.dataset['presentationMode'] = mode;
    try {
        const run = start(), original = state.currentAgentDiv!;
        runtime(run, 2, { kind: 'message', itemId: 'comment', phase: 'commentary', operation: 'append', text: 'INTERNAL_PREVIEW' });
        runtime(run, 3, { kind: 'tool', itemId: 'read', name: 'Read', status: 'running' });
        ui.addMessage('user', 'LATE_USER_ECHO');
        assert.equal(vs.active, true);
        assert.equal(vs.count, 1, 'only the user belongs to history before the run settles');
        assert.equal(original.isConnected, true, 'the exact live native host remains outside virtual history');
        activeRun = { running: true, traceRunId: run, cli: 'claude', text: '', toolLog: [] };
        await ws.syncOrchestrateSnapshot('late-user-echo', { hydrateRun: true });
        assert.equal(state.currentAgentDiv, original); assert.equal(live.findLiveActivity(run)?.message, original);
        runtime(run, 4, { kind: 'turn-end', status: 'done', finalText: 'ONE_FINAL' });
        vs.invalidateLayout(); for (let i = 0; i < 20; i++) await tick();
        assert.equal(vs.count, 2); assert.equal(document.querySelectorAll('.msg-agent').length, 1);
        assert.equal(document.querySelector('.msg-agent .msg-content')?.getAttribute('data-raw'), 'ONE_FINAL');
        assert.equal(document.querySelectorAll('.orchestrate-placeholder').length, 0);
        if (mode === 'legacy') assert.equal(window.getComputedStyle(document.querySelector<HTMLElement>('.activity-turn')!).display, 'none');
    } finally { delete document.documentElement.dataset['presentationMode']; }
});

test('ordinary live stream and process details also remain outside initial history', async () => {
    ui.setStatus('running'); ui.appendAgentText('PRINT_PREVIEW');
    ui.showProcessStep({ id: 'owned-print-tool', type: 'tool', icon: 'tool', label: 'Owned read', status: 'running', detail: 'KEPT_DETAIL' });
    const original = state.currentAgentDiv!, block = state.currentProcessBlock;
    const processNode = original.querySelector('.process-block');
    ui.addMessage('user', 'LATE_PRINT_ECHO');
    assert.equal(vs.count, 1); assert.equal(state.currentAgentDiv, original); assert.equal(original.isConnected, true);
    assert.equal(state.currentProcessBlock, block); assert.equal(original.querySelector('.process-block'), processNode);
    ui.finalizeAgent('PRINT_FINAL');
    vs.invalidateLayout(); for (let i = 0; i < 20; i++) await tick();
    assert.equal(vs.count, 2); assert.equal(document.querySelectorAll('.msg-agent').length, 1);
    assert.equal(document.querySelector('.msg-agent .msg-content')?.getAttribute('data-raw'), 'PRINT_FINAL');
    assert.equal(document.querySelectorAll('.orchestrate-placeholder').length, 0);
});

for (const priorText of ['PRIOR_FINAL', '']) test(`bootstrap retains the genuinely completed ${priorText ? 'text' : 'empty'} row`, async () => {
    state.currentAgentDiv = ui.addMessage('agent', '');
    ui.finalizeAgent(priorText, undefined, 'present');
    const run = start(), original = state.currentAgentDiv!;
    ui.addMessage('user', 'NEXT_USER_ECHO');
    assert.equal(vs.count, 2, 'completed prior row plus user, not live placeholder');
    assert.equal(original.isConnected, true);
    runtime(run, 2, { kind: 'turn-end', status: 'done', finalText: 'NEXT_FINAL' });
    vs.invalidateLayout(); for (let i = 0; i < 20; i++) await tick();
    assert.equal(vs.count, 3);
    assert.deepEqual([...document.querySelectorAll('.msg-agent .msg-content')].map(node => node.getAttribute('data-raw')), [priorText, 'NEXT_FINAL']);
});

test('bootstrap failure still reattaches the exact current live element', t => {
    start(); const original = state.currentAgentDiv!;
    t.mock.method(vs, 'addItem', () => { throw Error('owned activation failure'); });
    assert.throws(() => ui.addMessage('user', 'LATE_ECHO'), /owned activation failure/);
    assert.equal(original.parentElement, document.getElementById('chatMessages'));
    assert.equal(state.currentAgentDiv, original);
});

test('bootstrap never moves a current pointer belonging to another container', () => {
    const elsewhere = document.createElement('aside'), foreign = document.createElement('div');
    elsewhere.append(foreign); document.body.append(elsewhere); state.currentAgentDiv = foreign;
    try {
        ui.addMessage('user', 'OWNED_USER');
        assert.equal(foreign.parentElement, elsewhere); assert.equal(vs.count, 1);
    } finally { elsewhere.remove(); }
});
