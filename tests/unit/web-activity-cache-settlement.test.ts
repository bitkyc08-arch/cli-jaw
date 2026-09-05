import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { RuntimeEventBody } from '../../src/shared/runtime-contract.ts';

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
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) {
        if (topic === '*') dispatch = callback;
        return () => {};
    },
    onChannelOpen() {}, onChannelDisconnect() {}, onChannelUnavailable() {},
} });

const port = memoryIDB();
const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, 'IDBKeyRange');
let ui: typeof import('../../public/js/ui.ts');
let live: typeof import('../../public/js/features/activity-live.ts');
let cache: typeof import('../../public/js/features/idb-cache.ts');
let ws: typeof import('../../public/js/ws.ts');
let state: typeof import('../../public/js/state.ts')['state'];
const warnings: unknown[][] = [];

test.before(async () => {
    setupWebUiDom();
    mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: port.indexedDB });
    Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: { only: (value: unknown) => value } });
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const path = String(input);
        const data = path.includes('/orchestrate/snapshot') ? {
            activityIdentity: { sessionId: 'chat', scope: 'local:chat' },
            orc: { state: 'IDLE', scope: 'local:chat', ctx: null },
            heartbeat: { pending: 0, deferredPending: 0 }, workers: [],
            runtime: { queuePending: 0, busy: false }, queued: [], activeRun: null,
        } : path.includes('/api/runtime/requests?') ? { requests: [] }
            : path.includes('/api/traces/activity-runs') ? { runs: [], pageSize: 40 } : { count: 0 };
        return new Response(JSON.stringify({ ok: true, data }), { headers: { 'Content-Type': 'application/json' } });
    });
    ui = await import('../../public/js/ui.ts');
    live = await import('../../public/js/features/activity-live.ts');
    cache = await import('../../public/js/features/idb-cache.ts');
    ({ state } = await import('../../public/js/state.ts'));
    ws = await import('../../public/js/ws.ts');
    ws.connect();
});
test.beforeEach(async () => {
    await port.drain();
    ui.cleanupToolActivity();
    live.clearLiveActivity();
    document.getElementById('chatMessages')!.replaceChildren();
    port.rows.length = 0;
    port.writes.length = 0;
    warnings.length = 0;
    await ws.syncOrchestrateSnapshot('cache-settlement-test', { hydrateRun: true });
    assert.deepEqual(state.activityIdentity, { sessionId: 'chat', scope: 'local:chat' });
});
test.after(async () => {
    port.release();
    await port.drain();
    live.clearLiveActivity();
    ui.cleanupToolActivity();
    resetWebUiDom();
    if (originalKeyRange) Object.defineProperty(globalThis, 'IDBKeyRange', originalKeyRange);
    else Reflect.deleteProperty(globalThis, 'IDBKeyRange');
    mock.restoreAll();
});

function runtime(runId: string, seq: number, body: RuntimeEventBody): void {
    dispatch({ event: 'agent_runtime', version: 1, runId, sessionId: 'chat', scope: 'local:chat', turnId: 'turn', seq, ...body });
}
function start(runId: string) {
    dispatch({ event: 'agent_status', running: true });
    runtime(runId, 1, { kind: 'turn-start', provider: 'cursor' });
    const turn = live.findLiveActivity(runId);
    assert.ok(turn);
    assert.equal(turn.message, state.currentAgentDiv);
    assert.equal(turn.model.end, null);
    return turn;
}
function diagnostic(runId: string, text: string): void {
    // Deliberately no runtimeFinality/runtimeStatus: legacy diagnostic provenance.
    dispatch({ event: 'agent_done', traceRunId: runId, text, error: true });
}

test('canonical null in empty cache is corrected by matching unmarked legacy error in exactly one row', async () => {
    const run = 'cache-empty-null';
    cache.setMessageScope('cache-A');
    assert.deepEqual(await cache.getCachedMessages(), []);
    const turn = start(run);
    runtime(run, 2, { kind: 'turn-end', status: 'error', finalText: null });
    await port.drain();
    const before = await cache.getScopedMessages('cache-A');
    assert.equal(before.length, 1);
    assert.equal(before[0].content, '');
    assert.equal(before[0].trace_run_id, run);
    assert.equal(before[0].role, 'assistant');
    assert.equal(turn.message.querySelector('.msg-content')!.getAttribute('data-raw'), '');
    assert.equal(state.currentAgentDiv, null);
    const error = 'Print adapter exited with code 1: missing executable';
    diagnostic(run, error);
    diagnostic(run, error);
    await port.drain();
    const after = await cache.getCachedMessages();
    assert.deepEqual(after, [{ ...before[0], content: error }]);
    assert.equal(port.writes.filter(write => write.operation === 'add').length, 1);
    assert.equal(port.writes.filter(write => write.operation === 'update').length, 1);
    assert.equal(turn.message.querySelector('.msg-content')!.getAttribute('data-raw'), error);
    assert.equal(document.querySelectorAll('.msg-agent').length, 1);
    assert.equal(turn.model.end?.finalText, null);
    assert.equal(turn.model.end?.seq, 2);
    assert.equal(turn.answerSource, 'compatibility');
    assert.deepEqual(warnings, []);
});

test('scope captured at binding survives scope change before finalization and pending correction writes', async () => {
    const run = 'cache-scope-race';
    await cache.upsertMessage({ scope: 'cache-B', message_id: 'B-sentinel', role: 'assistant', content: 'B unchanged', timestamp: 1, trace_run_id: run });
    const originalB = await cache.getScopedMessages('cache-B');
    cache.setMessageScope('cache-A');
    const turn = start(run);
    assert.equal(turn.cacheScope, 'cache-A');
    cache.setMessageScope('cache-B'); // Before the first finalization, not just correction.
    port.hold();
    runtime(run, 2, { kind: 'turn-end', status: 'error', finalText: null });
    cache.setMessageScope('cache-C'); // Before upsertMessage resumes after openDB.
    await Promise.resolve();
    assert.equal(port.rows.length, 1);
    port.release();
    await port.drain();
    const originalA = await cache.getScopedMessages('cache-A');
    assert.equal(originalA.length, 1);
    assert.equal(originalA[0].content, '');
    assert.equal(originalA[0].trace_run_id, run);
    assert.deepEqual(await cache.getScopedMessages('cache-B'), originalB);
    assert.deepEqual(await cache.getScopedMessages('cache-C'), []);
    const error = 'Scoped diagnostic retained for original run';
    cache.setMessageScope('cache-B');
    port.hold();
    diagnostic(run, error);
    cache.setMessageScope('cache-C'); // Change immediately, before correction's await resumes.
    await Promise.resolve();
    assert.equal(port.rows.find(row => row['scope'] === 'cache-A')!['content'], '');
    port.release();
    await port.drain();
    diagnostic(run, error); // Repeated delivery must not update or append again.
    await port.drain();
    assert.deepEqual(await cache.getScopedMessages('cache-A'), [{ ...originalA[0], content: error }]);
    assert.deepEqual(await cache.getScopedMessages('cache-B'), originalB);
    assert.deepEqual(await cache.getScopedMessages('cache-C'), []);
    assert.equal((await cache.getCachedMessages()).length, 2);
    assert.deepEqual(port.writes.filter(write => write.operation === 'update').map(write => write.row['scope']), ['cache-A']);
    assert.equal(port.writes.filter(write => write.operation === 'add' && write.row['scope'] === 'cache-A').length, 1);
    assert.equal(turn.message.querySelector('.msg-content')!.getAttribute('data-raw'), error);
    assert.equal(document.querySelectorAll('.msg-agent').length, 1);
    assert.equal(turn.model.end?.finalText, null);
    assert.equal(turn.model.end?.seq, 2);
    assert.deepEqual(warnings, []);
});
