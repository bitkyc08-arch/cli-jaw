import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { RuntimeEventBody } from '../../src/shared/runtime-contract.ts';

// Serial memoryIDB helper reused from184d9826:web-activity-cache-settlement.test.ts.
// Geometry seam adapted from184d9826:web-print-activity-settlement.test.ts.
// This suite drives actual ws/ui/live/VS/cache; only transport, geometry and IDB
// browser ports are fakes. No fixed home, server, provider or history discovery.
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


let dispatch: (event: Record<string, unknown>) => void;
let opened: () => void;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) {
        if (topic === '*') dispatch = callback;
        return () => {};
    },
    onChannelOpen(callback: () => void) { opened = callback; },
    onChannelDisconnect() {}, onChannelUnavailable() {},
} });

let visibleRows: number[] = [];
let geometryChanged = () => {};
class Geometry {
    constructor(public options: Record<string, unknown>) { geometryChanged = options['onChange'] as () => void; }
    _didMount() { return () => {}; } _willUpdate() {} measureElement() {} measure() {}
    getVirtualItems() { return visibleRows.map(index => ({ index, start: index * 80, size: 80, end: (index + 1) * 80, key: index })); }
    getTotalSize() { return Number(this.options['count']) * 80; }
    setOptions(options: Record<string, unknown>) { this.options = options; }
    scrollToIndex() {} scrollToOffset() {}
}
mock.module('@tanstack/virtual-core', { namedExports: {
    Virtualizer: Geometry, elementScroll() {}, observeElementRect() {}, observeElementOffset() {},
} });

const port = memoryIDB();
const keyRangeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IDBKeyRange');
const identity = { sessionId: 'answer-cache-chat', scope: 'local:answer-cache-chat' };
const warnings: unknown[][] = [];
let ui: typeof import('../../public/js/ui.ts');
let live: typeof import('../../public/js/features/activity-live.ts');
let cache: typeof import('../../public/js/features/idb-cache.ts');
let ws: typeof import('../../public/js/ws.ts');
let virtual: typeof import('../../public/js/virtual-scroll.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let serial = 0;
let snapshotReads = 0;
let messageReads = 0;
let now = Date.now();

test.before(async () => {
    setupWebUiDom();
    mock.method(Date, 'now', () => now);
    mock.method(console, 'log', () => {});
    mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: port.indexedDB });
    Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: { only: (value: unknown) => value } });
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
        assert.ok(path.startsWith('/api/'), 'only local API fixtures are permitted');
        assert.ok(!path.startsWith('/api/traces/'), 'no wp24 history discovery in this live suite');
        if (path === '/api/orchestrate/snapshot') {
            snapshotReads++;
            // This endpoint is RAW top-level JSON, not the donor ok/data envelope.
            return Response.json({ activityIdentity: identity,
                orc: { state: 'IDLE', scope: identity.scope, ctx: null },
                heartbeat: { pending: 0, deferredPending: 0 }, workers: [],
                runtime: { queuePending: 0, busy: false }, queued: [], activeRun: null });
        }
        if (path === '/api/messages') { messageReads++; return Response.json({ ok: true, data: [] }); }
        if (path === '/api/runtime/requests') return Response.json({ ok: true, data: { requests: [] } });
        if (path === '/api/auth/token') return Response.json({ token: 'fixture-token' });
        return Response.json({ ok: true, data: { count: 0 } });
    });
    ui = await import('../../public/js/ui.ts');
    live = await import('../../public/js/features/activity-live.ts');
    cache = await import('../../public/js/features/idb-cache.ts');
    virtual = await import('../../public/js/virtual-scroll.ts');
    ({ state } = await import('../../public/js/state.ts'));
    ws = await import('../../public/js/ws.ts');
    ws.connect();
    assert.equal(typeof opened, 'function'); opened();
    for (let i = 0; i < 100 && !state.activityIdentity; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(state.activityIdentity, identity, 'actual channel-open history/snapshot chain must settle');
    assert.ok(snapshotReads > 0); assert.ok(messageReads > 0);
    await port.drain();
});
test.beforeEach(async () => {
    port.release(); await port.drain();
    now += 1000;
    virtual.getVirtualScroll().clear(); visibleRows = [];
    ui.clearSteer(); ui.cleanupToolActivity(); live.clearLiveActivity();
    document.getElementById('chatMessages')!.replaceChildren();
    document.documentElement.dataset['presentationMode'] = 'activity';
    port.rows.length = 0; port.writes.length = 0; warnings.length = 0;
    await ws.syncOrchestrateSnapshot('answer-cache-case', { hydrateRun: true });
    assert.deepEqual(state.activityIdentity, identity);
    await port.drain();
});
test.afterEach(async () => {
    port.release(); await port.drain();
    assert.equal(warnings.some(args => String(args[0]).startsWith('[idb-cache]')), false, 'cache errors must not be swallowed into a pass');
});
test.after(async () => {
    port.release(); await port.drain();
    virtual.getVirtualScroll().clear();
    live.clearLiveActivity(); ui.cleanupToolActivity(); resetWebUiDom();
    if (keyRangeDescriptor) Object.defineProperty(globalThis, 'IDBKeyRange', keyRangeDescriptor);
    else Reflect.deleteProperty(globalThis, 'IDBKeyRange');
    mock.restoreAll();
});

function runtime(runId: string, seq: number, body: RuntimeEventBody) {
    dispatch({ event: 'agent_runtime', version: 1, ...identity, runId, turnId: runId, seq, ...body });
}
function start() {
    const runId = 'answer-cache-' + ++serial;
    dispatch({ event: 'agent_status', running: true });
    runtime(runId, 1, { kind: 'turn-start', provider: 'fixture' });
    const turn = live.findLiveActivity(runId);
    assert.ok(turn, 'real ws Activity admission must be healthy, not merely an assigned identity');
    assert.equal(turn.message, state.currentAgentDiv);
    return { runId, turn };
}
function compatibility(runId: string, text: string, native = false) {
    dispatch({ event: 'agent_done', traceRunId: runId, text,
        ...(native ? { runtimeFinality: 'present', runtimeStatus: 'done' } : {}) });
}
async function answerRows(scope: string) {
    await port.drain();
    return (await cache.getScopedMessages(scope)).filter(row => row.role === 'assistant');
}

test('canonical null then legacy diagnostic corrects one actual cached answer without duplicate delivery writes', async () => {
    cache.setMessageScope('A');
    const { runId, turn } = start();
    runtime(runId, 2, { kind: 'turn-end', status: 'error', finalText: null });
    const before = await answerRows('A');
    assert.equal(before.length, 1); assert.equal(before[0]!.content, ''); assert.equal(before[0]!.trace_run_id, runId);
    dispatch({ event: 'agent_done', traceRunId: runId, text: 'PRINT FAILURE DETAIL', error: true });
    compatibility(runId, 'PRINT FAILURE DETAIL');
    const after = await answerRows('A');
    assert.deepEqual(after, [{ ...before[0], content: 'PRINT FAILURE DETAIL' }]);
    assert.equal(port.writes.filter(write => write.operation === 'add').length, 1);
    assert.equal(port.writes.filter(write => write.operation === 'update').length, 1);
    assert.equal(turn.model.end?.finalText, null);
});

test('compatibility-first native absent diagnostic never enters the persisted answer', async () => {
    cache.setMessageScope('native-absent');
    const { runId, turn } = start();
    dispatch({ event: 'agent_done', traceRunId: runId, text: 'DIAGNOSTIC NOT ANSWER',
        runtimeFinality: 'absent', runtimeStatus: 'error' });
    runtime(runId, 3, { kind: 'turn-end', status: 'error', finalText: null, error: 'DIAGNOSTIC' });
    const rows = await answerRows('native-absent');
    assert.equal(rows.length, 1); assert.equal(rows[0]!.content, '');
    assert.equal(rows[0]!.trace_run_id, runId); assert.equal(turn.model.end?.finalText, null);
    assert.equal(port.writes.filter(write => write.operation === 'add').length, 1);
    assert.equal(port.writes.filter(write => write.operation === 'update').length, 0);
});

for (const native of [false, true]) test(`pending canonical insert then ${native ? 'tagged native' : 'print'} correction stays in captured scope and one row`, async () => {
    cache.setMessageScope('A');
    const { runId, turn } = start();
    await cache.upsertMessage({ scope: 'B', role: 'assistant', content: 'B sentinel', trace_run_id: runId, timestamp: 1 });
    const sentinel = await cache.getScopedMessages('B');
    cache.setMessageScope('B');
    port.hold();
    try {
        runtime(runId, 3, { kind: 'turn-end', status: 'done', finalText: 'REDACTED PREVIEW' });
        compatibility(runId, 'FULL PUBLIC ANSWER', native);
        cache.setMessageScope('C');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(port.rows.length, 1, 'both answer transactions remain pending behind the storage gate');
        assert.equal(port.writes.filter(write => write.operation === 'update').length, 0);
    } finally { port.release(); }
    const rows = await answerRows('A');
    assert.equal(rows.length, 1); assert.equal(rows[0]!.content, 'FULL PUBLIC ANSWER'); assert.equal(rows[0]!.trace_run_id, runId);
    assert.equal(turn.cacheScope, 'A');
    assert.deepEqual(await cache.getScopedMessages('B'), sentinel);
    assert.deepEqual(await cache.getScopedMessages('C'), []);
    assert.deepEqual(port.writes.filter(write => write.row['scope'] === 'A').map(write => write.operation), ['add', 'update']);
    compatibility(runId, 'FULL PUBLIC ANSWER', native);
    runtime(runId, 3, { kind: 'turn-end', status: 'done', finalText: 'REDACTED PREVIEW' });
    await port.drain();
    assert.equal(port.rows.length, 2);
    assert.equal(port.writes.filter(write => write.operation === 'update').length, 1);
});

for (const mounted of [true, false]) test(`late A correction updates its ${mounted ? 'mounted' : 'offscreen'} VS row/cache while B stays active`, async () => {
    cache.setMessageScope('A');
    const a = start();
    runtime(a.runId, 2, { kind: 'turn-end', status: 'done', finalText: 'A PREVIEW' });
    await port.drain();
    const oldHost = a.turn.message;
    const messageId = oldHost.dataset['messageId']; assert.ok(messageId);
    const items = [{ id: 'virtual-A', messageId, html: oldHost.outerHTML, height: 80 }];
    const vs = virtual.getVirtualScroll();
    visibleRows = mounted ? [0] : [];
    const history = await import('../../public/js/features/message-history.ts');
    history.ensureActivityVirtualCallbacks(vs);
    vs.setItems(items, { toBottom: false });
    assert.equal(document.querySelectorAll('.msg-agent').length, mounted ? 1 : 0);
    cache.setMessageScope('B');
    const b = start(); const bHost = state.currentAgentDiv!; const bHtml = bHost.outerHTML;
    const original = 'x'.repeat(33000) + 'A_PUBLIC_TAIL';
    compatibility(a.runId, original, true);
    compatibility(a.runId, original, true);
    const rows = await answerRows('A');
    assert.equal(rows.length, 1); assert.equal(rows[0]!.content, original);
    assert.deepEqual(await cache.getScopedMessages('B'), []);
    assert.equal(state.currentAgentDiv, bHost); assert.equal(state.agentBusy, true);
    assert.equal(bHost.outerHTML, bHtml);
    assert.equal(vs.count, 1);
    const cachedDom = document.createElement('div'); cachedDom.innerHTML = items[0]!.html;
    assert.equal(cachedDom.querySelector('.msg-content')?.getAttribute('data-raw'), original);
    visibleRows = []; geometryChanged(); visibleRows = [0]; geometryChanged();
    assert.equal(document.querySelector('[data-message-id="' + messageId + '"] .msg-content')?.getAttribute('data-raw'), original);
    compatibility(b.runId, 'B FINAL', true);
    const bRows = await answerRows('B');
    assert.equal(bRows.length, 1); assert.equal(bRows[0]!.content, 'B FINAL');
    assert.equal(port.writes.filter(write => write.operation === 'add' && write.row['trace_run_id'] === a.runId).length, 1);
    assert.equal(port.writes.filter(write => write.operation === 'update' && write.row['trace_run_id'] === a.runId).length, 1);
});

for (const ownTool of [false, true]) test(`A ProcessBlock without A terminal cannot leak into B cached tool_log (${ownTool ? 'B own tool' : 'B no tools'})`, async () => {
    cache.setMessageScope('A');
    const a = start();
    dispatch({ event: 'agent_tool', traceRunId: a.runId, traceSeq: 2, stepRef: 'A-ONLY-STEP',
        label: 'A_PRIVATE_TOOL', detail: 'A_PRIVATE_DETAIL', toolType: 'tool', status: 'running' });
    const aBlock = state.currentProcessBlock; assert.ok(aBlock);
    assert.match(aBlock.element.textContent ?? '', /A_PRIVATE_TOOL/);
    assert.ok(aBlock.steps.some(step => step.stepRef === 'A-ONLY-STEP' && step.detail === 'A_PRIVATE_DETAIL'));
    dispatch({ event: 'agent_output', traceRunId: a.runId, text: 'A_PRIVATE_STREAM', textLen: 16 });
    cache.setMessageScope('B');
    const b = start();
    assert.equal(a.turn.model.end, null, 'no A terminal and no fixture cleanup between A and B');
    assert.notEqual(a.turn.message, b.turn.message);
    if (ownTool) dispatch({ event: 'agent_tool', traceRunId: b.runId, traceSeq: 2, stepRef: 'B-OWN-STEP',
        label: 'B_OWN_TOOL', detail: 'B_OWN_DETAIL', toolType: 'tool', status: 'done' });
    runtime(b.runId, 4, { kind: 'turn-end', status: 'done', finalText: 'B FINAL' });
    compatibility(b.runId, 'B FINAL', true);
    const rows = await answerRows('B');
    assert.equal(rows.length, 1); assert.equal(rows[0]!.trace_run_id, b.runId); assert.equal(rows[0]!.content, 'B FINAL');
    const tools = JSON.parse(rows[0]!.tool_log ?? '[]') as Array<Record<string, unknown>>;
    assert.equal(JSON.stringify(rows).includes('A_PRIVATE'), false, 'actual cache row must not contain any A tool detail or stream');
    assert.equal(tools.some(tool => tool['stepRef'] === 'A-ONLY-STEP'), false);
    if (ownTool) assert.ok(tools.some(tool => tool['stepRef'] === 'B-OWN-STEP'), 'B tool must survive, not be cleared to hide contamination');
    else assert.deepEqual(tools, []);
    assert.deepEqual(await cache.getScopedMessages('A'), []);
    assert.equal(port.writes.filter(write => write.operation === 'add').length, 1);
});
