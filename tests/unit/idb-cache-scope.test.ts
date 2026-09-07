// IndexedDB cache writers must be scope-isolated.
// The read path uses the 'scope' index, so a global store.clear() in the
// writer silently erased every other scope's offline fallback on each load.
// Static source contracts, same pattern as web-refresh-state-recovery.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const cacheSrc = readFileSync(join(root, 'public/js/features/idb-cache.ts'), 'utf8');

function exportedBlock(name: string): string {
    const start = cacheSrc.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, `${name} must exist in idb-cache.ts`);
    const next = cacheSrc.indexOf('export async function', start + 1);
    return cacheSrc.slice(start, next === -1 ? cacheSrc.length : next);
}

test('ICS-001: cacheMessages replaces only the current scope', () => {
    const block = exportedBlock('cacheMessages');
    assert.ok(!block.includes('store.clear()'),
        'cacheMessages must not clear the whole store — that erases other scopes');
    assert.ok(block.includes("index('scope')"), 'scoped delete must go through the scope index');
    assert.ok(block.includes('IDBKeyRange.only'), 'scoped delete must target exactly the current scope');
    assert.ok(block.includes('cursor.delete()'), 'stale rows of the current scope are removed via cursor');
});

test('ICS-002: cacheMessages writes rows under the current scope', () => {
    const block = exportedBlock('cacheMessages');
    assert.ok(block.includes('scope: targetScope') || block.includes('scope: currentScope'),
        'cached rows must carry the scope used by scoped reads');
});

test('ICS-003: appendCachedMessage is not an unscoped writer', () => {
    const block = exportedBlock('appendCachedMessage');
    assert.ok(block.includes('scope: currentScope'),
        'append writer must stamp the scope or scoped reads will never see its rows');
});

test('ICS-004: upsertMessage captures its scope before a pending database open', async () => {
    // Same browser-port seam as web-activity-cache-settlement; no source-shape oracle.
    const rows: Record<string, unknown>[] = [];
    const names = ['indexedDB', 'localStorage'] as const;
    const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const values = new Map<string, string>();
    const database = { transaction() {
        const tx = { oncomplete: null as (() => void) | null, onerror: null as (() => void) | null,
            objectStore: () => ({ add(row: Record<string, unknown>) {
                rows.push(structuredClone(row));
                queueMicrotask(() => tx.oncomplete?.());
            } }),
        };
        return tx;
    } };
    const open = { result: database, onsuccess: null as (() => void) | null };
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open: () => open } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    } });
    try {
        const cache = await import('../../public/js/features/idb-cache.ts');
        cache.setMessageScope('before-open');
        const pending = cache.upsertMessage({ role: 'assistant', content: 'answer', timestamp: 1 });
        const explicit = cache.upsertMessage({ role: 'assistant', content: 'explicit', timestamp: 2, scope: 'caller-captured' });
        cache.setMessageScope('after-open');
        assert.deepEqual(rows, [], 'the open request is still pending');
        assert.ok(open.onsuccess);
        open.onsuccess();
        await Promise.all([pending, explicit]);
        assert.deepEqual(rows.map(row => [row['content'], row['scope']]), [
            ['answer', 'before-open'], ['explicit', 'caller-captured'],
        ]);
        assert.ok(rows.every(row => !Object.hasOwn(row, 'session_id')));
    } finally {
        for (const name of names) {
            const descriptor = originals.get(name);
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});

test('ICS-005: clearCache remains the only deliberate full reset', () => {
    const block = exportedBlock('clearCache');
    assert.ok(block.includes('.clear()'), 'clearCache is the explicit full-reset API and may stay global');
});
