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
