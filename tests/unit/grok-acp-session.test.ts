import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { grokAcpArgs, grokAuthMethod, grokModelSelection } from '../../src/agent/runtime/acp/grok-options.ts';
import { createGrokSession, type GrokSessionOptions } from '../../src/agent/runtime/acp/grok-session.ts';

function setup() {
    return { sessionId: 'grok-native', models: { currentModelId: 'grok-4.6', availableModels: [
        { modelId: 'grok-4.6', _meta: { supportsReasoningEffort: true, reasoningEffort: 'high',
            reasoningEfforts: [{ id: 'high', value: 'high', label: 'High Effort' }, { id: 'low', value: 'low', label: 'Low Effort' }] } },
        { modelId: 'grok-4.5', _meta: { supportsReasoningEffort: false } },
    ] } };
}

test('only literal auto can construct native Grok launch arguments', () => {
    assert.deepEqual(grokAcpArgs('auto'), ['agent', '--no-leader', '--always-approve', 'stdio']);
    for (const permissions of ['safe', [], ['auto'], ['read', 'Bash'], ['  read  ', '']] as const) {
        assert.throws(() => grokAcpArgs(permissions), /grok_acp_restrictive_policy_unverified/);
    }
    for (const invalid of [undefined, null, true, 'default', 'AUTO', [1], ['read;write']]) {
        assert.throws(() => grokAcpArgs(invalid), /invalid_native_permissions/);
    }
});

test('existing auth is explicitly selected from advertised methods without fallback', () => {
    const methods = [{ id: 'cached_token' }, { id: 'xai.api_key' }];
    assert.equal(grokAuthMethod({}, methods), 'cached_token');
    assert.equal(grokAuthMethod({ XAI_API_KEY: '   ' }, methods), 'cached_token');
    assert.equal(grokAuthMethod({ XAI_API_KEY: 'fixture-not-a-secret' }, methods), 'xai.api_key');
    assert.throws(() => grokAuthMethod({}, [{ id: 'xai.api_key' }]), /grok_existing_auth_unavailable/);
    assert.throws(() => grokAuthMethod({ XAI_API_KEY: 'fixture' }, [{ id: 'cached_token' }]), /grok_existing_auth_unavailable/);
    for (const malformed of [null, {}, [], [null], [{ id: 42 }]]) {
        assert.throws(() => grokAuthMethod({}, malformed));
    }
});

test('model aliases resolve current advertised model; effort uses observed choice values', () => {
    for (const alias of [undefined, '', 'default', 'grok-build']) {
        assert.deepEqual(grokModelSelection(setup(), alias), { modelId: 'grok-4.6' });
    }
    assert.deepEqual(grokModelSelection(setup(), 'grok-4.6', 'low'), { modelId: 'grok-4.6', meta: { reasoningEffort: 'low' } });
    assert.throws(() => grokModelSelection(setup(), 'unknown'), /model_not_advertised/);
    assert.throws(() => grokModelSelection(setup(), 'grok-4.5', 'high'), /effort_unavailable/);
    assert.throws(() => grokModelSelection(setup(), 'grok-build', 'ultra'), /effort_unavailable/);
    const duplicate = setup(); duplicate.models.availableModels.push(duplicate.models.availableModels[0]!);
    assert.throws(() => grokModelSelection(duplicate), /ambiguous_model/);
    const stale = setup(); stale.models.currentModelId = 'missing';
    assert.throws(() => grokModelSelection(stale), /invalid_model_metadata/);
    const noChoices = { models: { currentModelId: 'm', availableModels: [{ modelId: 'm',
        _meta: { supportsReasoningEffort: true, reasoningEffort: 'high' } }] } };
    assert.throws(() => grokModelSelection(noChoices, 'm', 'high'), /effort_unavailable/);
    const opaque = { models: { currentModelId: 'm', availableModels: [{ modelId: 'm', _meta: {
        supportsReasoningEffort: true, reasoningEfforts: [{ id: 'high', value: 'wire-high', label: 'Very high', default: false },
            { id: 'low', value: 'wire-low', label: 'Low', default: true }],
    } }] } };
    assert.deepEqual(grokModelSelection(opaque, 'm', 'wire-high'), { modelId: 'm', meta: { reasoningEffort: 'wire-high' } });
    for (const invalid of ['high', 'Very high', 'low']) assert.throws(() => grokModelSelection(opaque, 'm', invalid), /effort_unavailable/);
});

type Wire = { id?: string; method?: string; params: Record<string, unknown> };
function fixture(t: TestContext) {
    const wire: Wire[] = [], calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const child = Object.assign(new EventEmitter(), { pid: 47001, exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable() });
    let onSpawn: (() => void) | undefined, hold: string | undefined, auth = ['cached_token', 'xai.api_key'];
    let kills = 0;
    const exit = () => {
        if (child.exitCode !== null) return;
        child.exitCode = 143; child.emit('exit', 143, null); child.emit('close', 143, null);
    };
    const reply = (id: string | undefined, result: unknown) => setImmediate(() => {
        if (child.exitCode === null) child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    });
    child.stdin = new Writable({ write(chunk, _encoding, done) {
        const frame = JSON.parse(String(chunk)) as Wire; wire.push(frame);
        if (frame.method !== hold) {
            if (frame.method === 'initialize') reply(frame.id, { protocolVersion: 1,
                agentCapabilities: { loadSession: true }, authMethods: auth.map(id => ({ id })) });
            else if (frame.method === 'session/new' || frame.method === 'session/load') reply(frame.id, setup());
            else if (frame.method === 'session/prompt') reply(frame.id, { stopReason: 'end_turn' });
            else reply(frame.id, {});
        }
        done();
    } });
    const options: GrokSessionOptions = { binary: 'grok', cwd: process.cwd(), env: { PATH: '/fixture' },
        permissions: 'auto', model: 'grok-build', effort: 'low', promptTimeoutMs: 10_000, requestTimeoutMs: 1000,
        ownedProcessOptions: { terminateTree: () => { kills++; queueMicrotask(exit); } },
        spawnImpl: ((command: string, args: string[], options: Record<string, unknown>) => {
            calls.push({ command, args, options }); onSpawn?.(); return child;
        }) as unknown as typeof spawn };
    t.after(() => { exit(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
    return { options, calls, wire, child, exit, get kills() { return kills; },
        hold: (method: string) => { hold = method; }, onSpawn: (fn: () => void) => { onSpawn = fn; },
        auth: (ids: string[]) => { auth = ids; } };
}

test('factory initializes authenticates creates and configures one reusable native session', { timeout: 5000 }, async t => {
    const f = fixture(t), session = await createGrokSession(f.options);
    assert.deepEqual(f.calls[0]!.args, ['agent', '--no-leader', '--always-approve', 'stdio']);
    assert.equal(f.calls[0]!.options['shell'], false);
    assert.deepEqual(f.wire.map(x => x.method), ['initialize', 'authenticate', 'session/new', 'session/set_model']);
    assert.deepEqual(f.wire[3]!.params, { sessionId: 'grok-native', modelId: 'grok-4.6', _meta: { reasoningEffort: 'low' } });
    const owner = { binding: { runId: 'grok-run', sessionId: 'jaw-chat', scope: 'grok-scope', turnId: 'jaw-turn' },
        isCurrent: () => true, emit: () => null };
    await session.prompt([{ type: 'text', text: 'first' }], owner, () => {});
    await session.prompt([{ type: 'text', text: 'second' }], owner, () => {});
    assert.equal(f.calls.length, 1);
    assert.equal(f.wire.filter(x => x.method === 'session/prompt').every(x => x.params['sessionId'] === 'grok-native'), true);
    await session.close(); assert.equal(f.kills, 1); assert.equal(f.child.exitCode, 143);
});

test('factory load keeps explicit native identity and detaches acquisition abort', { timeout: 5000 }, async t => {
    const f = fixture(t), control = new AbortController();
    const session = await createGrokSession({ ...f.options, resumeSessionId: 'stored-native', signal: control.signal });
    assert.equal(session.nativeSessionId, 'stored-native');
    assert.equal(f.wire.find(x => x.method === 'session/load')!.params['sessionId'], 'stored-native');
    assert.equal(f.wire.some(x => x.method === 'session/new'), false);
    control.abort(); assert.equal(session.alive, true); await session.close();
});

test('default alias without effort preserves provider setup without model reselection', { timeout: 5000 }, async t => {
    const f = fixture(t), session = await createGrokSession({ ...f.options, effort: null });
    assert.deepEqual(f.wire.map(x => x.method), ['initialize', 'authenticate', 'session/new']);
    await session.close();
});

test('startup rejection never prompts or retries another auth or print transport', { timeout: 5000 }, async t => {
    const invalid = fixture(t), aborted = new AbortController(); aborted.abort();
    for (const patch of [{ permissions: 'bad' }, { cwd: '/no-such-grok-fixture' }, { promptTimeoutMs: 0 },
        { signal: aborted.signal }, { effort: '   ' }]) await assert.rejects(createGrokSession({ ...invalid.options, ...patch }));
    assert.equal(invalid.calls.length, 0);
    for (const patch of [{ model: 'unknown' }, { effort: 'ultra' }]) {
        const f = fixture(t); await assert.rejects(createGrokSession({ ...f.options, ...patch }));
        assert.equal(f.wire.some(x => x.method === 'session/prompt'), false); assert.equal(f.kills, 1);
    }
    const auth = fixture(t); auth.auth(['grok.com']);
    await assert.rejects(createGrokSession(auth.options), /existing_auth_unavailable/);
    assert.deepEqual(auth.wire.map(x => x.method), ['initialize']); assert.equal(auth.kills, 1);
});

test('unverified restrictive policies fail before spawn, auth, new or load with no policy conversion', async t => {
    const f = fixture(t);
    for (const permissions of ['safe', [], ['auto'], ['read'], ['Read', 'Bash']] as const) {
        await assert.rejects(createGrokSession({ ...f.options, permissions, resumeSessionId: 'existing-native' }),
            /grok_acp_restrictive_policy_unverified/);
    }
    assert.equal(f.calls.length, 0); assert.equal(f.wire.length, 0); assert.equal(f.kills, 0);
});

test('abort closes both spawn race and authentication in flight', { timeout: 5000 }, async t => {
    const early = fixture(t), first = new AbortController(); early.onSpawn(() => first.abort());
    await assert.rejects(createGrokSession({ ...early.options, signal: first.signal }), /acquire_aborted/);
    assert.equal(early.kills, 1);
    const pending = fixture(t), second = new AbortController(); pending.hold('initialize');
    const start = createGrokSession({ ...pending.options, signal: second.signal });
    const rejected = assert.rejects(start, /acquire_aborted/); second.abort(); await rejected;
    assert.equal(pending.kills, 1); assert.equal(pending.child.exitCode, 143);
});

test('Windows factory uses native executable resolution and refuses unsupported wrappers', { timeout: 5000 }, async t => {
    const f = fixture(t);
    const session = await createGrokSession({ ...f.options, binary: 'C:\\grok.exe', platform: 'win32' });
    assert.equal(f.calls[0]!.command, 'C:\\grok.exe'); await session.close();
    const bad = fixture(t);
    await assert.rejects(createGrokSession({ ...bad.options, binary: 'C:\\grok.ps1', platform: 'win32' }), /launch_unsupported/);
    assert.equal(bad.calls.length, 0);
});

test('spawn-race abort waits for owned child exit before rejecting acquisition', { timeout: 5000 }, async t => {
    const f = fixture(t), control = new AbortController(); f.onSpawn(() => control.abort());
    let settled = false;
    const operation = createGrokSession({ ...f.options, signal: control.signal,
        ownedProcessOptions: { terminateTree: () => {} } });
    const rejected = assert.rejects(operation.finally(() => { settled = true; }), /acquire_aborted/);
    await Promise.resolve(); assert.equal(settled, false);
    f.exit(); await rejected; assert.equal(settled, true);
});

test('startup reap timeout is surfaced and releases its listeners', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t), control = new AbortController(); f.onSpawn(() => control.abort());
    const operation = createGrokSession({ ...f.options, signal: control.signal,
        ownedProcessOptions: { terminateTree: () => {}, policy: () => ({ initialSignal: 'SIGKILL', graceMs: null }) } });
    const rejected = assert.rejects(operation, /grok_acp_startup_cleanup_failed/);
    t.mock.timers.tick(6_000); await rejected;
    // Only OwnedProcess's exit listener remains until fixture teardown reaps the child.
    assert.equal(f.child.listenerCount('close'), 0);
    assert.equal(f.child.listenerCount('exit'), 1);
});

test('advertised model collection and identifier bounds are enforced at their exact edges', () => {
    const models = { currentModelId: 'm0', availableModels: Array.from({ length: 2048 }, (_, i) => ({ modelId: `m${i}` })) };
    assert.deepEqual(grokModelSelection({ models }, 'm2047'), { modelId: 'm2047' });
    models.availableModels.push({ modelId: 'overflow' });
    assert.throws(() => grokModelSelection({ models }), /grok_invalid_model_metadata/);
    for (const availableModels of [[], null, {}]) {
        assert.throws(() => grokModelSelection({ models: { currentModelId: 'm', availableModels } }), /grok_invalid_model_metadata/);
    }
    for (const id of ['', ' ', 42, 'x'.repeat(1025)]) {
        assert.throws(() => grokModelSelection({ models: { currentModelId: id, availableModels: [{ modelId: id }] } }), /grok_invalid_model_metadata/);
    }
    const id = 'x'.repeat(1024);
    assert.deepEqual(grokModelSelection({ models: { currentModelId: id, availableModels: [{ modelId: id }] } }, id), { modelId: id });
});

test('effort choice bounds, uniqueness and object values are independently validated', () => {
    const choices: unknown[] = Array.from({ length: 64 }, (_, i) => ({ value: `e${i}` }));
    const state = () => ({ models: { currentModelId: 'm', availableModels: [{ modelId: 'm',
        _meta: { supportsReasoningEffort: true, reasoningEfforts: choices } }] } });
    assert.deepEqual(grokModelSelection(state(), 'm', 'e63'), { modelId: 'm', meta: { reasoningEffort: 'e63' } });
    choices.push({ value: 'overflow' });
    assert.throws(() => grokModelSelection(state(), 'm', 'e0'), /grok_effort_unavailable/);
    choices.splice(0, choices.length, { value: 'same' }, { value: 'same' });
    assert.throws(() => grokModelSelection(state(), 'm', 'same'), /grok_ambiguous_effort/);
    for (const choice of ['high', null, [], {}, { value: '' }, { value: 'x'.repeat(1025) }]) {
        choices.splice(0, choices.length, choice);
        assert.throws(() => grokModelSelection(state(), 'm', 'high'), /acp_invalid_object|grok_invalid_model_metadata/);
    }
    const effort = 'x'.repeat(1024);
    choices.splice(0, choices.length, { value: effort });
    assert.deepEqual(grokModelSelection(state(), 'm', effort), { modelId: 'm', meta: { reasoningEffort: effort } });
    assert.throws(() => grokModelSelection(state(), 'm', 'x'.repeat(1025)), /grok_invalid_model_metadata/);
});

test('restrictive admission is fail-closed for fresh as well as loaded factories', async t => {
    const f = fixture(t);
    for (const resumeSessionId of [undefined, 'stored-native']) {
        for (const permissions of ['safe', [], ['auto'], ['read']] as const) {
            await assert.rejects(createGrokSession({ ...f.options, permissions, resumeSessionId }),
                /grok_acp_restrictive_policy_unverified/);
        }
    }
    assert.equal(f.calls.length, 0); assert.equal(f.wire.length, 0); assert.equal(f.kills, 0);
});
