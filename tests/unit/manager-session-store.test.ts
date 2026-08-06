import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getSessionListenerCountForTest,
    getSessionSnapshot,
    loadSessions,
    resetSessionStoreForTest,
    retrySessions,
    subscribeSessions,
    switchSession,
} from '../../public/manager/src/lib/session-store.ts';

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function sessionsResponse(ids: string[]): Response {
    return Response.json({
        ok: true,
        data: {
            sessions: ids.map((id, seq) => ({ id, seq, label: null, message_count: seq })),
            active: ids[0] ?? 'default',
        },
    });
}

test.afterEach(() => resetSessionStoreForTest());

test('dedupes one session GET shared by two subscribers', async () => {
    let calls = 0;
    resetSessionStoreForTest({ fetchImpl: (async () => { calls++; return sessionsResponse(['a']); }) as typeof fetch });
    const unsubscribeA = subscribeSessions(3457, () => {});
    const unsubscribeB = subscribeSessions(3457, () => {});
    await Promise.all([loadSessions(3457), loadSessions(3457)]);
    assert.equal(calls, 1);
    unsubscribeA();
    unsubscribeB();
});

test('refetches after TTL and immediately evicts rejected promises', async () => {
    let now = 10_000;
    let calls = 0;
    resetSessionStoreForTest({
        now: () => now,
        fetchImpl: (async () => {
            calls++;
            if (calls === 2) throw new Error('offline');
            return sessionsResponse([`session-${calls}`]);
        }) as typeof fetch,
    });
    await loadSessions(3457);
    await loadSessions(3457);
    assert.equal(calls, 1, 'fresh successful data uses the 2s TTL');
    now += 2_001;
    await assert.rejects(loadSessions(3457), /offline/);
    await loadSessions(3457);
    assert.equal(calls, 3, 'a rejected promise is not cached');
});

test('discards a stale GET after switch invalidates its generation', async () => {
    const oldGet = deferred<Response>();
    const calls: string[] = [];
    resetSessionStoreForTest({ fetchImpl: (async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
        if ((init?.method ?? 'GET') === 'POST') return new Response(null, { status: 200 });
        if (calls.length === 1) return oldGet.promise;
        return sessionsResponse(['fresh']);
    }) as typeof fetch });
    const staleLoad = loadSessions(3457);
    await switchSession(3457, 2);
    oldGet.resolve(sessionsResponse(['stale']));
    await staleLoad;
    assert.equal(getSessionSnapshot(3457).data?.sessions[0]?.id, 'fresh');
});

test('uses one shared port lock for concurrent switches', async () => {
    let posts = 0;
    resetSessionStoreForTest({ fetchImpl: (async (_url, init) => {
        if (init?.method === 'POST') posts++;
        return init?.method === 'POST' ? new Response(null, { status: 200 }) : sessionsResponse(['a']);
    }) as typeof fetch });
    await Promise.all([switchSession(3457, 1), switchSession(3457, 1)]);
    assert.equal(posts, 1);
});

test('notifies both subscribers after a successful switch', async () => {
    let gets = 0;
    resetSessionStoreForTest({ fetchImpl: (async (_url, init) => {
        if (init?.method === 'POST') return new Response(null, { status: 200 });
        gets++;
        return sessionsResponse([gets === 1 ? 'before' : 'after']);
    }) as typeof fetch });
    await loadSessions(3457);
    let notificationsA = 0;
    let notificationsB = 0;
    const unsubscribeA = subscribeSessions(3457, () => { notificationsA++; });
    const unsubscribeB = subscribeSessions(3457, () => { notificationsB++; });
    await switchSession(3457, 1);
    assert.ok(notificationsA > 0);
    assert.equal(notificationsA, notificationsB);
    assert.equal(gets, 2, 'switch invalidation bypasses a warm GET cache');
    assert.equal(getSessionSnapshot(3457).data?.sessions[0]?.id, 'after');
    unsubscribeA();
    unsubscribeB();
});

test('keeps session data independent per port', async () => {
    resetSessionStoreForTest({ fetchImpl: (async url => sessionsResponse([String(url).includes('/3457/') ? 'a' : 'b'])) as typeof fetch });
    await Promise.all([loadSessions(3457), loadSessions(3458)]);
    assert.equal(getSessionSnapshot(3457).data?.sessions[0]?.id, 'a');
    assert.equal(getSessionSnapshot(3458).data?.sessions[0]?.id, 'b');
});

test('reconstructs failed load and switch retries', async () => {
    const calls: string[] = [];
    let failGet = true;
    resetSessionStoreForTest({ fetchImpl: (async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
        if (init?.method === 'POST') return new Response(null, { status: 200 });
        if (failGet) { failGet = false; throw new Error('load failed'); }
        return sessionsResponse(['a']);
    }) as typeof fetch });
    await assert.rejects(loadSessions(3457), /load failed/);
    await retrySessions(3457);
    assert.equal(calls.filter(call => call.startsWith('GET')).length, 2);

    calls.length = 0;
    let failPost = true;
    resetSessionStoreForTest({ fetchImpl: (async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
        if (init?.method === 'POST' && failPost) {
            failPost = false;
            return Response.json({ error: 'switch failed' }, { status: 503 });
        }
        return init?.method === 'POST' ? new Response(null, { status: 200 }) : sessionsResponse(['a']);
    }) as typeof fetch });
    await assert.rejects(switchSession(3457, 2), /switch failed/);
    await retrySessions(3457);
    assert.equal(calls.filter(call => call.includes('/2/switch')).length, 2);
});

test('keeps snapshots referentially stable until a store commit', async () => {
    resetSessionStoreForTest({ fetchImpl: (async () => sessionsResponse(['a'])) as typeof fetch });
    const initial = getSessionSnapshot(3457);
    assert.equal(getSessionSnapshot(3457), initial);
    let notifications = 0;
    const unsubscribe = subscribeSessions(3457, () => { notifications++; });
    await loadSessions(3457);
    const committed = getSessionSnapshot(3457);
    assert.notEqual(committed, initial);
    assert.ok(notifications > 0);
    await loadSessions(3457);
    assert.equal(getSessionSnapshot(3457), committed, 'TTL hit does not commit');
    unsubscribe();
});

test('exposes the loaded session count in the snapshot', async () => {
    resetSessionStoreForTest({ fetchImpl: (async () => sessionsResponse(['a', 'b', 'c'])) as typeof fetch });
    await loadSessions(3457);
    assert.equal(getSessionSnapshot(3457).count, 3);
});

test('hands listeners off when a port-bound subscription changes', () => {
    const callback = () => {};
    const unsubscribeOld = subscribeSessions(3457, callback);
    assert.equal(getSessionListenerCountForTest(3457), 1);
    unsubscribeOld();
    const unsubscribeNew = subscribeSessions(3458, callback);
    assert.equal(getSessionListenerCountForTest(3457), 0);
    assert.equal(getSessionListenerCountForTest(3458), 1);
    unsubscribeNew();
});
