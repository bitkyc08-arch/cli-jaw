import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import type { RuntimeRequestBinding, RuntimeRequests as Registry } from '../../src/agent/runtime/requests.ts';
import type { BusEvent } from '../../src/core/event-bus.ts';

// The mapper imports the DB statically. Isolate ALL homes before any project import;
// do not inherit provider credentials even when this file is run outside wp19-focused.
const root = mkdtempSync(join(tmpdir(), 'wp19-notice-'));
for (const key of Object.keys(process.env)) {
    if (!['PATH', 'LANG', 'LC_ALL', 'NO_COLOR', 'NODE_TEST_CONTEXT'].includes(key)) delete process.env[key];
}
for (const key of ['HOME', 'CLI_JAW_HOME', 'CLI_JAW_DASHBOARD_HOME', 'TMPDIR', 'CODEX_HOME',
    'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    process.env[key] = join(root, key); mkdirSync(process.env[key]!);
}
process.env.NODE_ENV = 'test';
process.env.CLI_JAW_SKIP_AUTOMATION_PRIME = '1';
const { RuntimeRequests } = await import('../../src/agent/runtime/requests.ts');
const { db } = await import('../../src/core/db.ts');
const { settings } = await import('../../src/core/config.ts');
const { createChatSession, setActiveChatSession, deleteChatSession } = await import('../../src/core/chat-sessions.ts');
const { registerRuntimeRequestRoutes } = await import('../../src/routes/runtime-requests.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
const { parseRuntimeRequestNotice } = await import('../../src/shared/runtime-request-notice.ts');
const { parseRuntimeRequestView, parseRuntimeEvent } = await import('../../src/shared/runtime-event-parse.ts');
after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

const binding: RuntimeRequestBinding = { runId: 'run-A', sessionId: 'chat-A', scope: 'execution:A', turnId: 'turn-A' };
const view = { title: 'Private operation', fields: [{ id: 'decision', label: 'Choose',
    multiSelect: false, allowFreeform: false, options: [{ id: 'allow', label: 'Allow once' }] }] };
function input(overrides: Partial<Parameters<Registry['open']>[0]> = {}) {
    return { ...binding, requestType: 'approval' as const, view, cancelled: null,
        isCurrent: () => true, validate: (value: unknown) => {
            if (value !== 'allow') throw new Error('invalid_option');
            return 'accepted';
        }, ...overrides };
}
function fixture(t: TestContext, observer?: (sessionId: string) => void) {
    const registry = new RuntimeRequests(observer);
    t.after(() => {
        registry.setChangeObserver(undefined);
        registry.cancelRun('run-A'); registry.cancelRun('run-B');
    });
    return registry;
}

test('observer sees committed insertion/removal exactly once and invalid response retains the entry', async t => {
    const states: string[][] = [];
    const sessions: string[] = [];
    const registry = fixture(t, session => {
        sessions.push(session); states.push(registry.list(session).map(entry => entry.requestId));
    });
    const pending = registry.open(input());
    assert.deepEqual(states, [[pending.requestId]]);
    assert.throws(() => registry.respond(pending.requestId, binding, 'wrong'), /invalid_option/);
    assert.equal(registry.list(binding.sessionId).length, 1);
    assert.equal(states.length, 1);
    registry.respond(pending.requestId, binding, 'allow');
    assert.equal(await pending.answer, 'accepted');
    pending.cancel(); registry.cancelRun(binding.runId);
    assert.throws(() => registry.respond(pending.requestId, binding, 'allow'), /request_not_current/);
    assert.deepEqual(states, [[pending.requestId], []]);
    assert.deepEqual(sessions, ['chat-A', 'chat-A']);
});

test('invalid admissions never insert, allocate a timer, or emit an insertion notice', t => {
    const notices: string[] = [];
    const registry = fixture(t, session => notices.push(session));
    const timer = t.mock.method(globalThis, 'setTimeout');
    const huge = { title: 'Decision', fields: Array.from({ length: 8 }, (_, i) => ({
        id: `f${i}`, label: 'Field', multiSelect: false, allowFreeform: false,
        options: Array.from({ length: 20 }, (_, j) => ({ id: `o${j}`, label: '한'.repeat(500) })),
    })) };
    const cases = [
        { overrides: { view: null }, error: /invalid_request_view/ },
        { overrides: { view: huge }, error: /request_view_limit/ },
        { overrides: { cancelled: undefined }, error: /invalid_cancellation/ },
        { overrides: { sessionId: '' }, error: /invalid_runtime_event/ },
        { overrides: { isCurrent: () => false }, error: /request_not_current/ },
    ];
    for (const { overrides, error } of cases) assert.throws(() => registry.open(input(overrides)), error);
    let current = true;
    assert.throws(() => registry.open(input({ isCurrent: () => current,
        view: { ...view, get title() { current = false; return 'Owner lost'; } } })), /request_not_current/);
    assert.equal(timer.mock.callCount(), 0);
    assert.deepEqual(registry.list('chat-A'), []);
    assert.deepEqual(notices, []);
});

for (const cause of ['TTL', 'Stop', 'response', 'owner-loss'] as const) {
    test(`${cause} removes once while a sibling remains actionable`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
        const notices: string[] = [];
        const registry = fixture(t, session => notices.push(session));
        let current = true;
        const first = registry.open(input({ isCurrent: () => current }));
        t.mock.timers.tick(1000);
        const siblingBinding = { ...binding, runId: 'run-B', turnId: 'turn-B' };
        const sibling = registry.open(input(siblingBinding));
        if (cause === 'TTL') t.mock.timers.tick(119_000);
        if (cause === 'Stop') registry.cancelRun('run-A');
        if (cause === 'response') registry.respond(first.requestId, binding, 'allow');
        if (cause === 'owner-loss') { current = false; registry.list('chat-A'); }
        assert.equal(await first.answer, cause === 'response' ? 'accepted' : null);
        first.cancel(); registry.cancelRun('run-A');
        assert.deepEqual(registry.list('chat-A').map(entry => entry.requestId), [sibling.requestId]);
        assert.deepEqual(notices, ['chat-A', 'chat-A', 'chat-A']);
        registry.respond(sibling.requestId, siblingBinding, 'allow');
        assert.equal(await sibling.answer, 'accepted');
        assert.deepEqual(notices, ['chat-A', 'chat-A', 'chat-A', 'chat-A']);
    });
}

test('a reentrant observer may list/respond during insertion before open returns', async t => {
    let calls = 0;
    const registry = fixture(t, session => {
        calls++;
        const [entry] = registry.list(session);
        if (entry) registry.respond(entry.requestId, binding, 'allow');
    });
    const pending = registry.open(input());
    assert.equal(await pending.answer, 'accepted');
    assert.equal(calls, 2);
    assert.deepEqual(registry.list('chat-A'), []);
});

test('reentrant cancellation and opening a sibling do not recurse over or consume the new request', async t => {
    let calls = 0;
    let sibling: ReturnType<Registry['open']> | undefined;
    const registry = fixture(t, () => {
        if (++calls !== 1) return;
        registry.cancelRun('run-A');
        sibling = registry.open(input({ runId: 'run-B' }));
    });
    const pending = registry.open(input());
    assert.equal(await pending.answer, null);
    assert.ok(sibling);
    assert.deepEqual(registry.list('chat-A').map(entry => entry.requestId), [sibling.requestId]);
    sibling.cancel();
    assert.equal(await sibling.answer, null);
    assert.equal(calls, 4);
});

test('setChangeObserver replaces a single observer and supports removal', async t => {
    const first: string[] = [], second: string[] = [];
    const registry = fixture(t, session => first.push(session));
    const pending = registry.open(input());
    registry.setChangeObserver(session => second.push(session));
    pending.cancel();
    assert.equal(await pending.answer, null);
    registry.setChangeObserver(undefined);
    const silent = registry.open(input()); silent.cancel();
    assert.deepEqual(first, ['chat-A']);
    assert.deepEqual(second, ['chat-A']);
});

for (const mode of ['sync-throw', 'async-reject', 'async-pending'] as const) {
    test(`${mode} observer cannot hang or undo response settlement`, { timeout: 2000 }, async t => {
        const warnings = t.mock.method(console, 'warn', () => {});
        let calls = 0;
        const registry = fixture(t, () => {
            calls++;
            if (mode === 'sync-throw') throw new Error('PRIVATE_OBSERVER_DETAIL');
            return mode === 'async-reject' ? Promise.reject(new Error('PRIVATE_OBSERVER_DETAIL')) : new Promise<void>(() => {});
        });
        const pending = registry.open(input());
        registry.respond(pending.requestId, binding, 'allow');
        assert.equal(await pending.answer, 'accepted');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(calls, 2);
        assert.deepEqual(registry.list('chat-A'), []);
        assert.deepEqual(warnings.mock.calls.map(call => call.arguments),
            mode === 'async-pending' ? [] : [['[runtime] request_notice_failed'], ['[runtime] request_notice_failed']]);
    });
}

async function routes(t: TestContext) {
    const registry = fixture(t);
    const app = express(); app.use(express.json());
    let authCalls = 0;
    registerRuntimeRequestRoutes(app, (_req, _res, next) => { authCalls++; next(); }, registry);
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/runtime/requests`;
    const get = (session: string) => fetch(`${base}?sessionId=${encodeURIComponent(session)}`, { signal: AbortSignal.timeout(3000) });
    const post = (id: string, body: unknown) => fetch(`${base}/${id}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    return { registry, get, post, authCalls: () => authCalls };
}

test('real route composition maps captured local/default/remote chat, GET keeps execution scope, POST checks four IDs', { timeout: 15000 }, async t => {
    const before = settings.multiSession.enabled; settings.multiSession.enabled = true;
    t.after(() => { settings.multiSession.enabled = before; setActiveChatSession('default'); });
    const local = createChatSession('notice-local-A');
    const remote = createChatSession('notice-remote-A');
    const active = createChatSession('notice-active-B');
    const remoteKey = 'jaw:slack:channel:notice-A';
    db.prepare('INSERT INTO remote_session_bindings (remote_key,chat_session_id) VALUES (?,?)').run(remoteKey, remote.id);
    const api = await routes(t);
    const events: BusEvent[] = [], broadcastTypes: string[] = [];
    const listener = (type: string) => { broadcastTypes.push(type); };
    addBroadcastListener(listener); t.after(() => removeBroadcastListener(listener));
    t.after(subscribe(event => events.push(event)));
    for (const [sessionId, executionScope, deliveryScope] of [
        ['default', 'default', 'default'], [local.id, 'default', `local:${local.id}`],
        [remote.id, 'default', remoteKey], [local.id, 'custom:worker-A', `local:${local.id}`],
    ]) {
        const original = { ...binding, sessionId: sessionId!, scope: executionScope! };
        const pending = api.registry.open(input(original));
        const notice = { version: 1, sessionId, scope: deliveryScope };
        assert.deepEqual(events.at(-1)?.data, notice);
        assert.equal(events.at(-1)?.event, 'agent_runtime_requests_changed');
        assert.equal(events.at(-1)?.topic, 'agent');
        const response = await api.get(sessionId!); assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.data.requests, [{ ...original, requestId: pending.requestId,
            requestType: 'approval', expiresAt: pending.expiresAt, view: pending.view }]);
        assert.deepEqual((await (await api.get(active.id)).json()).data.requests, []);
        const count = events.length;
        for (const key of ['runId', 'sessionId', 'scope', 'turnId'] as const) {
            const wrongId = key === 'scope' && deliveryScope !== executionScope ? deliveryScope : 'foreign';
            const wrong = await api.post(pending.requestId, { ...original, [key]: wrongId, response: 'allow' });
            assert.equal(wrong.status, 409);
            assert.deepEqual(await wrong.json(), { ok: false, error: 'request_not_current' });
        }
        const invalid = await api.post(pending.requestId, { ...original, response: 'invalid' });
        assert.equal(invalid.status, 400);
        assert.deepEqual(await invalid.json(), { ok: false, error: 'invalid_response' });
        assert.equal(events.length, count);
        assert.equal(api.registry.list(sessionId!).length, 1);
        const accepted = await api.post(pending.requestId, { ...original, response: 'allow' });
        assert.equal(accepted.status, 200);
        assert.deepEqual(await accepted.json(), { ok: true, data: { accepted: true } });
        assert.equal(await pending.answer, 'accepted');
        assert.deepEqual(events.at(-1)?.data, notice);
        assert.equal(events.length, count + 1);
        assert.equal((await api.post(pending.requestId, { ...original, response: 'allow' })).status, 409);
    }
    assert.equal(events.length, 8);
    assert.deepEqual(broadcastTypes, [], 'notices must bypass all messaging/broadcast listeners');
    assert.equal(api.authCalls(), 36);
});

test('unknown/deleted A and multi-session-off distinct A never alias active B', { timeout: 10000 }, async t => {
    const before = settings.multiSession.enabled; settings.multiSession.enabled = true;
    t.after(() => { settings.multiSession.enabled = before; setActiveChatSession('default'); });
    const a = createChatSession('notice-hidden-A');
    const deleted = createChatSession('notice-deleted-A');
    const b = createChatSession('notice-visible-B');
    assert.equal(deleteChatSession(deleted.id), true);
    const api = await routes(t);
    const events: BusEvent[] = [];
    t.after(subscribe(event => events.push(event)));
    for (const sessionId of ['unknown-A', deleted.id]) {
        const pending = api.registry.open(input({ sessionId })); pending.cancel();
        assert.equal(await pending.answer, null);
    }
    settings.multiSession.enabled = false;
    const pending = api.registry.open(input({ sessionId: a.id }));
    assert.deepEqual((await (await api.get(a.id)).json()).data.requests.map((entry: RuntimeRequestBinding) => entry.sessionId), [a.id]);
    assert.deepEqual((await (await api.get(b.id)).json()).data.requests, []);
    pending.cancel(); assert.equal(await pending.answer, null);
    assert.deepEqual(events, []);
    const visible = api.registry.open(input({ sessionId: b.id })); visible.cancel();
    assert.deepEqual(events.map(event => event.data), Array.from({ length: 2 }, () => ({ version: 1, sessionId: b.id, scope: 'default' })));
});

test('deleting captured A between insert and removal suppresses its removal notice, never targets B', { timeout: 10000 }, async t => {
    const before = settings.multiSession.enabled; settings.multiSession.enabled = true;
    t.after(() => { settings.multiSession.enabled = before; setActiveChatSession('default'); });
    const a = createChatSession('notice-deleting-A');
    createChatSession('notice-current-B');
    const api = await routes(t);
    const notices: BusEvent[] = [];
    t.after(subscribe(event => { if (event.event === 'agent_runtime_requests_changed') notices.push(event); }));
    const pending = api.registry.open(input({ sessionId: a.id }));
    assert.deepEqual(notices.map(event => event.data), [{ version: 1, sessionId: a.id, scope: `local:${a.id}` }]);
    assert.equal(deleteChatSession(a.id), true);
    pending.cancel(); assert.equal(await pending.answer, null);
    assert.equal(notices.length, 1);
    assert.deepEqual(api.registry.list(a.id), []);
});

test('notice parser whitelists metadata and rejects malformed versions/identities', () => {
    const notice = { version: 1, sessionId: 'chat-A', scope: 'local:chat-A' };
    assert.deepEqual(parseRuntimeRequestNotice({ ...notice, requestId: 'private', answer: 'private', view }), notice);
    for (const bad of [null, [], {}, { ...notice, version: 2 }, { ...notice, sessionId: '' },
        { ...notice, scope: 7 }, { ...notice, scope: 'x'.repeat(241) }]) {
        assert.equal(parseRuntimeRequestNotice(bad), null);
    }
});

test('standalone and canonical-event request view parsers enforce the same bounded shape', () => {
    const event = { ...binding, version: 1, seq: 1, kind: 'request', requestId: 'opaque-id', requestType: 'approval', view };
    assert.deepEqual(parseRuntimeRequestView({ ...view, privateInput: 'not-public' }), view);
    assert.deepEqual(parseRuntimeEvent({ ...event, view: { ...view, privateInput: 'not-public' } }), event);
    for (const bad of [null, { ...view, title: 'x'.repeat(501) },
        { ...view, fields: [view.fields[0], view.fields[0]] },
        { ...view, fields: [{ ...view.fields[0], options: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }] }] }]) {
        assert.equal(parseRuntimeRequestView(bad), null);
        assert.equal(parseRuntimeEvent({ ...event, view: bad }), null);
    }
});
