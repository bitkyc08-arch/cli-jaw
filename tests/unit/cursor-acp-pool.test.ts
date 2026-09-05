import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { createCursorSession, type CursorSessionOptions } from '../../src/agent/runtime/acp/cursor-session.ts';
import type { AcpSession } from '../../src/agent/runtime/acp/session.ts';
import { acquireCursorRuntime, type CursorAcquireOptions } from '../../src/agent/runtime-pool.ts';

type Wire = Record<string, any>;
function factoryFixture(t: TestContext) {
    const calls: Array<{ command: string; args: string[]; options: Wire }> = [], wire: Wire[] = [];
    const child = Object.assign(new EventEmitter(), { pid: 44001, exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable() });
    let heldInitialize = false, model = 'm1', effort = 'low', kills = 0, heldWrites = false;
    const writeCallbacks: Array<() => void> = [];
    let duringSpawn: (() => void) | undefined;
    const config = () => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
        options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort,
        options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }];
    const reply = (id: unknown, result: unknown) => setImmediate(() => {
        if (child.exitCode === null) child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    });
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk)) as Wire; wire.push(message);
        if (message['method'] === 'initialize' && !heldInitialize) reply(message['id'], {
            protocolVersion: 1, authMethods: [{ id: 'cursor_login' }], agentCapabilities: { loadSession: true } });
        if (message['method'] === 'authenticate') reply(message['id'], {});
        if (message['method'] === 'session/new' || message['method'] === 'session/load') reply(message['id'], {
            sessionId: message['params'].sessionId ?? 'native-factory', configOptions: config() });
        if (message['method'] === 'session/set_config_option') {
            if (message['params'].configId === 'model') model = message['params'].value;
            else effort = message['params'].value;
            reply(message['id'], { configOptions: config() });
        }
        if (heldWrites) writeCallbacks.push(callback); else callback();
    } });
    const exit = () => { if (child.exitCode !== null) return; child.exitCode = 143; child.emit('exit', 143, null); child.emit('close', 143, null); };
    const options: CursorSessionOptions = { binary: 'cursor-agent', env: { PATH: '/fixture' }, cwd: process.cwd(),
        permissions: ['read'], promptTimeoutMs: 10_000, model: 'm2', effort: 'high',
        spawnImpl: ((command: string, args: string[], opts: Wire) => {
            calls.push({ command, args, options: opts }); duringSpawn?.(); return child;
        }) as unknown as typeof spawn,
        ownedProcessOptions: { terminateTree: () => { kills++; queueMicrotask(exit); } } };
    t.after(() => { exit(); for (const done of writeCallbacks.splice(0)) done(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
    return { options, calls, wire, child, get kills() { return kills; },
        holdInitialize: () => { heldInitialize = true; }, holdWrites: () => { heldWrites = true; },
        duringSpawn: (fn: () => void) => { duringSpawn = fn; } };
}

test('factory uses acp stdin protocol and refreshes model/effort without print argv', { timeout: 5000 }, async t => {
    const f = factoryFixture(t);
    const session = await createCursorSession(f.options);
    assert.deepEqual(f.calls[0]!.args, ['acp']);
    assert.equal(f.calls[0]!.options['shell'], false);
    assert.deepEqual(f.wire.map(x => x['method']), ['initialize', 'authenticate', 'session/new', 'session/set_config_option', 'session/set_config_option']);
    assert.equal(f.wire[0]!['params'].clientCapabilities._meta.parameterizedModelPicker, true);
    assert.equal((session.getConfigOptions() as Wire[])[0]!['currentValue'], 'm2');
    assert.equal((session.getConfigOptions() as Wire[])[1]!['currentValue'], 'high');
    assert.equal(session.idle, true);
    await session.close();
    assert.equal(f.kills, 1);
});
test('factory validates options and pre-abort before spawning', { timeout: 5000 }, async t => {
    const f = factoryFixture(t); const controller = new AbortController(); controller.abort();
    for (const patch of [{ promptTimeoutMs: 0 }, { permissions: 'bad' }, { cwd: '/fixture/does-not-exist' }, { signal: controller.signal }]) {
        await assert.rejects(createCursorSession({ ...f.options, ...patch }));
    }
    assert.equal(f.calls.length, 0);
});
test('factory abort covers both spawn-to-listener race and held initialization', { timeout: 5000 }, async t => {
    const early = factoryFixture(t); const before = new AbortController();
    early.duringSpawn(() => before.abort());
    await assert.rejects(createCursorSession({ ...early.options, signal: before.signal }), /acquire_aborted/);
    assert.equal(early.kills, 1);
    const f = factoryFixture(t); f.holdInitialize(); const controller = new AbortController();
    const pending = createCursorSession({ ...f.options, signal: controller.signal });
    const rejected = assert.rejects(pending, /acquire_aborted/);
    assert.equal(f.wire[0]!['method'], 'initialize');
    controller.abort(); await rejected;
    assert.equal(f.kills, 1);
    assert.equal(f.child.exitCode, 143);
});
test('unsupported requested configuration retires startup without a prompt or fallback', { timeout: 5000 }, async t => {
    const f = factoryFixture(t);
    await assert.rejects(createCursorSession({ ...f.options, model: 'unadvertised' }), /acp_config_unsupported_model/);
    assert.equal(f.kills, 1);
    assert.equal(f.wire.some(x => x['method'] === 'session/prompt'), false);
});
test('factory loads an explicit native ID and detaches acquisition abort after success', { timeout: 5000 }, async t => {
    const f = factoryFixture(t); const controller = new AbortController();
    const session = await createCursorSession({ ...f.options, resumeSessionId: 'stored-native', signal: controller.signal });
    assert.equal(session.nativeSessionId, 'stored-native');
    assert.equal(f.wire.find(x => x['method'] === 'session/load')!['params'].sessionId, 'stored-native');
    assert.equal(f.wire.some(x => x['method'] === 'session/new'), false);
    controller.abort();
    assert.equal(session.alive, true);
    await session.close();
});
test('Windows direct launch uses the resolver and unknown native wrappers fail before spawn', { timeout: 5000 }, async t => {
    const f = factoryFixture(t);
    const session = await createCursorSession({ ...f.options, platform: 'win32', binary: 'C:\\cursor-agent.exe' });
    assert.equal(f.calls[0]!.command, 'C:\\cursor-agent.exe');
    assert.deepEqual(f.calls[0]!.args, ['acp']);
    await session.close();
    const refused = factoryFixture(t);
    await assert.rejects(createCursorSession({ ...refused.options, platform: 'win32', binary: 'C:\\unknown.ps1' }), /launch_unsupported/);
    assert.equal(refused.calls.length, 0);
});

let nextScope = 0, nextSession = 0;
class PoolSession {
    child = new EventEmitter();
    alive = true; idle = true; nativeSessionId = 'pool-native-' + (++nextSession);
    cancellations = 0; retirements = 0;
    cancelImpl: () => Promise<void> = () => Promise.resolve();
    cancel(): Promise<void> { this.cancellations++; return this.cancelImpl(); }
    retire(): void { if (!this.alive) return; this.alive = false; this.idle = false; this.retirements++; this.child.emit('exit', 1); }
    async close(): Promise<void> { this.retire(); }
}
function poolFixture(t: TestContext) {
    const sessions: PoolSession[] = [], creations: CursorSessionOptions[] = [];
    let generation = 0, admitted = true;
    const options: CursorAcquireOptions = { key: { scopeKey: 'cursor-pool-test-' + (++nextScope), cwd: process.cwd(), model: 'm1', effort: '', permissions: ['read'] },
        binary: 'fixture-cursor', env: {}, promptTimeoutMs: 10_000, persistenceOwner: { global: 0, scope: 0 }, waitMs: 1000,
        isCurrentOwner: owner => owner.global === generation && owner.scope === 0, canAcquire: () => admitted,
        createSession: async input => {
            creations.push(input); const session = new PoolSession();
            if (input.resumeSessionId) session.nativeSessionId = input.resumeSessionId;
            sessions.push(session); return session as unknown as AcpSession;
        } };
    t.after(() => { for (const session of sessions) session.retire(); });
    return { options, sessions, creations, invalidate: () => { generation++; }, rejectAdmission: () => { admitted = false; } };
}

test('cursor pool reuses a drained scoped session and old released cancellation cannot touch its borrower', async t => {
    const f = poolFixture(t); const a = await acquireCursorRuntime(f.options); a.release();
    const b = await acquireCursorRuntime(f.options);
    assert.equal(b.reused, true); assert.equal(a.session, b.session);
    await a.cancel(); assert.equal(f.sessions[0]!.cancellations, 0);
    b.release(); assert.equal(f.creations.length, 1);
});
test('scope, model and permission identity isolate or replace sessions', async t => {
    const f = poolFixture(t); const a = await acquireCursorRuntime(f.options); a.release();
    const other = await acquireCursorRuntime({ ...f.options, key: { ...f.options.key, scopeKey: 'other-' + f.options.key.scopeKey } });
    assert.notEqual(a.session, other.session); other.release();
    const changed = await acquireCursorRuntime({ ...f.options, key: { ...f.options.key, model: 'm2', permissions: 'auto' } });
    assert.notEqual(changed.session, a.session); assert.equal(f.sessions[0]!.retirements, 1);
    changed.release();
});
test('generation and caller admission checks run before stale replacement side effects', async t => {
    const f = poolFixture(t); const a = await acquireCursorRuntime(f.options); a.release();
    f.rejectAdmission();
    await assert.rejects(acquireCursorRuntime({ ...f.options, forceNew: true }), /ownership invalidated/);
    assert.equal(f.sessions[0]!.alive, true);
    const g = poolFixture(t); const first = await acquireCursorRuntime(g.options); first.release(); g.invalidate();
    await assert.rejects(acquireCursorRuntime(g.options), /ownership invalidated/);
    const second = await acquireCursorRuntime({ ...g.options, persistenceOwner: { global: 1, scope: 0 } });
    assert.notEqual(first.session, second.session); assert.equal(g.sessions[0]!.retirements, 1); second.release();
});
test('release-before-idle retires and late cancel rejection cannot kill the next borrower', async t => {
    const f = poolFixture(t); const a = await acquireCursorRuntime(f.options);
    f.sessions[0]!.idle = false; a.release();
    assert.equal(f.sessions[0]!.retirements, 1);
    const b = await acquireCursorRuntime(f.options);
    let reject!: (error: Error) => void;
    f.sessions[1]!.cancelImpl = () => new Promise((_resolve, no) => { reject = no; });
    const cancellation = b.cancel(); b.release();
    const c = await acquireCursorRuntime(f.options);
    reject(new Error('late cancel failure')); await cancellation;
    assert.equal(f.sessions[1]!.alive, true); assert.equal(c.session, b.session); c.release();
});
test('startup expiry aborts the creating child and late completion cannot remove a replacement', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 0; t.mock.method(performance, 'now', () => now);
    const f = poolFixture(t); const started = deferred(); let release!: (session: AcpSession) => void;
    const old = new PoolSession(); f.sessions.push(old);
    let signal: AbortSignal | undefined;
    const pending = acquireCursorRuntime({ ...f.options, waitMs: 20, createSession: async input => {
        signal = input.signal; signal!.addEventListener('abort', () => old.retire(), { once: true }); started.resolve();
        return new Promise<AcpSession>(resolve => { release = resolve; });
    } });
    const rejected = assert.rejects(pending, /timed out/);
    await started.promise; now = 20; t.mock.timers.tick(20); await rejected;
    assert.equal(signal?.aborted, true); assert.equal(old.retirements, 1);
    const replacement = await acquireCursorRuntime(f.options);
    release(old as unknown as AcpSession);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(replacement.runtime.alive, true); replacement.release();
    const reused = await acquireCursorRuntime(f.options); assert.equal(reused.session, replacement.session); reused.release();
});
test('force-new creation replacement and caller abort close only the captured attempt', async t => {
    const f = poolFixture(t); const started = deferred(); const controller = new AbortController();
    let release!: (session: AcpSession) => void;
    const old = new PoolSession(); f.sessions.push(old);
    const pending = acquireCursorRuntime({ ...f.options, signal: controller.signal, createSession: async input => {
        input.signal!.addEventListener('abort', () => old.retire(), { once: true }); started.resolve();
        return new Promise<AcpSession>(resolve => { release = resolve; });
    } });
    const rejected = assert.rejects(pending, /replaced|aborted/);
    await started.promise;
    const replacement = await acquireCursorRuntime({ ...f.options, forceNew: true });
    controller.abort(); await rejected;
    release(old as unknown as AcpSession); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(old.retirements, 1); assert.equal(replacement.runtime.alive, true); replacement.release();
});
test('busy acquisition abort removes its waiter without cancelling the current lease', async t => {
    const f = poolFixture(t); const current = await acquireCursorRuntime(f.options); const controller = new AbortController();
    const pending = acquireCursorRuntime({ ...f.options, signal: controller.signal });
    const rejected = assert.rejects(pending, /aborted/); controller.abort(); await rejected;
    assert.equal(f.sessions[0]!.alive, true); current.release();
    const next = await acquireCursorRuntime(f.options); assert.equal(next.session, current.session); next.release();
});
test('repeated wakeups use the original total acquisition deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 0; t.mock.method(performance, 'now', () => now);
    const f = poolFixture(t); const first = await acquireCursorRuntime(f.options);
    const waiting = acquireCursorRuntime({ ...f.options, waitMs: 20 });
    let error: unknown;
    void waiting.catch(value => { error = value; });
    now = 10; t.mock.timers.tick(10); first.release();
    const second = await acquireCursorRuntime(f.options);
    now = 19; t.mock.timers.tick(9); second.release();
    const third = await acquireCursorRuntime(f.options);
    now = 20; t.mock.timers.tick(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(error instanceof Error);
    await assert.rejects(waiting, /timed out/);
    assert.equal(f.sessions[0]!.alive, true); third.release();
});
test('pool deadline aborts the actual factory while its initialize RPC is held', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 0; t.mock.method(performance, 'now', () => now);
    const f = poolFixture(t), child = factoryFixture(t); child.holdInitialize();
    const pending = acquireCursorRuntime({ ...f.options, waitMs: 20, createSession: options => createCursorSession({
        ...options, spawnImpl: child.options.spawnImpl, ownedProcessOptions: child.options.ownedProcessOptions,
    }) });
    const rejected = assert.rejects(pending, /timed out/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(child.wire[0]!['method'], 'initialize');
    now = 20; t.mock.timers.tick(20); await rejected;
    assert.equal(child.kills, 1);
    assert.equal(child.child.exitCode, 143);
});
test('invalid new options cannot discard an existing healthy entry', async t => {
    const f = poolFixture(t); const lease = await acquireCursorRuntime(f.options); lease.release();
    await assert.rejects(acquireCursorRuntime({ ...f.options, forceNew: true, promptTimeoutMs: 0 }), /acp_invalid_timeout/);
    assert.equal(f.sessions[0]!.alive, true);
    assert.equal(f.creations.length, 1);
});
test('missing logical admission cannot force-new a healthy generation-valid entry', async t => {
    const f = poolFixture(t); const first = await acquireCursorRuntime(f.options); first.release();
    const missing: Partial<CursorAcquireOptions> = { ...f.options, forceNew: true };
    delete missing.canAcquire;
    await assert.rejects(acquireCursorRuntime(missing as CursorAcquireOptions), /admission|ownership/);
    assert.equal(f.sessions[0]!.alive, true);
    assert.equal(f.creations.length, 1);
});
test('a backpressured real-session refusal between release and borrow cannot be reused', { timeout: 5000 }, async t => {
    const f = poolFixture(t), children: ReturnType<typeof factoryFixture>[] = [];
    const opts: CursorAcquireOptions = { ...f.options, createSession: options => {
        const child = factoryFixture(t); children.push(child);
        return createCursorSession({ ...options, spawnImpl: child.options.spawnImpl, ownedProcessOptions: child.options.ownedProcessOptions });
    } };
    const first = await acquireCursorRuntime(opts); first.release();
    children[0]!.holdWrites();
    children[0]!.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'unexpected', method: 'session/request_permission', params: {} }) + '\n');
    assert.equal(first.session.alive, true); assert.equal(first.session.idle, false);
    const second = await acquireCursorRuntime(opts);
    assert.notEqual(second.session, first.session);
    assert.equal(children[0]!.kills, 1);
    second.release(); await second.session.close();
});
test('a new generation supersedes held creation without inheriting its wait', { timeout: 5000 }, async t => {
    const f = poolFixture(t), started = deferred();
    let release!: (session: AcpSession) => void;
    const old = new PoolSession(); f.sessions.push(old);
    const pending = acquireCursorRuntime({ ...f.options, waitMs: 100, createSession: async options => {
        options.signal!.addEventListener('abort', () => old.retire(), { once: true }); started.resolve();
        return new Promise<AcpSession>(resolve => { release = resolve; });
    } });
    const rejected = assert.rejects(pending, /replaced|invalidated|superseded|timed out/);
    await started.promise; f.invalidate();
    const next = await acquireCursorRuntime({ ...f.options, persistenceOwner: { global: 1, scope: 0 } });
    await rejected;
    release(old as unknown as AcpSession); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(old.retirements, 1); assert.equal(next.runtime.alive, true); next.release();
});
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
}
