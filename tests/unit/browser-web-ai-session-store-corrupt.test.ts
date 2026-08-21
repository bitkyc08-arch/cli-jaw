// Cycle 1 slices 1.3 + 1.4 (parity2 010): corrupt store observed, env grammar strict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
    readSessionStore,
    readSessionStoreObserved,
    assertStoreReadable,
    insertSession,
    storePath,
} from '../../src/browser/web-ai/session-store.ts';

function corruptStore(): void {
    const p = storePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '{ not json !!!', 'utf8');
}

test('SS-C1: corrupt store read is observed, not silently collapsed', () => {
    corruptStore();
    const { store, storeReadFailed } = readSessionStoreObserved();
    assert.equal(store.sessions.length, 0);
    assert.ok(storeReadFailed, 'marker set');
    assert.ok(storeReadFailed!.path.length > 0);
    // legacy read shape still returns the empty store for read-only callers
    assert.equal(readSessionStore().sessions.length, 0);
});

test('SS-C2: write path throws session-store-read-failed over a corrupt store', () => {
    corruptStore();
    assert.throws(() => assertStoreReadable(), /session store unreadable/);
    assert.throws(
        () => insertSession({ sessionId: 'sess-corrupt-1', vendor: 'chatgpt', status: 'sent', createdAt: new Date().toISOString() }),
        (err: unknown) => (err as { errorCode?: string }).errorCode === 'session-store-read-failed',
    );
    // disk unchanged: the corrupt payload was not overwritten with an empty store
    const { storeReadFailed } = readSessionStoreObserved();
    assert.ok(storeReadFailed, 'corrupt file still present, not clobbered');
});

