import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

type Row = Record<string, unknown>;
type Task = () => void;

// Browser storage is the only fake. Actual cache scope capture, cursor filtering,
// row updates and transaction sequencing execute without ws/history discovery.
function storagePort() {
    const rows: Row[] = [];
    const writes: string[] = [];
    const failures: unknown[] = [];
    let releaseOpen: Task | undefined;
    let nextId = 1;
    function request<T>(read: () => T, schedule: (task: Task) => void) {
        const req = { result: undefined as T | undefined, onsuccess: null as Task | null };
        schedule(() => { req.result = read(); req.onsuccess?.(); });
        return req;
    }
    const database = {
        transaction(storeName: string, mode: string) {
            assert.equal(storeName, 'messages');
            const tasks: Task[] = [];
            const tx = {
                oncomplete: null as Task | null, onerror: null as Task | null,
                objectStore(name: string) {
                    assert.equal(name, storeName);
                    return {
                        indexNames: { contains: (index: string) => index === 'scope' },
                        add(row: Row) {
                            assert.equal(mode, 'readwrite');
                            const copy = structuredClone({ ...row, id: nextId++ });
                            return request(() => { rows.push(copy); writes.push('add'); return copy.id; }, task => tasks.push(task));
                        },
                        getAll: () => request(() => structuredClone(rows), task => tasks.push(task)),
                        index(index: string) {
                            assert.equal(index, 'scope');
                            return {
                                getAll: (scope: unknown) => request(() => structuredClone(rows.filter(row => row['scope'] === scope)), task => tasks.push(task)),
                                openCursor(scope: unknown) {
                                    const matches = rows.filter(row => row['scope'] === scope);
                                    let offset = 0;
                                    const req = { result: null as unknown, onsuccess: null as Task | null };
                                    const advance = () => tasks.push(() => {
                                        const row = matches[offset];
                                        req.result = row ? {
                                            value: structuredClone(row),
                                            update(value: Row) {
                                                assert.equal(mode, 'readwrite');
                                                const copy = structuredClone(value);
                                                tasks.push(() => {
                                                    const index = rows.findIndex(item => item['id'] === row['id']);
                                                    assert.ok(index >= 0); rows[index] = copy; writes.push('update');
                                                });
                                            },
                                            delete() {
                                                assert.equal(mode, 'readwrite');
                                                tasks.push(() => {
                                                    const index = rows.findIndex(item => item['id'] === row['id']);
                                                    assert.ok(index >= 0); rows.splice(index, 1); writes.push('delete');
                                                });
                                            },
                                            continue() { offset++; advance(); },
                                        } : null;
                                        req.onsuccess?.();
                                    });
                                    advance(); return req;
                                },
                            };
                        },
                    };
                },
            };
            queueMicrotask(() => {
                try { while (tasks.length) tasks.shift()!(); tx.oncomplete?.(); }
                catch (error) { failures.push(error); tx.onerror?.(); }
            });
            return tx;
        },
    };
    return { rows, writes, failures,
        indexedDB: { open: () => request(() => database, task => { releaseOpen = task; }) },
        releaseOpen() { assert.ok(releaseOpen); releaseOpen(); releaseOpen = undefined; },
        close() { (database as typeof database & { onclose?: Task }).onclose?.(); },
    };
}

const port = storagePort();
const originals = new Map(['localStorage', 'indexedDB', 'IDBKeyRange'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let cache: typeof import('../../public/js/features/idb-cache.ts');

test.before(async () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: port.indexedDB });
    Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: { only: (value: unknown) => value } });
    cache = await import('../../public/js/features/idb-cache.ts');
});
test.after(() => {
    assert.deepEqual(port.failures, []);
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test('pending IDB open cannot redirect a live answer after the current scope changes', async () => {
    cache.setMessageScope('A');
    const pending = cache.upsertMessage({ role: 'assistant', content: '', trace_run_id: 'run-A', timestamp: 1 });
    cache.setMessageScope('B');
    assert.equal(port.rows.length, 0, 'openDB is still pending, not merely a queued transaction');
    port.releaseOpen(); await pending;
    assert.deepEqual(await cache.getScopedMessages('A'), [{ id: 1, message_id: undefined, role: 'assistant',
        content: '', cli: null, tool_log: null, trace_run_id: 'run-A', timestamp: 1, scope: 'A' }]);
    assert.deepEqual(await cache.getScopedMessages('B'), []);
});

test('exact captured scope/run assistant correction preserves other rows and never appends', async () => {
    await cache.upsertMessage({ scope: 'B', role: 'assistant', content: 'B unchanged', trace_run_id: 'run-A', timestamp: 2 });
    await cache.upsertMessage({ scope: 'A', role: 'assistant', content: 'other run', trace_run_id: 'run-other', timestamp: 3 });
    await cache.upsertMessage({ scope: 'A', role: 'user', content: 'user unchanged', trace_run_id: 'run-A', timestamp: 4 });
    const before = structuredClone(port.rows);
    const adds = port.writes.filter(value => value === 'add').length;
    const correction = cache.replaceCachedAnswer('run-A', 'EXACT PUBLIC ANSWER', 'A');
    cache.setMessageScope('C'); await correction;
    assert.deepEqual(port.rows, before.map(row => row['id'] === 1 ? { ...row, content: 'EXACT PUBLIC ANSWER' } : row));
    assert.equal(port.writes.filter(value => value === 'add').length, adds);
    await cache.replaceCachedAnswer('missing-run', 'must not appear', 'A');
    await cache.replaceCachedAnswer('run-A', 'must not appear', 'missing-scope');
    assert.equal(port.rows.length, before.length);
    assert.deepEqual(await cache.getScopedMessages('C'), []);
    assert.equal(port.writes.filter(value => value === 'update').length, 1);
});

test('explicit captured scope and empty answer correction survive resolved-openDB awaits', async () => {
    cache.setMessageScope('B');
    const pending = cache.upsertMessage({ scope: 'A', role: 'assistant', content: 'temporary', trace_run_id: 'run-empty', timestamp: 5 });
    cache.setMessageScope('C'); await pending;
    const count = port.rows.length;
    await cache.replaceCachedAnswer('run-empty', '', 'A');
    assert.equal(port.rows.length, count);
    assert.equal(port.rows.find(row => row['trace_run_id'] === 'run-empty')?.['content'], '');
    assert.equal(port.rows.find(row => row['trace_run_id'] === 'run-empty')?.['scope'], 'A');
});

test('bulk writes capture the namespace before pending open and preserve other namespaces', async () => {
    await cache.upsertMessage({ scope: 'bulk-A', role: 'assistant', content: 'stale A', timestamp: 6 });
    await cache.upsertMessage({ scope: 'bulk-B', role: 'assistant', content: 'B sentinel', timestamp: 7 });
    const before = structuredClone(port.rows);
    port.close();
    cache.setMessageScope('bulk-A');
    const pending = cache.cacheMessages([{ message_id: 61, role: 'assistant', content: 'fresh A',
        trace_run_id: 'run-bulk-A', session_id: 'chat-A', timestamp: 8 }]);
    cache.setMessageScope('bulk-B');
    assert.deepEqual(port.rows, before);
    port.releaseOpen(); await pending;
    const a = await cache.getScopedMessages('bulk-A');
    assert.equal(a.length, 1);
    assert.equal(a[0]?.content, 'fresh A');
    assert.equal(a[0]?.trace_run_id, 'run-bulk-A');
    assert.equal(a[0]?.session_id, 'chat-A');
    assert.equal(a[0]?.message_id, 61);
    assert.deepEqual(await cache.getScopedMessages('bulk-B'), before.filter(row => row['scope'] === 'bulk-B'));
});

test('bulk explicit namespace survives pending open without inferring legacy session ownership', async () => {
    const before = structuredClone(port.rows);
    port.close();
    cache.setMessageScope('bulk-B');
    const pending = cache.cacheMessages([{ role: 'assistant', content: 'legacy', timestamp: 9 }], 'bulk-explicit');
    cache.setMessageScope('bulk-C');
    assert.deepEqual(port.rows, before);
    port.releaseOpen(); await pending;
    const rows = await cache.getScopedMessages('bulk-explicit');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.content, 'legacy');
    assert.equal(Object.hasOwn(rows[0]!, 'session_id'), false);
    assert.equal(Object.hasOwn(rows[0]!, 'trace_run_id'), false);
    assert.deepEqual(port.rows.filter(row => row['scope'] !== 'bulk-explicit'), before);
    await cache.cacheMessages([], 'bulk-explicit');
    assert.deepEqual(await cache.getScopedMessages('bulk-explicit'), rows);
});

test('session-aware saved answer updates only its exact chat and compatible database row', async () => {
    const firstNewRow = port.rows.length;
    const base = { scope: 'shared-cache', role: 'assistant', content: 'original', timestamp: 10,
        trace_run_id: 'run-owned', session_id: 'chat-owned' };
    await cache.upsertMessage(base);
    await cache.upsertMessage({ ...base, message_id: 71 });
    await cache.upsertMessage({ ...base, message_id: 72 });
    await cache.upsertMessage({ ...base, message_id: 'browser-uuid' });
    await cache.upsertMessage({ ...base, session_id: 'other-chat' });
    const { session_id: _session, ...legacy } = base;
    await cache.upsertMessage(legacy);
    await cache.upsertMessage({ ...base, role: 'user' });
    await cache.upsertMessage({ ...base, trace_run_id: 'other-run' });
    await cache.upsertMessage({ ...base, scope: 'other-cache' });
    const before = structuredClone(port.rows);
    assert.equal(before[firstNewRow]?.['session_id'], 'chat-owned', 'upsert must retain explicit session metadata');
    // Only the first two fixtures are the saved row (unknown ID and matching ID).
    // Local IDB ids remain untouched, and every other full row must be identical.
    const expected = before.map((row, index) => index === firstNewRow || index === firstNewRow + 1
        ? { ...row, content: '', message_id: 71 } : row);
    const writing = cache.replaceCachedAnswer('run-owned', '', 'shared-cache', 'chat-owned', 71);
    cache.setMessageScope('elsewhere'); await writing;
    assert.deepEqual(port.rows, expected);
    await cache.replaceCachedAnswer('run-owned', 'different ID', 'shared-cache', 'chat-owned', 999);
    assert.deepEqual(port.rows, expected);
});

test('session-only corrections preserve existing IDs and never stamp unknown rows', async () => {
    const firstNewRow = port.rows.length;
    const base = { scope: 'session-only', role: 'assistant', content: 'original', timestamp: 11, trace_run_id: 'run-session' };
    await cache.upsertMessage({ ...base, session_id: 'chat-owned', message_id: 81 });
    await cache.upsertMessage({ ...base, session_id: 'chat-owned', message_id: 'browser-id' });
    await cache.upsertMessage(base);
    await cache.upsertMessage({ ...base, session_id: 'other-chat' });
    const before = structuredClone(port.rows);
    await cache.replaceCachedAnswer('run-session', 'session only', 'session-only', 'chat-owned');
    assert.deepEqual(port.rows, before.map((row, index) => index === firstNewRow || index === firstNewRow + 1
        ? { ...row, content: 'session only' } : row));
    const after = structuredClone(port.rows);
    await cache.replaceCachedAnswer('run-session', 'must not infer', 'session-only', '');
    assert.deepEqual(port.rows, after, 'even an empty explicit session is not a legacy three-argument call');
});

test('nonpositive and noninteger saved IDs cannot overwrite cached identity', async () => {
    await cache.upsertMessage({ scope: 'invalid-id', session_id: 'chat', role: 'assistant', content: 'original',
        trace_run_id: 'run-invalid-id', timestamp: 11 });
    for (const id of [0, -1, 1.5, NaN, Infinity]) {
        await cache.replaceCachedAnswer('run-invalid-id', 'corrected', 'invalid-id', 'chat', id);
        const [row] = await cache.getScopedMessages('invalid-id');
        assert.equal(row?.message_id, undefined);
        assert.equal(row?.session_id, 'chat');
    }
});
