// Adapted from 184d9826b07e909d3b050626aa98eafcde908da5; no donor worktree dependency.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

// Full isolation must precede orchestrate's transitive DB/config/provider imports.
const root = mkdtempSync(join(tmpdir(), 'wp19-snapshot-'));
for (const key of Object.keys(process.env)) {
    if (!['PATH', 'LANG', 'LC_ALL', 'NO_COLOR', 'NODE_TEST_CONTEXT'].includes(key)) delete process.env[key];
}
for (const key of ['HOME', 'CLI_JAW_HOME', 'CLI_JAW_DASHBOARD_HOME', 'TMPDIR', 'CODEX_HOME',
    'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    process.env[key] = join(root, key); mkdirSync(process.env[key]!);
}
process.env.NODE_ENV = 'test';
process.env.CLI_JAW_SKIP_AUTOMATION_PRIME = '1';
const { registerOrchestrateRoutes } = await import('../../src/routes/orchestrate.ts');
const { createChatSession, setActiveChatSession, deleteChatSession } = await import('../../src/core/chat-sessions.ts');
const { db } = await import('../../src/core/db.ts');
const { settings } = await import('../../src/core/config.ts');
const { beginLiveRun, setLiveRunTraceId, clearLiveRun } = await import('../../src/agent/live-run-state.ts');
const { parseActivityIdentity } = await import('../../src/shared/presentation.ts');
after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test('snapshot captures requested/active identity and uses its scope for live state', { timeout: 15000 }, async t => {
    const app = express();
    let authCalls = 0;
    registerOrchestrateRoutes(app, (_req, _res, next) => { authCalls++; next(); });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/orchestrate/snapshot`;
    const get = (query = '') => fetch(base + query, { signal: AbortSignal.timeout(3000) });
    const before = settings.multiSession.enabled; settings.multiSession.enabled = true;
    const viewed = createChatSession('activity-viewed-A');
    const active = createChatSession('activity-active-B');
    const viewedScope = `local:${viewed.id}`, activeScope = `local:${active.id}`;
    beginLiveRun(viewedScope, 'codex'); setLiveRunTraceId(viewedScope, 'tr_1234567890abcdef');
    beginLiveRun(activeScope, 'codex'); setLiveRunTraceId(activeScope, 'tr_fedcba0987654321');
    t.after(() => {
        clearLiveRun(viewedScope); clearLiveRun(activeScope);
        settings.multiSession.enabled = before; setActiveChatSession('default');
    });
    const response = await get(`?session=${viewed.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body.activityIdentity, { sessionId: viewed.id, scope: viewedScope });
    assert.deepEqual(parseActivityIdentity(body.activityIdentity), { sessionId: viewed.id, scope: viewedScope });
    assert.equal(body.orc.scope, viewedScope);
    assert.equal(body.activeRun.traceRunId, 'tr_1234567890abcdef');
    for (const field of ['orc', 'runtime', 'workers', 'heartbeat', 'queued', 'activeRun']) assert.ok(Object.hasOwn(body, field));
    const activeBody = await (await get()).json();
    assert.deepEqual(activeBody.activityIdentity, { sessionId: active.id, scope: activeScope });
    assert.equal(activeBody.activeRun.traceRunId, 'tr_fedcba0987654321');
    assert.deepEqual((await (await get('?session=default')).json()).activityIdentity, { sessionId: 'default', scope: 'default' });
    for (const query of ['?session=', '?session=%20', '?session=a&session=b', '?session=' + 'x'.repeat(241)]) {
        const invalid = await get(query);
        assert.equal(invalid.status, 400, query);
        assert.equal(invalid.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await invalid.json(), { ok: false, error: 'invalid_session' });
    }
    const unknown = await get('?session=unknown-session');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await unknown.json(), { ok: false, error: 'unknown_session' });
    const remote = 'jaw:slack:channel:C-activity';
    db.prepare('INSERT INTO remote_session_bindings (remote_key,chat_session_id) VALUES (?,?)').run(remote, viewed.id);
    assert.deepEqual((await (await get(`?session=${viewed.id}`)).json()).activityIdentity, { sessionId: viewed.id, scope: remote });
    assert.equal(deleteChatSession(viewed.id), true);
    assert.equal((await get(`?session=${viewed.id}`)).status, 404, 'deleted A must not become active B');
    settings.multiSession.enabled = false;
    const disabled = await (await get('?session=unknown-session')).json();
    assert.deepEqual(disabled.activityIdentity, { sessionId: active.id, scope: 'default' });
    assert.equal(disabled.orc.scope, 'default');
    assert.deepEqual(disabled.activeRun, { running: false, text: '', toolLog: [] },
        'must not reuse either local-scope live run');
    assert.equal(authCalls, 11);
});

test('ActivityIdentity parser returns only bounded server identity fields', () => {
    const identity = { sessionId: 'chat-A', scope: 'local:chat-A' };
    assert.deepEqual(parseActivityIdentity({ ...identity, runId: 'not-authority' }), identity);
    for (const bad of [null, [], {}, { sessionId: '', scope: 'default' },
        { sessionId: 'chat-A', scope: 1 }, { sessionId: 'x'.repeat(241), scope: 'default' }]) {
        assert.equal(parseActivityIdentity(bad), null);
    }
});
