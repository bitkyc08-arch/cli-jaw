import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createChatSession, deleteChatSession, forkChatSession, setActiveChatSession } from '../../src/core/chat-sessions.js';
import { db, insertMessageWithTraceRun } from '../../src/core/db.js';
import { appendTraceEvent, finalizeTraceRun, getTraceRun, linkTraceRunToMessage, startTraceRun } from '../../src/trace/store.js';
import { recordRuntimeEvent, type RuntimeEventContext } from '../../src/agent/runtime/events.js';
import type { RuntimeEventBody } from '../../src/shared/runtime-contract.js';

// Keep real SQLite ownership/replay; inject only a repository failure at its public seam.
const journal = await import('../../src/trace/activity-journal.js');
let storageFailure = false;
mock.module('../../src/trace/activity-journal.js', {
    namedExports: {
        ...journal,
        listActivityRuns: (...args: Parameters<typeof journal.listActivityRuns>) => {
            if (storageFailure) throw new Error('private fixture storage path');
            return journal.listActivityRuns(...args);
        },
        readActivityPage: (...args: Parameters<typeof journal.readActivityPage>) => {
            if (storageFailure) throw new Error('private fixture storage path');
            return journal.readActivityPage(...args);
        },
    },
});
const { registerTraceRoutes } = await import('../../src/routes/traces.js');

type Auth = (req: Request, res: Response, next: NextFunction) => void;

async function readResponse(base: string, path: string, status = 200) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(3_000) });
    assert.equal(response.status, status, path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
    const body = await response.json();
    assert.equal(body.ok, status === 200, path);
    return body;
}

async function withServer(
    fn: (get: (path: string, status?: number) => ReturnType<typeof readResponse>) => Promise<void>,
    auth: Auth = (_req, _res, next) => next(),
): Promise<void> {
    const app = express();
    app.set('query parser', 'extended');
    registerTraceRoutes(app, auth);
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        await fn((path, status = 200) => readResponse(`http://127.0.0.1:${address.port}/api/traces`, path, status));
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        setActiveChatSession('default');
    }
}

function ownedRun(sessionId = createChatSession('activity-route-owner').id, audience: 'public' | 'internal' = 'public') {
    const scope = `mention-watch:route:${sessionId}`;
    const runId = startTraceRun({ cli: 'codex', sessionId, scopeKey: scope, audience });
    const context: RuntimeEventContext = { runId, sessionId, scope, turnId: 'route-turn', audience };
    const emit = (body: RuntimeEventBody) => {
        const event = recordRuntimeEvent(context, body);
        assert.ok(event, `record ${body.kind}`);
        return event;
    };
    const start = emit({ kind: 'turn-start', provider: 'codex' });
    return { runId, sessionId, scope, emit, start };
}

test('Activity uses owned persisted events, fixed through cursors and exact envelopes', { timeout: 15_000 }, async () => {
    const run = ownedRun();
    assert.ok(journal.getActivityOwner(run.runId, run.sessionId));
    assert.equal(journal.getActivityOwner(run.runId, 'wrong-owner'), null);
    appendTraceEvent({ runId: run.runId, source: 'cli_raw', eventType: 'gap', raw: { diagnostic: true } });
    const message = run.emit({ kind: 'message', itemId: 'answer', phase: 'final', text: 'original answer', operation: 'replace' });
    const path = `/${run.runId}/activity?session=${run.sessionId}`;
    await withServer(async get => {
        const first = (await get(path + '&limit=1')).data;
        assert.deepEqual(Object.keys(first).sort(), [
            'runId', 'sessionId', 'scope', 'status', 'events', 'nextAfter', 'through', 'hasMore', 'incomplete', 'loss',
        ].sort());
        assert.equal(first.runId, run.runId);
        assert.equal(first.sessionId, run.sessionId);
        assert.equal(first.scope, run.scope);
        assert.equal(first.status, 'running');
        assert.equal(first.through, message.seq);
        assert.equal(first.nextAfter, run.start.seq);
        assert.equal(first.hasMore, true);
        assert.equal(first.incomplete, false);
        assert.equal(first.loss, null);
        assert.equal(first.events.length, 1);
        assert.equal(first.events[0].kind, 'turn-start');

        const end = run.emit({ kind: 'turn-end', status: 'done', finalText: '' });
        finalizeTraceRun(run.runId, 'done');
        const second = (await get(path + `&after=${first.nextAfter}&through=${first.through}&limit=1`)).data;
        assert.equal(second.through, first.through);
        assert.equal(second.nextAfter, message.seq);
        assert.equal(second.hasMore, false);
        assert.deepEqual(second.events.map((event: { kind: string; text?: string }) => [event.kind, event.text]),
            [['message', 'original answer']]);
        const tail = (await get(path + `&after=${first.through}`)).data;
        assert.equal(tail.status, 'done');
        assert.equal(tail.through, end.seq);
        assert.equal(tail.hasMore, false);
        assert.equal(tail.incomplete, false);
        assert.equal(tail.events[0].finalText, '');
        assert.equal(tail.events[0].kind, 'turn-end');
        assert.equal(tail.events[0].sessionId, run.sessionId);
        assert.equal(tail.events[0].scope, run.scope);
        const empty = (await get(path + `&after=${end.seq}&through=${end.seq}`)).data;
        assert.deepEqual(empty.events, []);
        assert.equal(empty.nextAfter, end.seq);
        assert.equal(empty.hasMore, false);
        for (const query of [`&after=${end.seq + 1}`, `&through=${end.seq + 1}`, `&after=${end.seq}&through=${message.seq}`]) {
            assert.deepEqual(await get(path + query, 409), { ok: false, error: 'activity_resync_required' });
        }
    });
});

test('Activity rejects malformed, repeated, nested, unknown and unsafe query values', { timeout: 15_000 }, async () => {
    const run = ownedRun();
    await withServer(async get => {
        for (const suffix of ['/activity-runs', `/${run.runId}/activity`]) {
            for (const query of ['', '?session=', '?session=a&session=b', '?session[]=a', '?session[x]=a',
                '?session=' + 'x'.repeat(241), `?session=${run.sessionId}&unknown=1`, `?session=${run.sessionId}&scope=x`]) {
                assert.deepEqual(await get(suffix + query, 400), { ok: false, error: 'invalid_activity_query' });
            }
        }
        for (const field of ['after', 'through', 'limit']) {
            for (const value of ['', '-1', '+1', '1.5', '1e2', '0x10', 'Infinity', 'NaN', '9007199254740992', ' 1']) {
                await get(`/${run.runId}/activity?session=${run.sessionId}&${field}=${encodeURIComponent(value)}`, 400);
            }
            for (const query of [`${field}=1&${field}=2`, `${field}[]=1`, `${field}[x]=1`]) {
                await get(`/${run.runId}/activity?session=${run.sessionId}&${query}`, 400);
            }
        }
        for (const limit of ['0', '41']) await get(`/${run.runId}/activity?session=${run.sessionId}&limit=${limit}`, 400);
        for (const badRun of ['bad', 'tr_short', 'tr_' + 'a'.repeat(81), 'tr_abcdefghijklmnop!']) {
            await get(`/${badRun}/activity?session=${run.sessionId}`, 400);
            await get(`/activity-runs?session=${run.sessionId}&after=${badRun}`, 400);
        }
        for (const query of ['after=a&after=b', 'after[]=x', 'after[x]=x', 'limit=40', 'through=0']) {
            await get(`/activity-runs?session=${run.sessionId}&${query}`, 400);
        }
        // Decimal leading zeroes and an explicitly empty discovery cursor are valid.
        await get(`/${run.runId}/activity?session=${run.sessionId}&after=00&limit=01`);
        await get(`/activity-runs?session=${run.sessionId}&after=`);
        await get('/tr_abcdefghijklmnop/activity?session=unknown', 404);
        await get('/tr_' + 'a'.repeat(80) + '/activity?session=unknown', 404);
    });
});

test('Activity denies wrong, internal, missing, forked and deleted owners', { timeout: 15_000 }, async () => {
    const run = ownedRun();
    const wrong = createChatSession('other-owner').id;
    const internal = ownedRun(run.sessionId, 'internal');
    const orphan = ownedRun();
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(orphan.sessionId);
    assert.ok(getTraceRun(orphan.runId));
    const messageId = Number(insertMessageWithTraceRun.run('assistant', 'fork source', 'codex', '', null, null, '', run.runId, run.sessionId).lastInsertRowid);
    linkTraceRunToMessage(run.runId, messageId);
    const fork = forkChatSession(run.sessionId);
    assert.equal(fork.copiedCount, 1);
    await withServer(async get => {
        for (const [runId, sessionId] of [[run.runId, wrong], [run.runId, fork.id], [run.runId, 'missing-session'],
            [internal.runId, run.sessionId], [orphan.runId, orphan.sessionId]]) {
            assert.deepEqual(await get(`/${runId}/activity?session=${sessionId}`, 404), { ok: false, error: 'trace_not_found' });
        }
        for (const suffix of ['', '/events', `/events/${orphan.start.seq}`]) {
            await get(`/${orphan.runId}${suffix}?session=${orphan.sessionId}`, 404);
        }
        assert.deepEqual((await get(`/activity-runs?session=${fork.id}`)).data, { runs: [], pageSize: 40 });
        assert.deepEqual((await get('/activity-runs?session=missing-session')).data, { runs: [], pageSize: 40 });
        assert.equal(deleteChatSession(run.sessionId), true);
        await get(`/${run.runId}/activity?session=${run.sessionId}`, 404);
        assert.deepEqual((await get(`/activity-runs?session=${run.sessionId}`)).data.runs, []);
    });
});

test('all raw reads fence either owner column while preserving truly ownerless legacy access', { timeout: 15_000 }, async () => {
    const run = ownedRun();
    const raw = appendTraceEvent({ runId: run.runId, source: 'cli_raw', eventType: 'raw', raw: { text: 'owned detail' } });
    assert.ok(raw);
    const sessionOnly = startTraceRun({ cli: 'codex', sessionId: run.sessionId });
    const scopeOnly = startTraceRun({ cli: 'codex', scopeKey: run.scope });
    const legacy = startTraceRun({ cli: 'codex' });
    const internal = startTraceRun({ cli: 'codex', audience: 'internal' });
    for (const runId of [sessionOnly, scopeOnly, legacy, internal]) {
        assert.ok(appendTraceEvent({ runId, source: 'cli_raw', eventType: 'raw', raw: { text: 'raw detail' } }));
    }
    assert.equal(journal.getActivityOwner(sessionOnly, run.sessionId), null);
    const fork = forkChatSession(run.sessionId);
    await withServer(async get => {
        for (const [runId, seq] of [[run.runId, raw.traceSeq], [sessionOnly, 1]] as const) {
            for (const suffix of ['', '/events', `/events/${seq}`]) {
                for (const query of ['', '?session=', '?session=wrong', `?session=${fork.id}`,
                    `?session=${run.sessionId}&session=${run.sessionId}`, `?session[]=${run.sessionId}`,
                    `?session[x]=${run.sessionId}`, `?scope=${run.scope}`, `?session=${run.sessionId}%20`]) {
                    await get(`/${runId}${suffix}${query}`, 404);
                }
                await get(`/${runId}${suffix}?session=${run.sessionId}`);
            }
        }
        for (const suffix of ['', '/events', '/events/1']) {
            await get(`/${scopeOnly}${suffix}?session=${run.sessionId}`, 404);
            await get(`/${internal}${suffix}?session=${run.sessionId}`, 404);
            await get(`/${legacy}${suffix}`);
            await get(`/${legacy}${suffix}?session[]=ignored`);
        }
        await get(`/${sessionOnly}/activity?session=${run.sessionId}`, 404);
        await get(`/${legacy}/activity?session=${run.sessionId}`, 404);
        await get(`/${run.runId}/events/invalid?session=${run.sessionId}`, 400);
        await get(`/${run.runId}/events/999999?session=${run.sessionId}`, 404);
        assert.equal(deleteChatSession(run.sessionId), true);
        for (const suffix of ['', '/events', `/events/${raw.traceSeq}`]) await get(`/${run.runId}${suffix}?session=${run.sessionId}`, 404);
    });
});

test('Activity event pages default to forty and preserve the cursor across pages', { timeout: 15_000 }, async () => {
    const run = ownedRun();
    for (let index = 0; index < 40; index++) {
        run.emit({ kind: 'message', itemId: `item-${index}`, phase: 'unknown', text: `text-${index}`, operation: 'replace' });
    }
    run.emit({ kind: 'turn-end', status: 'done', finalText: null });
    finalizeTraceRun(run.runId, 'done');
    await withServer(async get => {
        const path = `/${run.runId}/activity?session=${run.sessionId}`;
        const first = await get(path);
        assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 256 * 1024);
        assert.equal(first.data.events.length, 40);
        assert.equal(first.data.hasMore, true);
        const last = (await get(path + `&after=${first.data.nextAfter}&through=${first.data.through}`)).data;
        assert.equal(last.events.length, 2);
        assert.equal(last.events[0].text, 'text-39');
        assert.equal(last.events[1].kind, 'turn-end');
        assert.equal(last.events[1].finalText, null);
        assert.equal(last.nextAfter, first.data.through);
        assert.equal(last.hasMore, false);
        assert.equal(last.incomplete, false);
    });
});

test('literal discovery returns only owned public runs in stable forty-run pages with summary fields', { timeout: 15_000 }, async () => {
    const sessionId = createChatSession('discovery-owner').id;
    const expected = [];
    for (let index = 0; index < 42; index++) {
        const run = ownedRun(sessionId);
        const messageId = Number(insertMessageWithTraceRun.run('assistant', `answer-${index}`, 'codex', '', null, null, '', run.runId, sessionId).lastInsertRowid);
        linkTraceRunToMessage(run.runId, messageId);
        run.emit({ kind: 'turn-end', status: 'done', finalText: `answer-${index}` });
        finalizeTraceRun(run.runId, 'done');
        expected.push({ id: run.runId, messageId, status: 'done', startedAt: getTraceRun(run.runId)!.started_at });
    }
    expected.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    ownedRun(sessionId, 'internal');
    ownedRun();
    startTraceRun({ cli: 'codex', sessionId });
    startTraceRun({ cli: 'codex' });
    await withServer(async get => {
        const first = await get(`/activity-runs?session=${sessionId}`);
        assert.deepEqual(first, { ok: true, data: { runs: expected.slice(0, 40), pageSize: 40 } });
        const last = await get(`/activity-runs?session=${sessionId}&after=${first.data.runs[39].id}`);
        assert.deepEqual(last.data, { runs: expected.slice(40), pageSize: 40 });
        assert.deepEqual((await get(`/activity-runs?session=${sessionId}&after=${last.data.runs[1].id}`)).data,
            { runs: [], pageSize: 40 });
    });
});

test('Activity storage failures are no-store 503 envelopes without private error details', { timeout: 10_000 }, async () => {
    const run = ownedRun();
    storageFailure = true;
    try {
        await withServer(async get => {
            for (const path of [`/activity-runs?session=${run.sessionId}`, `/${run.runId}/activity?session=${run.sessionId}`]) {
                assert.deepEqual(await get(path, 503), { ok: false, error: 'activity_unavailable' });
            }
        });
    } finally {
        storageFailure = false;
    }
});

test('every trace route invokes the supplied auth middleware after setting no-store', { timeout: 10_000 }, async () => {
    let calls = 0;
    const runId = 'tr_abcdefghijklmnop';
    await withServer(async get => {
        for (const path of ['/activity-runs?session=owner', `/${runId}/activity?session=owner`, `/${runId}`, `/${runId}/events`, `/${runId}/events/1`]) {
            assert.deepEqual(await get(path, 401), { ok: false, error: 'fixture_auth_required' });
        }
    }, (_req, res) => {
        calls++;
        res.status(401).json({ ok: false, error: 'fixture_auth_required' });
    });
    assert.equal(calls, 5);
});
