import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { registerOrchestrateRoutes } from '../../src/routes/orchestrate.js';
import { createChatSession, setActiveChatSession } from '../../src/core/chat-sessions.js';
import { db } from '../../src/core/db.js';
import { settings } from '../../src/core/config.js';
import { beginLiveRun, setLiveRunTraceId, clearLiveRun } from '../../src/agent/live-run-state.js';

test('snapshot captures requested/active identity and uses its scope for live state', { timeout: 15_000 }, async () => {
    const app = express();
    registerOrchestrateRoutes(app, (_req, _res, next) => next());
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/orchestrate/snapshot`;
    const get = (query = '') => fetch(base + query, { signal: AbortSignal.timeout(3_000) });
    const before = settings.multiSession.enabled;
    settings.multiSession.enabled = true;
    const viewed = createChatSession('activity-viewed');
    const active = createChatSession('activity-active');
    const viewedScope = `local:${viewed.id}`;
    beginLiveRun(viewedScope, 'codex');
    setLiveRunTraceId(viewedScope, 'tr_1234567890abcdef');
    try {
        const response = await get(`?session=${viewed.id}`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.activityIdentity, { sessionId: viewed.id, scope: viewedScope });
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(body.orc.scope, viewedScope);
        assert.equal(body.activeRun.traceRunId, 'tr_1234567890abcdef');
        const activeBody = await (await get()).json();
        assert.deepEqual(activeBody.activityIdentity, { sessionId: active.id, scope: `local:${active.id}` });
        assert.equal((await get('?session=deleted-session')).status, 404);
        for (const query of ['?session=', '?session=%20', '?session=a&session=b', '?session=' + 'x'.repeat(241)]) {
            assert.equal((await get(query)).status, 400, query);
        }
        const remote = 'jaw:slack:channel:C-activity';
        db.prepare('INSERT INTO remote_session_bindings (remote_key,chat_session_id) VALUES (?,?)').run(remote, viewed.id);
        assert.deepEqual((await (await get(`?session=${viewed.id}`)).json()).activityIdentity,
            { sessionId: viewed.id, scope: remote });
        settings.multiSession.enabled = false;
        const disabled = await (await get('?session=deleted-session')).json();
        assert.deepEqual(disabled.activityIdentity, { sessionId: active.id, scope: 'default' });
        assert.equal(disabled.orc.scope, 'default');
    } finally {
        clearLiveRun(viewedScope);
        settings.multiSession.enabled = before;
        setActiveChatSession('default');
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
