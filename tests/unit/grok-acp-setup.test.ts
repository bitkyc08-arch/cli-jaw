import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpSession, type AcpTurnOwner } from '../../src/agent/runtime/acp/session.ts';

type Wire = { id: string; method?: string; params: Record<string, unknown> };
const initialize = () => ({ protocolVersion: 1, authMethods: [{ id: 'cached_token' }, { id: 'cursor_login' }],
    agentCapabilities: { loadSession: true, nested: { enabled: true } } });
const configs = (value: string) => [{ id: 'model', name: 'Model', type: 'select', category: 'model',
    currentValue: value, options: [{ value: 'm1', name: 'First' }, { value: 'm2', name: 'Second' }] }];
const setup = () => ({ sessionId: 'native', models: { currentModelId: 'm1',
    availableModels: [{ modelId: 'm1', name: 'First' }, { modelId: 'm2', name: 'Second' }] },
    _meta: { nested: { values: ['original'] } }, configOptions: configs('m1') });

// Match Cursor's stream-backed child fixture; all process ownership is injected.
function fixture(t: TestContext) {
    const writes: Wire[] = [], failures: string[] = [], kills: string[] = [];
    const child = Object.assign(new EventEmitter(), { pid: 43002, exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable() });
    const send = (...frames: unknown[]) => child.stdout.write(frames.map(value => JSON.stringify(value) + '\n').join(''));
    const reply = (message: Wire, result: unknown) => send({ jsonrpc: '2.0', id: message.id, result });
    const handlers = new Map<string, (message: Wire) => void>();
    handlers.set('initialize', message => { reply(message, initialize()); });
    handlers.set('authenticate', message => { reply(message, {}); });
    handlers.set('session/new', message => { reply(message, setup()); });
    handlers.set('session/load', message => { const { sessionId: _id, ...loaded } = setup(); reply(message, loaded); });
    handlers.set('session/set_model', message => { reply(message, {}); });
    handlers.set('session/set_config_option', message => { reply(message, { configOptions: configs('m2') }); });
    handlers.set('session/prompt', message => { reply(message, { stopReason: 'end_turn' }); });
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk)) as Wire;
        writes.push(message); handlers.get(message.method ?? '')?.(message); callback();
    } });
    const exit = () => {
        if (child.exitCode !== null) return;
        child.exitCode = 143; child.emit('exit', 143, null); child.emit('close', 143, null);
    };
    const session = new AcpSession(child as unknown as ChildProcessWithoutNullStreams, {
        permissions: 'auto', promptTimeoutMs: 10_000, requestTimeoutMs: 1000, drainTimeoutMs: 50,
        ownedProcessOptions: { terminateTree: (_pid, signal) => { kills.push(signal ?? 'SIGTERM'); queueMicrotask(exit); } },
        failed: error => failures.push(error.message),
    });
    const owner: AcpTurnOwner = { binding: { runId: 'run', sessionId: 'chat', scope: 'scope', turnId: 'turn' },
        isCurrent: () => true, emit: body => ({ version: 1, seq: 1, runId: 'run', sessionId: 'chat', scope: 'scope', turnId: 'turn', ...body }) };
    t.after(() => session.close());
    return { session, child, writes, failures, kills, handlers, send, reply, exit,
        start: () => session.start({ cwd: process.cwd() }),
        prompt: () => session.prompt([{ type: 'text', text: 'probe' }], owner, () => {}),
    };
}

test('auth selector receives isolated validated initialize and selects an advertised method once', async t => {
    const f = fixture(t); let calls = 0;
    await f.session.start({ cwd: process.cwd(), authMethodId: init => {
        calls++;
        assert.deepEqual(init, initialize());
        (init['agentCapabilities'] as ReturnType<typeof initialize>['agentCapabilities']).nested.enabled = false;
        return 'cached_token';
    } });
    assert.equal(calls, 1);
    assert.deepEqual(f.session.agentCapabilities, initialize().agentCapabilities);
    assert.deepEqual(f.writes.map(row => row.method), ['initialize', 'authenticate', 'session/new']);
    assert.deepEqual(f.writes[1]!.params, { methodId: 'cached_token' });
});

test('mutating selector auth methods cannot authorize a new ID or load capability', async t => {
    const f = fixture(t);
    await assert.rejects(f.session.start({ cwd: process.cwd(), authMethodId: init => {
        (init['authMethods'] as { id: string }[])[0]!.id = 'invented'; return 'invented';
    } }), /acp_auth_method_unavailable/);
    assert.deepEqual(f.writes.map(row => row.method), ['initialize']);
    assert.equal(f.session.alive, false);
    const g = fixture(t);
    g.handlers.set('initialize', message => { g.reply(message, { ...initialize(), agentCapabilities: { loadSession: false } }); });
    await assert.rejects(g.session.start({ cwd: process.cwd(), resumeSessionId: 'native', authMethodId: init => {
        (init['agentCapabilities'] as Record<string, unknown>)['loadSession'] = true; return undefined;
    } }), /acp_resume_unsupported/);
    assert.deepEqual(g.writes.map(row => row.method), ['initialize']);
});

test('string auth remains unchanged and undefined selection skips authenticate', async t => {
    const f = fixture(t);
    await f.session.start({ cwd: process.cwd(), authMethodId: 'cursor_login' });
    assert.deepEqual(f.writes[1]!.params, { methodId: 'cursor_login' });
    const g = fixture(t);
    await g.session.start({ cwd: process.cwd(), authMethodId: () => undefined });
    assert.deepEqual(g.writes.map(row => row.method), ['initialize', 'session/new']);
});

test('invalid initialize never reaches selector; selector failures retire before auth/setup', async t => {
    for (const init of [{ ...initialize(), protocolVersion: 2 }, { ...initialize(), agentCapabilities: [] }]) {
        const f = fixture(t); let called = false;
        f.handlers.set('initialize', message => { f.reply(message, init); });
        await assert.rejects(f.session.start({ cwd: process.cwd(), authMethodId: () => { called = true; return 'cached_token'; } }));
        assert.equal(called, false); assert.equal(f.session.alive, false);
    }
    const f = fixture(t);
    await assert.rejects(f.session.start({ cwd: process.cwd(), authMethodId: () => { throw new Error('selector_failed'); } }), /selector_failed/);
    assert.deepEqual(f.writes.map(row => row.method), ['initialize']);
});

for (const load of [false, true]) test(`${load ? 'load' : 'new'} setup getter isolates nested data and preserves the original response`, async t => {
    const f = fixture(t);
    assert.deepEqual(f.session.getSessionSetup(), {});
    await f.session.start({ cwd: process.cwd(), ...(load ? { resumeSessionId: 'native' } : {}) });
    const expected: Record<string, unknown> = setup();
    if (load) delete expected['sessionId'];
    assert.deepEqual(f.session.getSessionSetup(), expected);
    const copy = f.session.getSessionSetup() as ReturnType<typeof setup>;
    copy.models.availableModels[0]!.name = 'changed';
    copy._meta.nested.values.push('changed'); copy.configOptions[0]!.options[0]!.name = 'changed';
    assert.deepEqual(f.session.getSessionSetup(), expected);
    assert.deepEqual(f.session.getConfigOptions(), configs('m1'));
});

test('setup response observer captures before the next frame and preserves following config update order', async t => {
    const f = fixture(t); let observed: unknown;
    f.handlers.set('session/new', message => {
        f.send({ jsonrpc: '2.0', id: message.id, result: setup() }, { jsonrpc: '2.0', method: 'session/update',
            params: { sessionId: 'native', update: { sessionUpdate: 'config_option_update', configOptions: configs('m2') } } });
        observed = f.session.getSessionSetup();
    });
    await f.start();
    assert.deepEqual(observed, setup());
    assert.deepEqual(f.session.getSessionSetup(), setup());
    assert.deepEqual(f.session.getConfigOptions(), configs('m2'));
});

test('malformed or failed setup never publishes a snapshot', async t => {
    for (const result of [null, [], { sessionId: 'native', configOptions: 'invalid' }, { sessionId: '' }]) {
        const f = fixture(t);
        f.handlers.set('session/new', message => { f.reply(message, result); });
        await assert.rejects(f.start(), /acp_response_observer_failed/);
        assert.deepEqual(f.session.getSessionSetup(), {}); assert.equal(f.session.alive, false);
    }
});

test('held setModel blocks prompt/config/model until acknowledged; metadata and model snapshot are isolated', async t => {
    const f = fixture(t); await f.start(); let held: Wire | undefined;
    f.handlers.set('session/set_model', message => { held = message; });
    const meta = { nested: { effort: 'high' } };
    const operation = f.session.setModel('m2', meta);
    assert.ok(held); assert.equal(f.session.idle, false);
    meta.nested.effort = 'low';
    assert.deepEqual(held.params, { sessionId: 'native', modelId: 'm2', _meta: { nested: { effort: 'high' } } });
    await assert.rejects(f.prompt(), /acp_prompt_unavailable/);
    await assert.rejects(f.session.setConfigOption('model', 'm1'), /acp_config_busy/);
    await assert.rejects(f.session.setModel('m1'), /acp_model_busy/);
    assert.equal((f.session.getSessionSetup()['models'] as Record<string, unknown>)['currentModelId'], 'm1');
    f.reply(held, {});
    // The acknowledged model is visible synchronously, before promise continuations.
    assert.equal((f.session.getSessionSetup()['models'] as Record<string, unknown>)['currentModelId'], 'm2');
    await operation;
    assert.equal(f.session.idle, true);
    assert.deepEqual(f.session.getConfigOptions(), configs('m1'));
    await f.prompt(); await f.session.setConfigOption('model', 'm2');
});

test('setModel accepts empty ACP response without fabricating models or config options', async t => {
    const f = fixture(t);
    f.handlers.set('session/new', message => { f.reply(message, { sessionId: 'native' }); });
    await f.start(); await f.session.setModel('m2');
    assert.deepEqual(f.session.getSessionSetup(), { sessionId: 'native' });
    assert.deepEqual(f.session.getConfigOptions(), []);
    assert.deepEqual(f.writes.at(-1)!.params, { sessionId: 'native', modelId: 'm2' });
});

test('setModel validates bounded ID and plain JSON metadata before any wire write', async t => {
    const f = fixture(t); await f.start(); const count = f.writes.length;
    const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
    let getterCalled = false;
    const accessor = { get value() { getterCalled = true; return 'bad'; } };
    const deep: Record<string, unknown> = {}; let node = deep;
    for (let i = 0; i < 40; i++) { const next = {}; node['next'] = next; node = next; }
    const invalid: [unknown, unknown][] = [['', undefined], [' ', undefined], ['x'.repeat(1025), undefined], [42, undefined],
        ['m2', null], ['m2', []], ['m2', new Date()], ['m2', { nested: new Date() }], ['m2', cyclic], ['m2', accessor],
        ['m2', { value: 'x'.repeat(32 * 1024) }], ['m2', { value: NaN }], ['m2', { value: undefined }],
        ['m2', { value: () => 'bad' }], ['m2', deep]];
    for (const [id, meta] of invalid) {
        // Exercise the JS runtime boundary despite the public TS contract.
        await assert.rejects(f.session.setModel(id as string, meta as Record<string, unknown>));
        assert.equal(f.writes.length, count);
        assert.equal(f.session.idle, true); // Each case reaches validation on a usable session.
    }
    assert.equal(getterCalled, false);
    const valid = Object.assign(Object.create(null) as Record<string, unknown>, { values: [null, true, 3, 'text'] });
    const modelId = 'x'.repeat(1024);
    await f.session.setModel(modelId, valid);
    assert.deepEqual(f.writes.at(-1)!.params, { sessionId: 'native', modelId, _meta: { values: [null, true, 3, 'text'] } });
});

for (const mode of ['null', 'array', 'string', 'error', 'timeout', 'exit'] as const) {
    test(`setModel ${mode} retires without publishing an unacknowledged model`, async t => {
        const f = fixture(t); await f.start(); const before = f.session.getSessionSetup();
        f.handlers.set('session/set_model', message => {
            if (mode === 'error') f.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'denied' } });
            else if (mode === 'exit') f.exit();
            else if (mode !== 'timeout') f.reply(message, mode === 'null' ? null : mode === 'array' ? [] : 'bad');
        });
        if (mode === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
        const operation = f.session.setModel('m2');
        if (mode === 'timeout') t.mock.timers.tick(1000);
        await assert.rejects(operation, /acp_(response_observer_failed|rpc_error|timeout|child_exit)/);
        assert.equal(f.session.alive, false); assert.equal(f.session.idle, false);
        assert.deepEqual(f.session.getSessionSetup(), before);
        assert.equal(f.failures.length, 1);
        await assert.rejects(f.prompt(), /acp_prompt_unavailable/);
        await f.session.close();
    });
}
