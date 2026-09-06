import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import * as database from '../../src/core/db.ts';
import { createChatSession, deleteChatSession, forkChatSession, setActiveChatSession } from '../../src/core/chat-sessions.ts';
import { startTraceRun, getTraceRun } from '../../src/trace/store.ts';
import { recordRuntimeEvent } from '../../src/agent/runtime/events.ts';
import { registerMessageRoutes } from '../../src/routes/messages.ts';
import { registerTraceRoutes } from '../../src/routes/traces.ts';

// Independent expected limit from241's public wire contract, not from the DUT.
const CAP = 16 * 1024 * 1024;
const { db, insertMessageWithTraceRun } = database;
type Auth = (req: Request, res: Response, next: NextFunction) => void;
type Answer = { id: number; role: 'assistant'; content: string; trace_run_id: string; session_id: string };
type ApiBody = { ok: boolean; data?: { message: Answer | null }; error?: string };

function fixture() {
    const sessionId = createChatSession('saved-answer-owner').id;
    const runId = startTraceRun({ cli: 'fixture', sessionId, scopeKey: 'historical:custom' });
    const insert = (content: string, role = 'assistant', session = sessionId): Answer => {
        const id = Number(insertMessageWithTraceRun.run(role, content, 'fixture', '', 'RAW TRACE NOT IN DTO',
            '[{"label":"TOOL NOT IN DTO"}]', '', runId, session).lastInsertRowid);
        return { id, role: 'assistant', content, trace_run_id: runId, session_id: session };
    };
    return { sessionId, runId, insert, path: `/api/messages/by-trace/${runId}?session=${sessionId}` };
}

async function withServer(
    fn: (get: (path: string, status?: number) => Promise<{ body: ApiBody; text: string }>) => Promise<void>,
    auth: Auth = (_req, _res, next) => next(),
) {
    const app = express(); app.set('query parser', 'extended');
    registerMessageRoutes(app, auth); registerTraceRoutes(app, auth);
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    try {
        await fn(async (path, status = 200) => {
            const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { signal: AbortSignal.timeout(5000) });
            const text = await response.text();
            assert.equal(response.status, status, `${path}: ${text.slice(0, 180)}`);
            assert.equal(response.headers.get('cache-control'), 'no-store', path);
            assert.ok(Buffer.byteLength(text) <= CAP, 'actual response body obeys byte cap');
            return { body: JSON.parse(text), text };
        });
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        setActiveChatSession('default');
    }
}

test('unique saved answer is exact despite canonical redaction and missing reverse trace link', { timeout: 10000 }, async () => {
    const f = fixture();
    const original = 'Use Bearer fixture-token and PASSWORD=fixture-password\n' + '한글'.repeat(18000);
    const saved = f.insert(original);
    const context = { runId: f.runId, sessionId: f.sessionId, scope: 'historical:custom', turnId: f.runId, audience: 'public' as const };
    assert.ok(recordRuntimeEvent(context, { kind: 'turn-start', provider: 'fixture' }));
    const event = recordRuntimeEvent(context, { kind: 'message', itemId: 'preview', phase: 'unknown', operation: 'replace', text: 'Bearer fixture-token' });
    assert.ok(event?.kind === 'message'); assert.equal(event.text, 'Bearer [REDACTED]');
    assert.equal(getTraceRun(f.runId)?.message_id, null, 'saved forward pointer does not require reverse linkage');
    setActiveChatSession(createChatSession('unrelated-active').id);
    await withServer(async get => {
        assert.deepEqual((await get(f.path)).body, { ok: true, data: { message: saved } });
    });
});

test('empty saved value is present; missing/wrong-session and non-assistant rows are absent', { timeout: 10000 }, async () => {
    const f = fixture(); const saved = f.insert('');
    const other = fixture(); other.insert('user-only', 'user');
    await withServer(async get => {
        assert.deepEqual((await get(f.path)).body, { ok: true, data: { message: saved } });
        for (const path of [other.path, `/api/messages/by-trace/${f.runId}?session=missing-chat`,
            `/api/messages/by-trace/tr_missing1234567890?session=${f.sessionId}`]) {
            assert.deepEqual((await get(path)).body, { ok: true, data: { message: null } });
        }
    });
});

test('fork can read its own copied answer without acquiring original raw/journal ownership', { timeout: 10000 }, async () => {
    const f = fixture(); const saved = f.insert('ORIGINAL SAVED BODY');
    const fork = forkChatSession(f.sessionId);
    const row = db.prepare('SELECT id FROM messages WHERE session_id=? AND trace_run_id=?').get(fork.id, f.runId) as { id: number };
    assert.notEqual(row.id, saved.id);
    const path = `/api/messages/by-trace/${f.runId}?session=${fork.id}`;
    const expected = { ...saved, id: row.id, session_id: fork.id };
    await withServer(async get => {
        assert.deepEqual((await get(path)).body, { ok: true, data: { message: expected } });
        for (const suffix of ['', '/events', '/activity']) await get(`/api/traces/${f.runId}${suffix}?session=${fork.id}`, 404);
        assert.equal(deleteChatSession(f.sessionId), true);
        assert.deepEqual((await get(path)).body, { ok: true, data: { message: expected } });
        await get(`/api/traces/${f.runId}?session=${fork.id}`, 404);
    });
});

test('same-run multiple assistant rows are ambiguous; other sessions and roles do not count', { timeout: 10000 }, async () => {
    const f = fixture(); const saved = f.insert('FIRST');
    f.insert('USER', 'user'); f.insert('OTHER CHAT', 'assistant', createChatSession('other').id);
    await withServer(async get => {
        assert.deepEqual((await get(f.path)).body.data?.message, saved);
        f.insert('SECOND'); f.insert('THIRD');
        const result = await get(f.path, 409);
        assert.equal(result.body.ok, false); assert.equal(result.body.data, undefined);
        assert.doesNotMatch(result.text, /FIRST|SECOND|THIRD/);
        const rows = database.getSavedActivityAnswer.all({ runId: f.runId, sessionId: f.sessionId, maxBytes: CAP });
        assert.equal(rows.length, 2, 'actual prepared query retains only ambiguity witnesses');
    });
});

test('SQL guard excludes oversized UTF-8 content before JS and HTTP returns413', { timeout: 15000 }, async () => {
    const f = fixture(); const content = '가'.repeat(Math.floor(CAP / 3) + 1); f.insert(content);
    assert.ok(content.length < CAP && Buffer.byteLength(content) > CAP);
    const rows = database.getSavedActivityAnswer.all({ runId: f.runId, sessionId: f.sessionId, maxBytes: CAP }) as Array<{ content: string | null; content_bytes: number }>;
    assert.equal(rows.length, 1); assert.equal(rows[0]!.content, null); assert.equal(rows[0]!.content_bytes, Buffer.byteLength(content));
    await withServer(async get => {
        const result = await get(f.path, 413); assert.equal(result.body.ok, false); assert.equal(result.body.data, undefined);
    });
    db.prepare('DELETE FROM messages WHERE trace_run_id=?').run(f.runId);
});

test('serialized JSON expansion is rejected even when raw SQL bytes fit', { timeout: 15000 }, async () => {
    const f = fixture(); const content = '\u0000'.repeat(Math.floor(CAP / 6) + 1); f.insert(content);
    assert.ok(Buffer.byteLength(content) < CAP && Buffer.byteLength(JSON.stringify(content)) > CAP);
    await withServer(async get => {
        const result = await get(f.path, 413); assert.equal(result.body.ok, false); assert.equal(result.body.data, undefined);
    });
    db.prepare('DELETE FROM messages WHERE trace_run_id=?').run(f.runId);
});

test('exact serialized byte boundary succeeds untruncated and one extra byte fails', { timeout: 15000 }, async () => {
    const f = fixture(); const saved = f.insert('');
    const overhead = Buffer.byteLength(JSON.stringify({ ok: true, data: { message: saved } }));
    saved.content = 'x'.repeat(CAP - overhead);
    db.prepare('UPDATE messages SET content=? WHERE id=?').run(saved.content, saved.id);
    await withServer(async get => {
        const result = await get(f.path);
        assert.equal(Buffer.byteLength(result.text), CAP); assert.deepEqual(result.body.data?.message, saved);
        db.prepare('UPDATE messages SET content=content || ? WHERE id=?').run('x', saved.id);
        await get(f.path, 413);
    });
    db.prepare('DELETE FROM messages WHERE trace_run_id=?').run(f.runId);
});

test('malformed identities and query shapes never fall back to active chat', { timeout: 10000 }, async () => {
    const f = fixture(); f.insert('MUST NOT LEAK'); setActiveChatSession(f.sessionId);
    await withServer(async get => {
        for (const query of ['', '?session=', '?session=%20%20', '?session=' + 'x'.repeat(241),
            `?session=${f.sessionId}&session=${f.sessionId}`, `?session[]=${f.sessionId}`,
            `?session[x]=${f.sessionId}`, `?session=${f.sessionId}&extra=1`]) {
            const result = await get(`/api/messages/by-trace/${f.runId}${query}`, 400);
            assert.equal(result.body.ok, false); assert.doesNotMatch(result.text, /MUST NOT LEAK/);
        }
        for (const id of ['invalid', 'tr_short', 'tr_' + 'x'.repeat(81), 'tr_bad%27OR%201%3D1']) {
            await get(`/api/messages/by-trace/${id}?session=${f.sessionId}`, 400);
        }
        assert.deepEqual((await get(`/api/messages/by-trace/${f.runId}?session=${encodeURIComponent("' OR 1=1 --")}`)).body,
            { ok: true, data: { message: null } });
    });
});

test('no-store precedes supplied auth on valid and malformed new-route requests', { timeout: 10000 }, async () => {
    const f = fixture(); f.insert('AUTH PROTECTED'); let checks = 0;
    await withServer(async get => {
        await get(f.path, 401); await get('/api/messages/by-trace/invalid', 401);
        assert.equal(checks, 2);
    }, (_req, res) => {
        checks++; assert.equal(res.getHeader('Cache-Control'), 'no-store');
        res.status(401).json({ ok: false, error: 'fixture_auth_required' });
    });
});
