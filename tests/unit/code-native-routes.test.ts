import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import { registerNativeCodeRoutes, type CodeRouteService } from '../../src/routes/code-native.ts';
import { CodeStore, CodeStoreError } from '../../src/code-mode/store.ts';
import type { CodeSessionInfo } from '../../src/code-mode/wire.ts';

function fixture() {
    const session: CodeSessionInfo = {
        sessionId: 'session-one', provider: 'codex-app', cwd: tmpdir(), title: 'Fixture',
        model: 'fixture', effort: 'high', permissionMode: 'ask', status: 'idle', turnId: null,
        archivedAt: null, error: null, resume: { available: true, reason: null },
        capabilities: { resume: true, interrupt: true, permissions: true, setModelMidSession: false,
            efforts: ['high'], permissionModes: ['ask', 'auto', 'read-only'] },
        epoch: 4, sequence: 7, revision: 2, createdAt: 1, lastUsedAt: 2,
    };
    const calls: Array<{ method: string; args: unknown[] }> = [];
    let duplicate = false;
    const capture = (method: string, ...args: unknown[]) => calls.push({ method, args });
    const service: CodeRouteService = {
        create(input) { capture('create', input); return { ...session, ...input }; },
        list(input) { capture('list', input); return [session]; },
        snapshot(id) { capture('snapshot', id); return { session, items: [], sequence: 7, pendingPermissions: [], truncated: false }; },
        readEvents(...args) { capture('events', ...args); return { events: [], nextSequence: 7, throughSequence: 7, hasMore: false }; },
        prompt(id, input) {
            capture('prompt', id, input);
            return { duplicate, receipt: { turnId: 'turn-one', clientTurnKey: input.clientTurnKey, sequence: 8, status: 'accepted' } };
        },
        async cancel(...args) { capture('cancel', ...args); return session; },
        async attach(id) { capture('attach', id); return session; },
        async patch(id, input) { capture('patch', id, input); return { ...session, title: input.title ?? session.title }; },
        answerPermission(...args) { capture('permission', ...args); },
        models() { capture('models'); return { providers: [], defaultProvider: 'codex-app' }; },
    };
    return { session, calls, service, duplicate() { duplicate = true; } };
}

async function server<T>(run: (url: string, fixture: ReturnType<typeof fixture>, reads: () => number) => Promise<T>, prefix?: string): Promise<T> {
    const f = fixture();
    let reads = 0;
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.get('/legacy', (_req, res) => res.json({ legacy: true }));
    registerNativeCodeRoutes(app, (req, res, next) => {
        if (req.headers.authorization !== 'Bearer fixture') { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
        next();
    }, () => { reads++; return f.service; }, prefix);
    const http = app.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    assert.ok(address && typeof address === 'object');
    try { return await run(`http://127.0.0.1:${address.port}${prefix ?? '/api/code/native'}`, f, () => reads); }
    finally {
        await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
    }
}

function request(url: string, method = 'GET', body?: unknown) {
    return fetch(url, { method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('authentication and malformed inputs cannot initialize the lazy Code host', async () => {
    await server(async (url, f, reads) => {
        assert.equal((await fetch(`${url}/models`)).status, 401);
        const cases: Array<[unknown, string]> = [
            [null, 'invalid_body'], [[], 'invalid_body'],
            [{ provider: '__proto__', cwd: tmpdir() }, 'invalid_provider'],
            [{ provider: 'codex-app', cwd: 'relative' }, 'absolute_cwd_required'],
            [{ provider: 'codex-app', cwd: import.meta.filename, model: 'default', permissionMode: 'ask' }, 'workspace_missing'],
            [{ provider: 'claude', cwd: tmpdir(), model: 'default', permissionMode: 'always-allow' }, 'invalid_permission_mode'],
            [{ provider: 'grok', cwd: tmpdir(), nativeCursor: 'forged' }, 'unknown_field'],
            [{ provider: 'claude', cwd: tmpdir() }, 'invalid_model'],
            [{ provider: 'claude', cwd: tmpdir(), model: 'default' }, 'invalid_permission_mode'],
        ];
        for (const [input, code] of cases) {
            const response = await request(`${url}/sessions`, 'POST', input);
            assert.equal(response.status, 400);
            assert.equal((await response.json()).error, code);
        }
        const malformed = await fetch(`${url}/sessions`, { method: 'POST',
            headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: '{"broken":' });
        assert.equal(malformed.status, 400);
        assert.deepEqual(await malformed.json(), { ok: false, error: 'invalid_body' });
        const oversized = await request(`${url}/sessions`, 'POST', { value: 'x'.repeat(2 * 1024 * 1024) });
        assert.equal(oversized.status, 413);
        assert.deepEqual(await oversized.json(), { ok: false, error: 'payload_too_large' });
        assert.equal(reads(), 0);
        assert.deepEqual(f.calls, []);
    });
});

test('all four providers cross the same typed creation boundary without changing selection', async () => {
    await server(async (url, f) => {
        for (const provider of ['codex-app', 'claude', 'cursor', 'grok']) {
            const input = { provider, cwd: tmpdir(), model: 'selected', effort: null, permissionMode: 'auto' };
            const response = await request(`${url}/sessions`, 'POST', input);
            assert.equal(response.status, 201);
            assert.equal((await response.json()).session.provider, provider);
            assert.deepEqual(f.calls.at(-1), { method: 'create', args: [{ ...input, cwd: realpathSync(tmpdir()) }] });
        }
    });
});

test('index, snapshot and replay reads preserve filters, caps and exact returned watermark', async () => {
    await server(async (url, f) => {
        assert.equal((await request(`${url}/sessions?scope=cwd`)).status, 400);
        assert.equal((await request(`${url}/sessions?archived=perhaps`)).status, 400);
        assert.equal((await request(`${url}/sessions?limit=0`)).status, 400);
        const listing = await request(`${url}/sessions?cwd=${encodeURIComponent(tmpdir())}&archived=false&limit=25&offset=5`);
        assert.equal(listing.status, 200);
        assert.deepEqual(f.calls.at(-1), { method: 'list', args: [{ cwd: realpathSync(tmpdir()), archived: false, limit: 25, offset: 5 }] });
        assert.equal((await request(`${url}/sessions/session-one`)).status, 200);
        assert.equal(f.calls.at(-1)?.method, 'snapshot');
        const events = await request(`${url}/sessions/session-one/events?afterSequence=7&limit=9000`);
        assert.deepEqual(await events.json(), { ok: true, events: [], nextSequence: 7, throughSequence: 7, hasMore: false });
        assert.deepEqual(f.calls.at(-1), { method: 'events', args: ['session-one', 7, 500] });
        assert.equal((await request(`${url}/sessions/session-one/events?afterSequence=-1`)).status, 400);
        assert.equal((await request(`${url}/sessions/session-one/events?afterSequence=1.5`)).status, 400);
        assert.equal(f.calls.some(call => call.method === 'attach'), false);
    });
});

test('create and list share actual directory identity through aliases and trailing separators', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'code-route-alias-'));
    const target = join(parent, 'real workspace');
    const alias = join(parent, 'alias');
    mkdirSync(target);
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonical = realpathSync(target);
    const database = new Database(':memory:');
    const store = new CodeStore(database);
    try {
        await server(async (url, f) => {
            f.service.create = input => store.create({ ...input, capabilities: f.session.capabilities }).session;
            f.service.list = options => store.list(options);
            const created = await request(`${url}/sessions`, 'POST', {
                provider: 'claude', cwd: alias, model: 'default', effort: null, permissionMode: 'ask',
            });
            assert.equal(created.status, 201);
            assert.equal((await created.json()).session.cwd, canonical);
            for (const path of [alias, alias + '/', canonical]) {
                const listed = await request(`${url}/sessions?cwd=${encodeURIComponent(path)}`);
                const data = await listed.json();
                assert.equal(data.sessions.length, 1);
                assert.equal(data.sessions[0].cwd, canonical);
            }
            rmSync(alias, { recursive: true, force: true });
            rmSync(target, { recursive: true });
            const history = await request(`${url}/sessions?cwd=${encodeURIComponent(canonical)}`);
            assert.equal((await history.json()).sessions.length, 1);
        });
    } finally { database.close(); rmSync(parent, { recursive: true, force: true }); }
});

test('prompt responses distinguish committed new admission from an existing receipt', async () => {
    await server(async (url, f) => {
        const input = { text: 'keep exact text\n', clientTurnKey: 'client-one' };
        let response = await request(`${url}/sessions/session-one/prompt`, 'POST', input);
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { ok: true, turnId: 'turn-one', clientTurnKey: 'client-one', sequence: 8, status: 'accepted' });
        f.duplicate();
        response = await request(`${url}/sessions/session-one/prompt`, 'POST', input);
        assert.equal(response.status, 200);
        assert.deepEqual(f.calls.at(-1), { method: 'prompt', args: ['session-one', input] });
        assert.equal((await request(`${url}/sessions/session-one/prompt`, 'POST', { ...input, provider: 'grok' })).status, 400);
        assert.equal((await request(`${url}/sessions/session-one/prompt`, 'POST', { text: ' ', clientTurnKey: 'other' })).status, 400);
    });
});

test('cancel and permission answers keep captured owner and opaque choice unchanged', async () => {
    await server(async (url, f) => {
        assert.equal((await request(`${url}/sessions/session-one/cancel`, 'POST', { turnId: 'turn-one' })).status, 400);
        const cancel = { turnId: 'turn-one', epoch: 4 };
        assert.equal((await request(`${url}/sessions/session-one/cancel`, 'POST', cancel)).status, 200);
        assert.deepEqual(f.calls.at(-1), { method: 'cancel', args: ['session-one', cancel] });
        const answer = { sessionId: 'session-one', turnId: 'turn-one', epoch: 4, optionId: 'opaque:allow-once' };
        assert.equal((await request(`${url}/permissions/permission-one`, 'POST', answer)).status, 200);
        assert.deepEqual(f.calls.at(-1), { method: 'permission', args: ['permission-one', answer] });
        assert.equal((await request(`${url}/permissions/permission-one`, 'POST', { ...answer, optionId: null })).status, 400);
        f.service.answerPermission = () => { throw new CodeStoreError('stale_permission', 'Stale decision', 409); };
        const stale = await request(`${url}/permissions/permission-one`, 'POST', answer);
        assert.equal(stale.status, 409);
        assert.deepEqual(await stale.json(), { ok: false, error: 'stale_permission' });
    });
});

test('metadata conflicts return current public state without retrying or accepting immutable fields', async () => {
    await server(async (url, f) => {
        assert.equal((await request(`${url}/sessions/session-one`, 'PATCH', { title: 'rename' })).status, 400);
        assert.equal((await request(`${url}/sessions/session-one`, 'PATCH', { expectedRevision: 2, cwd: '/elsewhere' })).status, 400);
        const input = { expectedRevision: 2, title: 'Renamed' };
        assert.equal((await request(`${url}/sessions/session-one`, 'PATCH', input)).status, 200);
        assert.deepEqual(f.calls.at(-1), { method: 'patch', args: ['session-one', input] });
        f.service.patch = async () => { throw new CodeStoreError('revision_conflict', 'Changed', 409); };
        const conflict = await request(`${url}/sessions/session-one`, 'PATCH', input);
        assert.equal(conflict.status, 409);
        assert.deepEqual(await conflict.json(), { ok: false, error: 'revision_conflict', session: f.session });
        assert.equal((await request(`${url}/sessions/session-one/attach`, 'POST', {})).status, 200);
        assert.equal(f.calls.at(-1)?.method, 'attach');
    });
});

test('retired and unknown endpoints return JSON without initializing a runtime', async () => {
    await server(async (url, _f, reads) => {
        for (const path of ['/sessions/stored', '/model-assignments', '/model-presets']) {
            const response = await request(url + path);
            assert.equal(response.status, 410);
            assert.equal((await response.json()).error, 'code_endpoint_retired');
        }
        assert.equal((await request(`${url}/sessions/session-one/ext`, 'POST', { method: 'unsafe' })).status, 410);
        assert.equal((await request(`${url}/missing`)).status, 404);
        assert.equal(reads(), 0);
    });
});

test('final prefix serves native APIs and does not keep a removed staging alias', async () => {
    await server(async (url, f) => {
        assert.equal((await request(`${url}/models`)).status, 200);
        assert.equal(f.calls.at(-1)?.method, 'models');
        assert.equal((await request(`${url}/native/models`)).status, 404);
        f.service.models = () => { throw Object.assign(new Error('private diagnostic sentinel'), { code: 'persistence_failed', statusCode: 503 }); };
        const unavailable = await request(`${url}/models`);
        assert.equal(unavailable.status, 503);
        assert.deepEqual(await unavailable.json(), { ok: false, error: 'persistence_failed' });
    }, '/api/code');
});
