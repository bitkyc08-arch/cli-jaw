// devlog 260609 79/82 — IndexedDB cache writers must be scope-isolated.
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

// ICS-004 is exercised by actual scoped writers and a scope-switch race in
// activity-cache-link.test.ts and web-activity-cache-settlement.test.ts.

test('ICS-005: clearCache remains the only deliberate full reset', () => {
    const block = exportedBlock('clearCache');
    assert.ok(block.includes('.clear()'), 'clearCache is the explicit full-reset API and may stay global');
});
