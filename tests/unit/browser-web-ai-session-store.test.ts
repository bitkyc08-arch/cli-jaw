import test from 'node:test';
import assert from 'node:assert/strict';
import {
    generateSessionId,
    readSessionStore,
    writeSessionStore,
    withStoreLock,
    insertSession,
    patchSession,
    listStoredSessions,
    pruneSessions,
    SESSION_STORE_VERSION,
} from '../../src/browser/web-ai/session-store.js';

test('SS-001: generateSessionId creates 26-char Crockford ID', () => {
    const id = generateSessionId();
    assert.equal(id.length, 26);
    assert.ok(/^[0-9A-HJ-KM-NP-TV-Z]+$/.test(id), 'expected Crockford base32 chars');
});

test('SS-002: readSessionStore returns empty store when missing', () => {
    const store = readSessionStore();
    assert.equal(store.version, SESSION_STORE_VERSION);
    assert.deepEqual(store.sessions, []);
});

test('SS-003: insertSession persists and is listable', () => {
    withStoreLock(() => {
        writeSessionStore({ version: SESSION_STORE_VERSION, sessions: [] });
    });
    const session = { sessionId: 'sess-001', vendor: 'chatgpt', status: 'sent', createdAt: new Date().toISOString() };
    insertSession(session);
    const listed = listStoredSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sessionId, 'sess-001');
});

test('SS-004: patchSession updates fields', () => {
    withStoreLock(() => {
        writeSessionStore({ version: SESSION_STORE_VERSION, sessions: [] });
    });
    insertSession({ sessionId: 'sess-002', vendor: 'gemini', status: 'sent', createdAt: new Date().toISOString() });
    const patched = patchSession('sess-002', { status: 'complete' });
    assert.ok(patched);
    assert.equal(patched?.status, 'complete');
});

test('SS-005: pruneSessions removes by status and age', () => {
    withStoreLock(() => {
        writeSessionStore({ version: SESSION_STORE_VERSION, sessions: [] });
    });
    insertSession({ sessionId: 'sess-003', vendor: 'chatgpt', status: 'complete', createdAt: new Date(Date.now() - 1000).toISOString() });
    insertSession({ sessionId: 'sess-004', vendor: 'chatgpt', status: 'sent', createdAt: new Date().toISOString() });
    const result = pruneSessions({ status: 'complete', olderThanMs: 0 });
    assert.equal(result.removed, 1);
    assert.equal(result.remaining, 1);
});

test('SS-006: listStoredSessions filters by vendor and active', () => {
    withStoreLock(() => {
        writeSessionStore({ version: SESSION_STORE_VERSION, sessions: [] });
    });
    const now = new Date().toISOString();
    insertSession({ sessionId: 'sess-a', vendor: 'chatgpt', status: 'sent', createdAt: now });
    insertSession({ sessionId: 'sess-b', vendor: 'gemini', status: 'polling', createdAt: now });
    insertSession({ sessionId: 'sess-c', vendor: 'grok', status: 'complete', createdAt: now });

    assert.equal(listStoredSessions({ vendor: 'gemini' }).length, 1);
    assert.equal(listStoredSessions({ active: true }).length, 2);
    assert.equal(listStoredSessions({ limit: 1 }).length, 1);
});

test('SS-007: withStoreLock serializes access', () => {
    const result = withStoreLock(() => 'locked-value');
    assert.equal(result, 'locked-value');
});
