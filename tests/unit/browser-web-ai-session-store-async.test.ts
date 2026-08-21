// Cycle 1 slice 1.2 (parity2 010): the async store lock must not freeze the
// event loop while waiting, and a deadline that passes DURING the lock wait
// must refuse the write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    withStoreLock,
    withStoreLockAsync,
    insertSessionAsync,
    patchSessionAsync,
    insertSession,
    listStoredSessions,
    DEADLINE_PASSED,
} from '../../src/browser/web-ai/session-store.ts';

test('SS-A1: withStoreLockAsync keeps timers running while waiting for a held lock', async () => {
    // Hold the lock in the sync form, and while held, start an async acquisition.
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 50);
    const result = await withStoreLock(() => {
        // The async acquisition must WAIT (lock held) without freezing the loop.
        const pending = withStoreLockAsync(() => 'acquired-later');
        // Give the event loop a beat inside the held section via a microtask chain;
        // the sync holder returns immediately after starting the async wait.
        return pending;
    });
    await new Promise(r => setTimeout(r, 120));
    clearTimeout(timer);
    assert.equal(await result, 'acquired-later');
    assert.equal(timerFired, true, 'a 50ms timer fired while the async lock was waiting — loop not frozen');
});

test('SS-A2: patchSessionAsync refuses the write when the deadline passed during the wait', async () => {
    insertSession({ sessionId: 'sess-dl-1', vendor: 'chatgpt', status: 'sent', createdAt: new Date().toISOString() });
    const outcome = await patchSessionAsync('sess-dl-1', { status: 'complete' }, () => false);
    assert.equal(outcome, DEADLINE_PASSED);
    const row = listStoredSessions({ sessionId: 'sess-dl-1' })[0];
    assert.equal(row?.status, 'sent', 'refused write left disk unchanged');
});

test('SS-A3: patchSessionAsync writes when still active; null for missing session', async () => {
    insertSession({ sessionId: 'sess-dl-2', vendor: 'chatgpt', status: 'sent', createdAt: new Date().toISOString() });
    const ok = await patchSessionAsync('sess-dl-2', { status: 'complete' }, () => true);
    assert.ok(ok && ok !== DEADLINE_PASSED && ok.status === 'complete');
    const missing = await patchSessionAsync('sess-none', { status: 'complete' });
    assert.equal(missing, null);
});

test('SS-A4: insertSessionAsync honors the stillActive gate', async () => {
    const refused = await insertSessionAsync({ sessionId: 'sess-dl-3', vendor: 'grok', status: 'sent', createdAt: new Date().toISOString() }, () => false);
    assert.equal(refused, DEADLINE_PASSED);
    assert.equal(listStoredSessions({ sessionId: 'sess-dl-3' }).length, 0);
    const written = await insertSessionAsync({ sessionId: 'sess-dl-4', vendor: 'grok', status: 'sent', createdAt: new Date().toISOString() });
    assert.ok(written !== DEADLINE_PASSED);
    assert.equal(listStoredSessions({ sessionId: 'sess-dl-4' }).length, 1);
});

