import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

// Serial browser-IDB fixture reused from web-activity-answer-cache.test.ts
// (original provenance184d9826); cache writer, history reader, ws and finalizer are real.
type Row = Record<string, unknown>;
type Task = () => void;

// Only the browser storage port is replaced. Real idb-cache writers, scope
// capture, cursor selection and updates all execute against these transactions.
function memoryIDB() {
    const rows: Row[] = [];
    const writes: Array<{ operation: 'add' | 'update'; row: Row }> = [];
    const failures: unknown[] = [];
    const transactions: Task[] = [];
    let held = false;
    let nextId = 1;
    function pump(): void {
        if (held) return;
        while (transactions.length) transactions.shift()!();
    }
    function request<T>(read: () => T, schedule: (task: Task) => void) {
        const req = { result: undefined as T | undefined, onsuccess: null as Task | null, onerror: null as Task | null };
        schedule(() => { req.result = read(); req.onsuccess?.(); });
        return req;
    }
    const database = {
        transaction(name: string, mode: string) {
            assert.equal(name, 'messages');
            assert.ok(mode === 'readonly' || mode === 'readwrite');
            const tasks: Task[] = [];
            const schedule = (task: Task) => { tasks.push(task); };
            const tx = {
                oncomplete: null as Task | null,
                onerror: null as Task | null,
                objectStore(store: string) {
                    assert.equal(store, 'messages');
                    return {
                        indexNames: { contains: (index: string) => index === 'scope' },
                        add(row: Row) {
                            assert.equal(mode, 'readwrite');
                            const copy = structuredClone({ ...row, id: nextId++ });
                            return request(() => {
                                rows.push(copy);
                                writes.push({ operation: 'add', row: structuredClone(copy) });
                                return copy.id;
                            }, schedule);
                        },
                        getAll() { return request(() => structuredClone(rows), schedule); },
                        index(index: string) {
                            assert.equal(index, 'scope');
                            return {
                                getAll(scope: unknown) {
                                    return request(() => structuredClone(rows.filter(row => row['scope'] === scope)), schedule);
                                },
                                openCursor(scope: unknown) {
                                    let offset = 0;
                                    let matches: Row[];
                                    const req = { result: null as unknown, onsuccess: null as Task | null, onerror: null as Task | null };
                                    const advance = () => schedule(() => {
                                        matches ??= rows.filter(row => row['scope'] === scope);
                                        const row = matches[offset];
                                        req.result = row ? {
                                            value: structuredClone(row),
                                            update(value: Row) {
                                                assert.equal(mode, 'readwrite');
                                                const replacement = structuredClone(value);
                                                return request(() => {
                                                    const index = rows.findIndex(item => item['id'] === row['id']);
                                                    assert.ok(index >= 0);
                                                    rows[index] = replacement;
                                                    writes.push({ operation: 'update', row: structuredClone(replacement) });
                                                    return replacement['id'];
                                                }, schedule);
                                            },
                                            continue() { offset++; advance(); },
                                        } : null;
                                        req.onsuccess?.();
                                    });
                                    advance();
                                    return req;
                                },
                            };
                        },
                    };
                },
            };
            // Serialize transactions, including cursor update requests queued by
            // onsuccess, and fire completion only after all their requests finish.
            transactions.push(() => {
                try {
                    while (tasks.length) tasks.shift()!();
                    tx.oncomplete?.();
                } catch (error) { failures.push(error); tx.onerror?.(); }
            });
            queueMicrotask(pump);
            return tx;
        },
    };
    return {
        rows, writes, failures,
        indexedDB: { open: () => request(() => database, queueMicrotask) },
        hold() { held = true; },
        release() { held = false; queueMicrotask(pump); },
        async drain() {
            // A single event-loop boundary drains openDB awaits and transaction
            // microtasks, without timers, retries, or a guessed sleep duration.
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.deepEqual(failures, []);
            assert.equal(transactions.length, 0);
        },
    };
}



let dispatch: (value: Record<string, unknown>) => void;
let opened: () => void;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _name: unknown, callback: typeof dispatch) { if (topic === '*') dispatch = callback; return () => {}; },
    onChannelOpen(callback: () => void) { opened = callback; }, onChannelDisconnect() {}, onChannelUnavailable() {},
} });
// Raw drawer assets are outside this recovery oracle; no Trace action is used.
mock.module('../../public/js/features/trace-drawer.js', { namedExports: {
    closeTraceDrawer() {}, openTraceDrawer() { throw new Error('unexpected Trace action'); },
} });
let visibleRows: number[] = [];
let geometryChanged = () => {};
class Geometry {
    constructor(public options: Record<string, unknown>) { geometryChanged = options['onChange'] as () => void; }
    _didMount() { return () => {}; } _willUpdate() {} measureElement() {} measure() {}
    getVirtualItems() { return visibleRows.filter(index => index < Number(this.options['count'])).map(index => ({ index, key: index, start: index * 80, size: 80, end: (index + 1) * 80 })); }
    getTotalSize() { return Number(this.options['count']) * 80; }
    setOptions(options: Record<string, unknown>) { this.options = options; }
    scrollToIndex() {} scrollToOffset() {}
}
mock.module('@tanstack/virtual-core', { namedExports: {
    Virtualizer: Geometry, elementScroll() {}, observeElementRect() {}, observeElementOffset() {},
} });
const attention = await import('../../public/js/features/attention-badge.ts');
let unread = 0;
mock.module('../../public/js/features/attention-badge.js', { namedExports: { ...attention, notifyUnreadResponse() { unread++; } } });
const port = memoryIDB();
const identity = { sessionId: 'model-free-chat', scope: 'local:model-free-chat' };
let activeRun: Record<string, unknown> | null = null;
let savedStarted = Promise.withResolvers<void>();
let savedRelease = Promise.withResolvers<void>();
let savedReply: { kind: 'failure' | 'absent' } | { kind: 'saved'; id: number; content: string } = { kind: 'failure' };
let savedReads = 0, journalReads = 0, serial = 0, finalizations = 0;
let ui: typeof import('../../public/js/ui.ts');
let ws: typeof import('../../public/js/ws.ts');
let live: typeof import('../../public/js/features/activity-live.ts');
let history: typeof import('../../public/js/features/activity-history.ts');
let cache: typeof import('../../public/js/features/idb-cache.ts');
let virtual: typeof import('../../public/js/virtual-scroll.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let now = Date.now();
const originals = new Map(['IDBKeyRange', 'HTMLButtonElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

test.before(async () => {
    setupWebUiDom();
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: port.indexedDB });
    Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: { only: (value: unknown) => value } });
    Object.defineProperty(globalThis, 'HTMLButtonElement', { configurable: true, value: window.HTMLButtonElement });
    mock.method(Date, 'now', () => now); mock.method(console, 'log', () => {});
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin);
        if (url.pathname === '/api/orchestrate/snapshot') return Response.json({
            activityIdentity: identity, orc: { state: 'IDLE', scope: identity.scope, ctx: null },
            heartbeat: { pending: 0, deferredPending: 0 }, workers: [], runtime: { queuePending: 0, busy: !!activeRun }, queued: [], activeRun,
        });
        if (url.pathname === '/api/messages') return Response.json({ ok: true, data: { sessionId: identity.sessionId, messages: [] } });
        if (url.pathname.includes('/by-trace/')) {
            savedReads++; savedStarted.resolve(); await savedRelease.promise;
            if (savedReply.kind === 'absent') return Response.json({ ok: true, data: { message: null } });
            if (savedReply.kind === 'saved') return Response.json({ ok: true, data: { message: {
                id: savedReply.id, role: 'assistant', content: savedReply.content,
                trace_run_id: url.pathname.split('/').at(-1), session_id: identity.sessionId,
            } } });
            return Response.json({ ok: false, error: 'activity_answer_unavailable' }, { status: 503 });
        }
        if (url.pathname.endsWith('/activity')) {
            journalReads++;
            assert.equal(url.searchParams.get('session'), identity.sessionId);
            const runId = url.pathname.split('/')[3];
            return Response.json({ ok: true, data: { runId, sessionId: identity.sessionId, scope: 'historical:execution-scope',
                status: 'done', events: [], nextAfter: 0, through: 0, hasMore: false, incomplete: true, loss: 'unavailable' } });
        }
        if (url.pathname === '/api/traces/activity-runs') return Response.json({ ok: true, data: { runs: [], pageSize: 40 } });
        if (url.pathname === '/api/runtime/requests') return Response.json({ ok: true, data: { requests: [] } });
        if (url.pathname === '/api/auth/token') return Response.json({ token: 'fixture-token' });
        return Response.json({ ok: true, data: { count: 0 } });
    });
    ui = await import('../../public/js/ui.ts');
    mock.module('../../public/js/ui.js', { namedExports: { ...ui, finalizeAgent: (...args: Parameters<typeof ui.finalizeAgent>) => {
        finalizations++; return ui.finalizeAgent(...args);
    } } });
    live = await import('../../public/js/features/activity-live.ts');
    history = await import('../../public/js/features/activity-history.ts');
    cache = await import('../../public/js/features/idb-cache.ts');
    virtual = await import('../../public/js/virtual-scroll.ts');
    ({ state } = await import('../../public/js/state.ts'));
    ws = await import('../../public/js/ws.ts'); ws.connect(); opened();
    for (let i = 0; i < 100 && !state.activityIdentity; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(state.activityIdentity, identity);
    await port.drain();
});
test.beforeEach(async () => {
    savedRelease.resolve(); await port.drain();
    history.disposeActivityHistory(); virtual.getVirtualScroll().clear(); ui.cleanupToolActivity(); live.clearLiveActivity();
    document.getElementById('chatMessages')!.replaceChildren(); document.documentElement.dataset['presentationMode'] = 'activity';
    visibleRows = []; activeRun = null; now += 1000;
    savedStarted = Promise.withResolvers<void>(); savedRelease = Promise.withResolvers<void>();
    savedReply = { kind: 'failure' };
    savedReads = 0; journalReads = 0; unread = 0; finalizations = 0;
    port.rows.length = 0; port.writes.length = 0;
    await ws.syncOrchestrateSnapshot('model-free-reset', { hydrateRun: true });
});
test.after(async () => {
    savedRelease.resolve(); port.release(); await port.drain();
    history.disposeActivityHistory(); virtual.getVirtualScroll().clear(); live.clearLiveActivity(); ui.cleanupToolActivity();
    resetWebUiDom(); mock.restoreAll();
    for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
});

async function recoverModelFree(virtualized = false, beforeFinalize: () => void | Promise<void> = () => {}) {
    const runId = 'tr_model_free_' + String(++serial).padStart(16, '0');
    if (virtualized) { visibleRows = [0, 1]; ui.addMessage('user', 'seed virtual scroll'); }
    cache.setMessageScope('cache-A');
    activeRun = { running: true, traceRunId: runId, cli: 'cursor', text: 'PROVISIONAL NOT FINAL', textLen: 21,
        toolLog: virtualized ? [{ icon: 'tool', label: 'Read A', toolType: 'tool', status: 'done', stepRef: 'owned-read', traceRunId: runId, traceSeq: 1, detail: 'owned detail' }] : [] };
    await ws.syncOrchestrateSnapshot('model-free-recovery', { hydrateRun: true });
    await savedStarted.promise;
    const original = state.currentAgentDiv; assert.ok(original);
    const messageId = original.dataset['messageId']; assert.ok(messageId);
    assert.equal(live.findLiveActivity(runId), undefined, 'empty seed must not invent an ActivityState or turnId');
    const completion = history.hydrateActivityHost(original, runId, true);
    await beforeFinalize();
    savedRelease.resolve(); await completion; await port.drain();
    assert.equal(savedReads, 1); assert.equal(journalReads, 2, 'real seed and suffix readers both ran');
    assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
    return { runId, messageId, original };
}

for (const [virtualized, missing] of [[false, false], [true, false], [false, true]] as const)
test(`empty owned journal + ${missing ? 'missing' : 'failed'} answer GET retains one late public correction (${virtualized ? 'tool-backed offscreen VS' : 'plain host'})`, { timeout: 10000 }, async () => {
    if (missing) savedReply = { kind: 'absent' };
    const { runId, messageId } = await recoverModelFree(virtualized);
    const finalsBefore = finalizations, unreadBefore = unread;
    if (virtualized) { visibleRows = []; geometryChanged(); }
    cache.setMessageScope('cache-B');
    const final = 'EXACT LATE PUBLIC ANSWER';
    const packet = { event: 'agent_done', traceRunId: runId, ...identity, runtimeFinality: 'present', runtimeStatus: 'done', text: final };
    dispatch({ ...packet, sessionId: 'foreign-chat', text: 'FOREIGN' });
    dispatch({ ...packet, scope: 'foreign-scope', text: 'FOREIGN' });
    dispatch({ ...packet, scope: 'historical:execution-scope', text: 'WRONG DELIVERY SCOPE' });
    dispatch({ ...packet, runtimeFinality: 'absent', text: 'DIAGNOSTIC NOT ANSWER' });
    dispatch(packet); dispatch({ ...packet, text: 'DUPLICATE MUST NOT REPLACE' });
    await port.drain();
    if (virtualized) { visibleRows = [0, 1]; geometryChanged(); }
    const rows = [...document.querySelectorAll<HTMLElement>('.msg-agent')].filter(row => row.dataset['traceRunId'] === runId);
    assert.equal(rows.length, 1); assert.equal(rows[0]!.querySelector('.msg-content')?.getAttribute('data-raw'), final);
    assert.equal(rows[0]!.dataset['messageId'], messageId, 'recovery/correction retains the same stable host identity');
    const cached = (await cache.getScopedMessages('cache-A')).filter(row => row.role === 'assistant' && row.trace_run_id === runId);
    assert.equal(cached.length, 1); assert.equal(cached[0]!.content, final); assert.equal(cached[0]!.session_id, identity.sessionId);
    assert.deepEqual(await cache.getScopedMessages('cache-B'), []);
    assert.equal(port.writes.filter(write => write.operation === 'add' && write.row['trace_run_id'] === runId).length, 1);
    assert.equal(finalizations, finalsBefore); assert.equal(unread, unreadBefore);
    assert.equal(live.findLiveActivity(runId), undefined, 'no fabricated model after correction');
});

test('successful exact saved retry withdraws unavailable provenance before a late public answer', { timeout: 10000 }, async () => {
    const { runId, original, messageId } = await recoverModelFree();
    assert.equal(original.dataset['activityAnswerPending'], 'true');
    const finalsBefore = finalizations, unreadBefore = unread;
    savedReply = { kind: 'saved', id: 77, content: 'EXACT SAVED RETRY ANSWER' };
    await history.hydrateActivityHost(original, runId, true); await port.drain();
    assert.equal(savedReads, 2);
    assert.equal(original.dataset['activityAnswerPending'], undefined);
    assert.equal(original.dataset['activitySaved'], 'true');
    assert.equal(original.dataset['serverMessageId'], '77');
    assert.equal(original.dataset['messageId'], messageId);
    const before = await cache.getScopedMessages('cache-A');
    const cached = before.filter(row => row.trace_run_id === runId);
    assert.equal(cached.length, 1); assert.equal(cached[0]!.content, savedReply.content); assert.equal(cached[0]!.message_id, 77);
    const writes = port.writes.length;
    dispatch({ event: 'agent_done', ...identity, traceRunId: runId, runtimeFinality: 'present', text: 'LATE MUST NOT REPLACE SAVED' });
    await port.drain();
    assert.equal(original.querySelector('.msg-content')?.getAttribute('data-raw'), savedReply.content);
    assert.deepEqual(await cache.getScopedMessages('cache-A'), before);
    assert.equal(port.writes.length, writes); assert.equal(finalizations, finalsBefore); assert.equal(unread, unreadBefore);
    assert.equal(live.findLiveActivity(runId), undefined);
});

for (const content of ['FIRST SAVED ANSWER', '']) test(`first successful model-free saved recovery retains tool-backed VS ownership (${content ? 'nonempty' : 'empty'})`, { timeout: 10000 }, async t => {
    savedReply = { kind: 'saved', id: 88, content };
    const forcedScroll: string[] = [];
    const { runId, messageId } = await recoverModelFree(true, async () => {
        // Initial append and preserveScrollDuringMutation schedule a two-frame
        // follow. Settle that known layout before the user starts browsing away.
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const container = document.getElementById('chatMessages')!;
        for (const [key, value] of [['scrollHeight', 5000], ['clientHeight', 600]] as const)
            Object.defineProperty(container, key, { configurable: true, value });
        t.after(() => { Reflect.deleteProperty(container, 'scrollHeight'); Reflect.deleteProperty(container, 'clientHeight'); });
        container.scrollTop = 0; container.dispatchEvent(new window.Event('scroll'));
        t.mock.method(virtual.getVirtualScroll(), 'scrollToBottom', () => { forcedScroll.push(new Error('scroll caller').stack!); });
    });
    const rows = [...document.querySelectorAll<HTMLElement>('.msg-agent')].filter(row => row.dataset['traceRunId'] === runId);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.dataset['messageId'], messageId);
    assert.equal(row.dataset['messageSessionId'], identity.sessionId);
    assert.equal(row.dataset['serverMessageId'], '88');
    assert.equal(row.dataset['activitySaved'], 'true');
    assert.equal(row.querySelector('.msg-content')?.getAttribute('data-raw'), content);
    assert.equal(forcedScroll.length, 0, 'asynchronous history completion cannot force the browsing user to the tail: ' + forcedScroll.join('\n'));
    const cached = (await cache.getScopedMessages('cache-A')).filter(item => item.trace_run_id === runId);
    assert.equal(cached.length, 1); assert.equal(cached[0]!.content, content);
    assert.equal(cached[0]!.session_id, identity.sessionId); assert.equal(cached[0]!.message_id, 88);
    await history.hydrateActivityHost(row, runId, true); await port.drain();
    assert.equal(savedReads, 2, 'retained VS row can inspect its history again');
    assert.equal(live.findLiveActivity(runId), undefined);
});

function beginOtherRun() {
    const runId = 'tr_other_run_' + String(++serial).padStart(16, '0');
    dispatch({ event: 'agent_status', running: true });
    dispatch({ event: 'agent_runtime', version: 1, ...identity, runId, turnId: runId, seq: 1,
        kind: 'turn-start', provider: 'fixture' });
    assert.ok(live.findLiveActivity(runId));
    return runId;
}
function finishOtherRun(runId: string) {
    dispatch({ event: 'agent_done', ...identity, traceRunId: runId, runtimeFinality: 'present', text: 'OTHER ANSWER' });
}

test('model-free receipt and corrected tombstone outlive eight unrelated finals without touching live B', { timeout: 10000 }, async () => {
    const { runId, original } = await recoverModelFree();
    cache.setMessageScope('cache-B');
    for (let i = 0; i < 9; i++) finishOtherRun(beginOtherRun());
    assert.equal(live.hasModelFreeAnswerReceipt(runId), true);
    const b = beginOtherRun(); const bHost = state.currentAgentDiv!; const bHtml = bHost.outerHTML;
    const finalsBefore = finalizations, unreadBefore = unread;
    const packet = { event: 'agent_done', ...identity, traceRunId: runId, runtimeFinality: 'present', text: 'LATE AFTER NINE' };
    dispatch(packet); await port.drain();
    assert.equal(original.querySelector('.msg-content')?.getAttribute('data-raw'), packet.text);
    assert.equal(state.currentAgentDiv, bHost); assert.equal(state.agentBusy, true); assert.equal(bHost.outerHTML, bHtml);
    assert.equal(finalizations, finalsBefore); assert.equal(unread, unreadBefore);
    finishOtherRun(b);
    for (let i = 0; i < 9; i++) finishOtherRun(beginOtherRun());
    await port.drain();
    const settledFinals = finalizations, settledUnread = unread;
    const writes = port.writes.length, rowCount = port.rows.length;
    dispatch({ ...packet, text: 'DUPLICATE AFTER SECOND NINE' }); await port.drain();
    assert.equal(live.hasModelFreeAnswerReceipt(runId), true, 'consumed receipt remains an inert tombstone');
    assert.equal(port.writes.length, writes); assert.equal(port.rows.length, rowCount);
    assert.equal(finalizations, settledFinals); assert.equal(unread, settledUnread);
    const cached = (await cache.getScopedMessages('cache-A')).filter(row => row.trace_run_id === runId);
    assert.equal(cached.length, 1); assert.equal(cached[0]!.content, packet.text);
    assert.equal(live.findLiveActivity(runId), undefined);
});

test('session identity disposal withdraws model-free correction authority', { timeout: 10000 }, async () => {
    const { runId, original } = await recoverModelFree();
    assert.equal(live.hasModelFreeAnswerReceipt(runId), true);
    const writes = port.writes.length;
    const finalsBefore = finalizations, unreadBefore = unread;
    // Exercise real ws disposal. jsdom does not navigate; its not-implemented
    // reload diagnostic is irrelevant to the already synchronous identity fence.
    dispatch({ event: 'session_switched' });
    assert.equal(state.activityIdentity, null);
    assert.equal(live.hasModelFreeAnswerReceipt(runId), false);
    dispatch({ event: 'agent_done', ...identity, traceRunId: runId, runtimeFinality: 'present', text: 'OLD CHAT ANSWER' });
    await port.drain();
    assert.equal(original.querySelector('.msg-content')?.getAttribute('data-raw'), '');
    assert.equal(port.writes.length, writes);
    assert.equal(finalizations, finalsBefore); assert.equal(unread, unreadBefore);
});
