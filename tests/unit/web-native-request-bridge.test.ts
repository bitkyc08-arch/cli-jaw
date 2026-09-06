import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

// Only the unrelated legacy renderer is replaced. ws, event-channel, session
// selection, bridge, panel, parsers, auth and bounded REST all execute for real.
const effects: Array<{ name: string; args: unknown[] }> = [];
const ui: Record<string, (...args: unknown[]) => unknown> = {};
for (const name of ['setStatus', 'updateQueueBadge', 'addSystemMsg', 'appendAgentText', 'finalizeAgent', 'replaceAgentAnswer',
    'addMessage', 'showProcessStep', 'cleanupToolActivity', 'applyQueuedOverlay', 'hydrateActiveRun',
    'reconcileChatBottomAfterRestore', 'showChatRestoreIndicator', 'markSteered', 'clearSteer', 'loadMessages']) {
    ui[name] = (...args) => { effects.push({ name, args }); };
}
ui['isRecentSteer'] = () => false;
ui['addMessage'] = (...args) => {
    effects.push({ name: 'addMessage', args });
    const message = document.createElement('div'); message.className = 'msg msg-agent';
    const body = document.createElement('div'); body.className = 'agent-body';
    const content = document.createElement('div'); content.className = 'msg-content';
    body.append(content); message.append(body); document.getElementById('chatMessages')!.append(message);
    return message;
};
mock.module('../../public/js/ui.js', { namedExports: ui });
mock.module('../../public/js/virtual-scroll.js', { namedExports: { getVirtualScroll: () => ({}) } });
mock.module('../../public/js/render.js', { namedExports: { escapeHtml: (s: string) => s, cancelPostRender() {} } });
mock.module('../../public/js/features/pending-queue.js', { namedExports: { renderPendingQueue() {} } });
mock.module('../../public/js/features/attention-badge.js', { namedExports: { notifyUnreadResponse() {} } });
mock.module('../../public/js/features/employees.js', { namedExports: { renderEmployees() {}, loadEmployees() {} } });
mock.module('../../public/js/features/memory.js', { namedExports: { refreshMemorySidebar() {} } });
mock.module('../../public/js/features/bgtask-badge.js', { namedExports: { refreshBgtaskBadge() {} } });

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
    closed = false;
    constructor(readonly url: string) { FakeEventSource.instances.push(this); }
    close() { this.closed = true; }
    open() { this.onopen?.(); }
    fail() { this.onerror?.(); }
    emit(event: string, data: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify({ ...data, topic: 'agent', event }), lastEventId: '1' });
    }
}
class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
    close() { this.onclose?.(); }
    open() { this.onopen?.(); }
}
const A = { sessionId: 'chat-A', scope: 'local:chat-A' };
const B = { sessionId: 'chat-B', scope: 'slack:T:C:thread' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
});
const listed = (requests: unknown[]) => json({ ok: true, data: { requests } });
const snapshot = (activityIdentity: unknown = A, state = 'IDLE') => json({ activityIdentity,
    orc: { state, scope: 'default', ctx: {} }, workers: [], runtime: { busy: false, queuePending: 0 }, queued: [], activeRun: null,
});
function pending(scope = 'default', identity = A) {
    return { ...identity, scope, runId: 'worker-run', turnId: 'worker-turn', requestId: 'opaque-request',
        requestType: 'question', expiresAt: Date.now() + 120_000,
        view: { title: '작업 내용을 확인해 주세요', fields: [{ id: 'q0', label: '응답할 실행을 확인해 주세요',
            multiSelect: false, allowFreeform: true, options: [] }] } };
}
const calls: Array<{ url: URL; init: RequestInit }> = [];
let serve: (url: URL, init: RequestInit) => Promise<Response>;
const requests = () => calls.filter(c => c.url.pathname === '/api/runtime/requests');
const posts = () => calls.filter(c => c.init.method === 'POST');
const root = () => document.querySelector<HTMLElement>('.native-requests')!;
const status = () => root().querySelector('.native-request-status')!.textContent!;
function button(label: string): HTMLButtonElement {
    const result = [...root().querySelectorAll('button')].find(b => b.textContent === label);
    assert.ok(result, label); return result;
}
async function until(check: () => boolean) {
    for (let i = 0; i < 1000; i++) { if (check()) return; await nextTick(); }
    assert.fail('actual ws/bridge/panel did not reach expected state');
}
async function drained() { for (let i = 0; i < 10; i++) await nextTick(); }

test('actual ws/event-channel native request lifecycle and legacy compatibility', async t => {
    setupWebUiDom();
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const host = document.querySelector('.chat-area')!;
    const input = document.createElement('div'); input.className = 'chat-input-area';
    const composer = document.createElement('textarea'); composer.id = 'chatInput'; input.append(composer); host.append(input);
    Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: window.location });
    t.mock.method(globalThis, 'fetch', async (input: unknown, init: RequestInit = {}) => {
        const url = new URL(String(input), 'http://fixture');
        if (url.pathname === '/api/auth/token') return json({ token: 'worker-auth' });
        calls.push({ url, init }); return serve(url, init);
    });
    serve = async url => url.pathname === '/api/orchestrate/snapshot' ? snapshot() : listed([]);
    const sessions = await import('../../public/js/features/session-hub.ts');
    const channel = await import('../../public/js/event-channel.ts');
    const ws = await import('../../public/js/ws.ts');
    const { state } = await import('../../public/js/state.ts');
    function select(which: 'A' | 'B') {
        sessions.configureSessionView({ active: 'chat-A', sessions: [
            { id: 'chat-A', seq: 1, label: null, message_count: 0, source: 'local', remoteKey: null },
            { id: 'chat-B', seq: 2, label: null, message_count: 0, source: 'slack', remoteKey: B.scope },
        ] }, which === 'A' ? '/1' : '/2');
    }
    select('A'); channel.setEventChannelScopeProvider(sessions.currentEventScope);
    const latest = () => FakeEventSource.instances.at(-1)!;
    t.after(() => { channel.closeEventChannel(); t.mock.timers.reset(); resetWebUiDom(); mock.restoreAll(); });

    await t.test('initial failure + never-open WS exposes manual retry and rejects pending snapshot from old epoch', async () => {
        ws.connect();
        assert.equal(new URL(latest().url, 'http://fixture').searchParams.get('scope'), A.scope);
        const deferred = Promise.withResolvers<Response>();
        serve = async url => url.pathname === '/api/orchestrate/snapshot' ? deferred.promise : listed([]);
        const read = ws.syncOrchestrateSnapshot('initial', { hydrateRun: true });
        latest().fail();
        assert.equal(FakeWebSocket.instances.length, 1);
        assert.equal(root().hidden, false); assert.match(status(), /unavailable/);
        assert.equal(effects.filter(e => e.name === 'cleanupToolActivity').length, 0);
        deferred.resolve(snapshot(A, 'B')); await read;
        assert.equal(state.activityIdentity, null); assert.equal(state.orcState, 'IDLE');
        assert.equal(requests().length, 0); assert.ok(button('Refresh requests'));
    });

    for (const stage of ['headers', 'body']) await t.test(`manual identity ${stage} deadline releases retry without reconnect`, async st => {
        const deadline = new AbortController();
        st.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 15_000); return deadline.signal; });
        let cancelled = false, requestSignal: AbortSignal | null | undefined;
        const count = calls.filter(call => call.url.pathname === '/api/orchestrate/snapshot').length;
        serve = async (_url, init) => {
            requestSignal = init.signal;
            if (stage === 'headers') return new Promise<Response>(() => {});
            return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
                headers: { 'content-type': 'application/json' },
            });
        };
        button('Refresh requests').click(); await drained();
        assert.equal(calls.filter(call => call.url.pathname === '/api/orchestrate/snapshot').length, count + 1);
        deadline.abort(new DOMException('Owned 15-second deadline', 'TimeoutError')); await drained();
        assert.equal(requestSignal?.aborted, true);
        if (stage === 'body') assert.equal(cancelled, true);
        assert.match(status(), /could not be loaded/); assert.equal(state.activityIdentity, null);
        st.mock.restoreAll();
        serve = async () => snapshot(null);
        button('Refresh requests').click(); await drained();
        assert.equal(calls.filter(call => call.url.pathname === '/api/orchestrate/snapshot').length, count + 2);
        assert.match(status(), /identity unavailable/); assert.equal(posts().length, 0);
    });

    await t.test('manual identity + list recovery enables exact current response without restoring native stream health', async () => {
        serve = async url => url.pathname === '/api/orchestrate/snapshot' ? snapshot() : listed([pending('custom:job')]);
        button('Refresh requests').click();
        await until(() => !!root().querySelector('form'));
        assert.deepEqual(state.activityIdentity, A);
        assert.equal(calls.find(c => c.url.pathname === '/api/orchestrate/snapshot')!.url.searchParams.get('session'), A.sessionId);
        assert.match(status(), /Manually refreshed; updates remain unavailable/);
        assert.match(root().querySelector('.native-request-context')!.textContent!, /custom:job.*worker-run/);
        assert.equal(button('Submit answers').disabled, false);
        const count = requests().length;
        FakeWebSocket.instances[0]!.open(); await drained();
        assert.equal(requests().length, count); assert.match(status(), /updates remain unavailable/);
        assert.ok(root().nextElementSibling === input); assert.equal(composer.disabled, false);
    });

    await t.test('only SSE-open clears outage, empty hides, notice wakes same-chat execution scope and coalesces', async () => {
        serve = async url => url.pathname === '/api/orchestrate/snapshot' ? snapshot() : listed([]);
        ws.connect(); latest().open(); await until(() => root().hidden);
        assert.equal(document.querySelectorAll('.native-requests').length, 1);
        serve = async () => listed([pending('default'), { ...pending('another-chat', B), requestId: 'foreign-request' }]);
        const count = requests().length;
        latest().emit('agent_runtime_requests_changed', { version: 1, ...A });
        latest().emit('agent_runtime_requests_changed', { version: 1, ...A });
        await until(() => !!root().querySelector('form') && !button('Submit answers').disabled);
        assert.equal(requests().length, count + 1); assert.doesNotMatch(status(), /unavailable/);
        assert.match(root().querySelector('.native-request-context')!.textContent!, /default/);
        assert.doesNotMatch(root().textContent!, /another-chat/);
        const text = root().querySelector('textarea')!; text.value = '허용한 실행만';
        serve = async (_url, init) => init.method === 'POST' ? json({ ok: true, data: { accepted: true } }) : listed([]);
        button('Submit answers').click(); await until(() => root().hidden);
        assert.deepEqual(JSON.parse(String(posts()[0]!.init.body)), { ...A, scope: 'default', runId: 'worker-run', turnId: 'worker-turn',
            response: { answers: { q0: { selected: [], text: '허용한 실행만' } } } });
        assert.equal(new Headers(posts()[0]!.init.headers).get('Authorization'), 'Bearer worker-auth');
    });

    await t.test('wrong/malformed notices cannot refresh or POST; matching canonical fallback refreshes only GET', async () => {
        const count = requests().length, writes = posts().length;
        for (const data of [{ version: 2, ...A }, { version: 1, ...B }, { version: 1, ...A, scope: 'execution:scope' }]) {
            latest().emit('agent_runtime_requests_changed', data);
        }
        latest().emit('agent_runtime', { version: 1, ...A, kind: 'request-settled' });
        await drained(); assert.equal(requests().length, count);
        latest().emit('agent_runtime', { version: 1, ...A, kind: 'request-settled', runId: 'run', turnId: 'turn', seq: 1, requestId: 'r' });
        await until(() => requests().length === count + 1); await drained();
        assert.equal(posts().length, writes);
    });

    await t.test('empty hidden panel exposes retry on disconnect; pending GET cannot reenable it', async () => {
        const read = Promise.withResolvers<Response>(); serve = async () => read.promise;
        const count = requests().length;
        latest().emit('agent_runtime_requests_changed', { version: 1, ...A });
        await until(() => requests().length === count + 1);
        latest().fail(); assert.equal(root().hidden, false); assert.match(status(), /unavailable/);
        read.resolve(listed([pending()])); await drained();
        assert.equal(root().querySelector('form'), null); assert.match(status(), /unavailable/);
        serve = async () => listed([pending()]); button('Refresh requests').click();
        await until(() => !!root().querySelector('form'));
        assert.match(status(), /Manually refreshed/); assert.equal(button('Submit answers').disabled, false);
    });

    await t.test('late POST after disconnect + manual GET never repaints or resends; SSE reconnect refreshes once', async () => {
        const write = Promise.withResolvers<Response>();
        serve = async (_url, init) => init.method === 'POST' ? write.promise : listed([pending()]);
        const before = posts().length; button('Cancel request').click(); await until(() => posts().length === before + 1);
        ws.connect(); button('Refresh requests').click(); await drained();
        write.resolve(json({ ok: true, data: { accepted: true } })); await drained();
        assert.match(status(), /Manually refreshed/); assert.doesNotMatch(status(), /Request cancelled/);
        assert.equal(posts().length, before + 1);
        serve = async url => url.pathname === '/api/orchestrate/snapshot' ? snapshot() : listed([]);
        const reads = requests().length; latest().open(); await until(() => root().hidden);
        assert.equal(requests().length, reads + 1);
    });

    await t.test('SSE reconnect while manual list is pending obtains a new-epoch list', async () => {
        latest().fail();
        const deferred = Promise.withResolvers<Response>(); serve = async () => deferred.promise;
        const reads = requests().length; button('Refresh requests').click();
        await until(() => requests().length === reads + 1);
        serve = async url => url.pathname === '/api/orchestrate/snapshot' ? snapshot(A) : listed([pending('fresh:epoch')]);
        ws.connect(); latest().open();
        await until(() => !!root().querySelector('form') && !button('Submit answers').disabled);
        deferred.resolve(listed([])); await drained();
        assert.match(root().textContent!, /fresh:epoch/); assert.doesNotMatch(status(), /unavailable/);
        assert.equal(requests().length, reads + 2);
    });

    await t.test('A to B during pending snapshot/list and POST never changes B or sends detached A controls', async () => {
        const stale = Promise.withResolvers<Response>();
        serve = async () => stale.promise;
        const older = ws.syncOrchestrateSnapshot('A', { hydrateRun: true });
        select('B'); serve = async url => url.pathname === '/api/orchestrate/snapshot' ? snapshot(B) : listed([pending('custom:B', B)]);
        await ws.syncOrchestrateSnapshot('B', { hydrateRun: true }); await until(() => !!root().querySelector('form'));
        stale.resolve(snapshot(A, 'C')); await older; assert.deepEqual(state.activityIdentity, B); assert.equal(state.orcState, 'IDLE');
        const write = Promise.withResolvers<Response>(); const before = posts().length;
        serve = async (_url, init) => init.method === 'POST' ? write.promise : listed([pending('custom:B', B)]);
        const oldCancel = button('Cancel request'); oldCancel.click(); await until(() => posts().length === before + 1);
        select('A'); serve = async url => url.pathname === '/api/orchestrate/snapshot' ? snapshot(A) : listed([pending('custom:A')]);
        await ws.syncOrchestrateSnapshot('A-new', { hydrateRun: true }); await until(() => !!root().querySelector('form'));
        write.resolve(json({ ok: true, data: { accepted: true } })); await drained(); oldCancel.click();
        assert.deepEqual(state.activityIdentity, A); assert.match(root().textContent!, /custom:A/);
        assert.doesNotMatch(root().textContent!, /Request cancelled/); assert.equal(posts().length, before + 1);
        const list = Promise.withResolvers<Response>(); serve = async () => list.promise;
        const reads = requests().length; button('Refresh requests').click();
        await until(() => requests().length === reads + 1);
        select('B'); serve = async url => url.pathname === '/api/orchestrate/snapshot' ? snapshot(B) : listed([]);
        await ws.syncOrchestrateSnapshot('B-empty', { hydrateRun: true }); await until(() => root().hidden);
        list.resolve(listed([pending()])); await drained(); assert.equal(root().hidden, true); assert.deepEqual(state.activityIdentity, B);
    });

    await t.test('failed/malformed identity stays unavailable and explicit retry can recover', async () => {
        for (const reply of [json({}, 503), json(null), snapshot({ sessionId: 'chat-B' })]) {
            serve = async () => reply;
            await ws.syncOrchestrateSnapshot('bad', { hydrateRun: true }).catch(() => {});
            assert.equal(state.activityIdentity, null); assert.equal(root().hidden, false); assert.equal(root().querySelector('form'), null);
        }
        serve = async url => url.pathname === '/api/orchestrate/snapshot' ? snapshot(B) : listed([]);
        button('Refresh requests').click(); await until(() => root().hidden); assert.deepEqual(state.activityIdentity, B);
    });

    await t.test('legacy tool/output/finality bytes still reach existing handlers, native notices do not', async () => {
        const start = effects.length;
        latest().emit('agent_tool', { traceRunId: 'legacy', traceSeq: 1, label: 'Read original', detail: 'original bytes', toolType: 'tool' });
        latest().emit('agent_output', { traceRunId: 'legacy', text: '원본 output', textLen: 9 });
        latest().emit('agent_done', { traceRunId: 'legacy', text: '원본 final', runtimeFinality: 'present' });
        const step = effects.slice(start).find(e => e.name === 'showProcessStep')?.args[0] as { detail: string };
        assert.equal(step.detail, 'original bytes');
        assert.deepEqual(effects.slice(start).find(e => e.name === 'appendAgentText')?.args, ['원본 output']);
        assert.deepEqual(effects.slice(start).find(e => e.name === 'finalizeAgent')?.args, ['원본 final', undefined, 'present']);
        const next = effects.length; latest().emit('agent_runtime_requests_changed', { version: 1, ...B });
        await drained(); assert.equal(effects.length, next);
    });
});
