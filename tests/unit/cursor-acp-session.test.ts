import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpNotificationQueue } from '../../src/agent/runtime/acp/notification-queue.ts';
import { AcpSession, type AcpSessionOptions, type AcpTurnOwner } from '../../src/agent/runtime/acp/session.ts';
import { RuntimeRequests } from '../../src/agent/runtime/requests.ts';
import type { RpcFrame } from '../../src/agent/runtime/acp/wire.ts';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
}
const frame = (text = 'value'): RpcFrame => ({ jsonrpc: '2.0', method: 'session/update', params: { text } });

test('notification work is serial and terminal sealing still drains previously admitted work', async () => {
    const started = deferred(), held = deferred(), order: string[] = [];
    const queue = new AcpNotificationQueue(() => assert.fail('unexpected queue failure'));
    queue.enqueue(frame(), async () => { order.push('first'); started.resolve(); await held.promise; order.push('first-done'); });
    queue.enqueue(frame(), () => { order.push('second'); });
    await started.promise;
    assert.deepEqual(order, ['first']);
    queue.seal();
    assert.throws(() => queue.enqueue(frame(), () => {}), /acp_notification_after_terminal/);
    held.resolve();
    await queue.drain();
    assert.deepEqual(order, ['first', 'first-done', 'second']);
    assert.equal(queue.idle, true);
});
test('256 queued notifications fit and the next fails closed before retaining more', async () => {
    const failures: string[] = [], consumed: number[] = [];
    const queue = new AcpNotificationQueue(error => failures.push(error.message));
    for (let i = 0; i < 256; i++) queue.enqueue(frame(), () => { consumed.push(i); });
    assert.equal(failures.length, 0);
    queue.enqueue(frame(), () => { consumed.push(256); });
    await assert.rejects(queue.drain(), /acp_notification_limit/);
    assert.deepEqual(failures, ['acp_notification_limit']);
    assert.deepEqual(consumed, []);
    assert.equal(queue.idle, true);
});
test('notification byte admission includes active and queued envelopes', async () => {
    const held = deferred(), started = deferred();
    const failures: string[] = [];
    const queue = new AcpNotificationQueue(error => failures.push(error.message));
    const base = frame('');
    const part = frame('x'.repeat(4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(base))));
    queue.enqueue(part, async (_frame, signal) => {
        started.resolve(); signal.addEventListener('abort', held.resolve, { once: true }); await held.promise;
    });
    await started.promise;
    queue.enqueue(part, () => {});
    assert.equal(failures.length, 0);
    queue.enqueue(frame(), () => {});
    await assert.rejects(queue.drain(), /acp_notification_limit/);
    assert.deepEqual(failures, ['acp_notification_limit']);
});
test('close aborts a stalled consumer and queued work cannot apply later', async () => {
    const started = deferred(), held = deferred();
    let applied = 0, signal: AbortSignal | undefined;
    const queue = new AcpNotificationQueue(() => assert.fail('intentional close is not another failure'));
    queue.enqueue(frame(), async (_frame, current) => {
        signal = current; started.resolve(); await held.promise;
        if (!current.aborted) applied++;
    });
    queue.enqueue(frame(), () => { applied++; });
    await started.promise;
    const drain = queue.drain();
    queue.close();
    assert.equal(signal?.aborted, true);
    await assert.rejects(drain, /acp_notification_closed/);
    held.resolve();
    await Promise.resolve();
    assert.equal(applied, 0);
    assert.equal(queue.idle, true);
});
test('consumer failure is fixed-code, settles drain and reports once', async () => {
    const failures: string[] = [];
    const queue = new AcpNotificationQueue(error => failures.push(error.message));
    queue.enqueue(frame(), () => { throw new Error('private consumer text'); });
    await assert.rejects(queue.drain(), /acp_notification_consumer_failed/);
    queue.close();
    assert.deepEqual(failures, ['acp_notification_consumer_failed']);
});
test('invalid or reentrantly closed serialization cannot be retained', async () => {
    const failures: string[] = [];
    const queue = new AcpNotificationQueue(error => failures.push(error.message));
    const invalid = { ...frame(), toJSON: () => undefined };
    queue.enqueue(invalid, () => assert.fail('invalid notification consumed'));
    await assert.rejects(queue.drain(), /acp_invalid_notification/);
    const other = new AcpNotificationQueue(() => {});
    const closing = { ...frame(), toJSON() { other.close(); return frame(); } };
    assert.throws(() => other.enqueue(closing, () => assert.fail('closed notification consumed')), /acp_notification_after_terminal/);
    assert.equal(other.idle, true);
});

type Wire = Record<string, any>;
function sessionFixture(t: TestContext, options: Partial<AcpSessionOptions> = {}) {
    const writes: Wire[] = [], kills: string[] = [], failures: string[] = [];
    const changes = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 43001, exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable() });
    const configs = (model = 'm1') => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
        options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] }];
    const send = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
    const reply = (id: unknown, result: unknown) => setImmediate(() => send({ jsonrpc: '2.0', id, result }));
    const update = (kind = 'agent_message_chunk') => ({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'native-session', update: { sessionUpdate: kind, content: { type: 'text', text: 'message' } },
    } });
    let onPrompt: (message: Wire) => void = message => setImmediate(() => {
        send(update()); send({ jsonrpc: '2.0', id: message['id'], result: { stopReason: 'end_turn' } });
    });
    let onCancel: () => void = () => {};
    let onReply: (message: Wire) => void = () => {};
    let onInitialize: (message: Wire) => void = message => reply(message['id'], {
        protocolVersion: 1, authMethods: [{ id: 'cursor_login' }], agentCapabilities: { loadSession: true },
    });
    let onLoad: (message: Wire) => void = message => setImmediate(() => {
        send(update('user_message_chunk')); send(update());
        send({ jsonrpc: '2.0', id: message['id'], result: { configOptions: configs() } });
    });
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk)) as Wire;
        writes.push(message); changes.emit('change');
        switch (message['method']) {
            case 'initialize': onInitialize(message); break;
            case 'authenticate': reply(message['id'], {}); break;
            case 'session/new': reply(message['id'], { sessionId: 'native-session', configOptions: configs() }); break;
            case 'session/load': onLoad(message); break;
            case 'session/set_config_option': reply(message['id'], { configOptions: configs(message['params'].value) }); break;
            case 'session/prompt': onPrompt(message); break;
            case 'session/cancel': onCancel(); break;
            default: onReply(message);
        }
        callback();
        changes.emit('change');
    } });
    const exit = () => {
        if (child.exitCode !== null) return;
        child.exitCode = 143; child.emit('exit', 143, null); child.emit('close', 143, null);
    };
    const session = new AcpSession(child as unknown as ChildProcessWithoutNullStreams, {
        permissions: 'auto', promptTimeoutMs: 10_000, requestTimeoutMs: 10_000,
        controlTimeoutMs: 50, drainTimeoutMs: 50, registry: new RuntimeRequests(),
        ownedProcessOptions: { terminateTree: (_pid, signal) => { kills.push(signal ?? 'SIGTERM'); queueMicrotask(exit); } },
        failed: error => failures.push(error.message), ...options,
    });
    const owner: AcpTurnOwner = { binding: { runId: 'run', sessionId: 'chat', scope: 'scope', turnId: 'turn' },
        isCurrent: () => true, emit: body => ({ version: 1, seq: 1, runId: 'run', sessionId: 'chat', scope: 'scope', turnId: 'turn', ...body }) };
    t.after(async () => { await session.close(); changes.removeAllListeners(); });
    const waitFor = (predicate: () => boolean) => predicate() ? Promise.resolve() : new Promise<void>(resolve => {
        const check = () => { if (predicate()) { changes.off('change', check); resolve(); } }; changes.on('change', check);
    });
    return { session, child, writes, kills, failures, owner, send, reply, update, exit, configs, waitFor,
        start: () => session.start({ cwd: process.cwd(), authMethodId: 'cursor_login' }),
        prompt: (consume: Parameters<AcpSession['prompt']>[2] = () => {}) => session.prompt([{ type: 'text', text: 'probe' }], owner, consume),
        onPrompt: (handler: typeof onPrompt) => { onPrompt = handler; }, onCancel: (handler: typeof onCancel) => { onCancel = handler; },
        onReply: (handler: typeof onReply) => { onReply = handler; }, onInitialize: (handler: typeof onInitialize) => { onInitialize = handler; },
        onLoad: (handler: typeof onLoad) => { onLoad = handler; },
    };
}

test('session performs init/auth/new, refreshes config and reuses one session across turns', { timeout: 5000 }, async t => {
    const f = sessionFixture(t); await f.start();
    assert.deepEqual(f.writes.map(x => x['method']), ['initialize', 'authenticate', 'session/new']);
    assert.equal(f.session.nativeSessionId, 'native-session');
    await f.session.setConfigOption('model', 'm2');
    assert.equal((f.session.getConfigOptions() as Wire[])[0]!['currentValue'], 'm2');
    const notifications: RpcFrame[] = [];
    for (let i = 0; i < 3; i++) {
        assert.deepEqual(await f.prompt(frame => { notifications.push(frame); }), { stopReason: 'end_turn' });
        assert.equal(f.session.idle, true);
    }
    assert.equal(notifications.length, 3);
    assert.equal(f.writes.filter(x => x['method'] === 'session/new').length, 1);
    assert.equal(f.kills.length, 0);
});
test('load waits for an actual reply and never sends replay into a live consumer', { timeout: 5000 }, async t => {
    const f = sessionFixture(t); let loadId: unknown;
    f.onLoad(message => { loadId = message['id']; f.send(f.update()); });
    const start = f.session.start({ cwd: process.cwd(), authMethodId: 'cursor_login', resumeSessionId: 'native-session' });
    void start.catch(() => undefined); // keep the original rejection observed while the reply is held
    await f.waitFor(() => loadId !== undefined);
    assert.equal(f.session.idle, false);
    await assert.rejects(f.prompt(), /acp_prompt_unavailable/);
    f.reply(loadId, { configOptions: f.configs() }); await start;
    let updates = 0;
    await f.prompt(() => { updates++; });
    assert.equal(updates, 1);
    assert.equal(f.writes.some(x => x['method'] === 'session/new'), false);
});
test('unsupported protocol/auth/load and malformed setup retire without a prompt', { timeout: 5000 }, async t => {
    for (const mode of ['version', 'auth', 'load'] as const) {
        const f = sessionFixture(t);
        f.onInitialize(message => f.reply(message['id'], { protocolVersion: mode === 'version' ? 2 : 1,
            authMethods: mode === 'auth' ? [] : [{ id: 'cursor_login' }], agentCapabilities: { loadSession: mode !== 'load' } }));
        await assert.rejects(f.session.start({ cwd: process.cwd(), authMethodId: 'cursor_login', resumeSessionId: 'native-session' }),
            /acp_(protocol_unsupported|auth_method_unavailable|resume_unsupported)/);
        assert.equal(f.session.alive, false);
        assert.equal(f.writes.some(x => x['method'] === 'session/prompt'), false);
        assert.equal(f.kills.length, 1);
    }
});
test('stderr is drained continuously without retaining text or blocking startup', { timeout: 5000 }, async t => {
    const f = sessionFixture(t);
    f.child.stderr.write(Buffer.alloc(1024 * 1024, 120));
    await f.start(); await f.prompt();
    assert.equal(f.session.stderrBytes, 1024 * 1024);
    assert.equal(f.child.stderr.readableLength, 0);
    f.child.stderr.emit('error', new Error('private-stderr'));
    assert.equal(f.session.alive, false);
    assert.equal(f.failures[0], 'acp_stderr_error');
});
test('permission callbacks have an owner before write returns and bypass stalled notification work', { timeout: 5000 }, async t => {
    const f = sessionFixture(t); await f.start();
    const held = deferred(), permissionSeen = deferred(); let promptId: unknown;
    f.onPrompt(message => {
        promptId = message['id']; f.send(f.update());
        f.send({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: {
            sessionId: 'native-session', toolCall: { toolCallId: 'tool', title: null },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        } });
    });
    f.onReply(message => { if (message['id'] === 'permission') permissionSeen.resolve(); });
    const prompt = f.prompt(async () => held.promise);
    await permissionSeen.promise;
    assert.equal(f.writes.find(x => x['id'] === 'permission')!['result'].outcome.optionId, 'allow');
    assert.equal(f.session.idle, false);
    held.resolve(); f.reply(promptId, { stopReason: 'end_turn' });
    await prompt;
});
test('cancel can arrive before the prompt handle is assigned and reuse follows full drain', { timeout: 5000 }, async t => {
    const f = sessionFixture(t); await f.start();
    let cancellation: Promise<void> | null = null, promptId: unknown;
    f.onPrompt(message => { promptId = message['id']; cancellation = f.session.cancel(); });
    f.onCancel(() => f.reply(promptId, { stopReason: 'cancelled' }));
    const result = f.prompt();
    await f.waitFor(() => cancellation !== null);
    await cancellation;
    assert.deepEqual(await result, { stopReason: 'cancelled' });
    assert.equal(f.session.idle, true);
    const cancel = f.writes.find(x => x['method'] === 'session/cancel')!;
    assert.equal(Object.hasOwn(cancel, 'id'), false);
    f.onPrompt(message => f.reply(message['id'], { stopReason: 'end_turn' }));
    await f.prompt(); assert.equal(f.session.idle, true);
});
test('cancel deadline retires pending work and does not admit a second prompt', { timeout: 5000 }, async t => {
    const f = sessionFixture(t); await f.start();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.onPrompt(() => {});
    const prompt = f.prompt(); const cancel = f.session.cancel();
    assert.equal(f.session.cancel(), cancel);
    t.mock.timers.tick(50);
    await assert.rejects(cancel, /acp_cancel_timeout/);
    await assert.rejects(prompt, /acp_cancel_timeout/);
    await assert.rejects(f.prompt(), /acp_prompt_unavailable/);
    assert.equal(f.kills.length, 1);
});
for (const kind of ['content', 'permission'] as const) test(`post-terminal ${kind} in the same chunk cannot enter a new owner`, { timeout: 5000 }, async t => {
    const f = sessionFixture(t); await f.start();
    f.onPrompt(message => setImmediate(() => {
        const late = kind === 'content' ? f.update() : { jsonrpc: '2.0', id: 'late', method: 'session/request_permission', params: {} };
        f.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message['id'], result: { stopReason: 'end_turn' } }) + '\n' + JSON.stringify(late) + '\n');
    }));
    await assert.rejects(f.prompt(), /acp_(content_without_active_turn|request_after_terminal)/);
    assert.equal(f.session.alive, false);
    assert.equal(f.writes.some(x => x['id'] === 'late'), false);
});
test('notification drain has its own deadline after the prompt reply', { timeout: 5000 }, async t => {
    const f = sessionFixture(t); await f.start();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const started = deferred();
    const prompt = f.prompt(async (_frame, signal) => { started.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); });
    await started.promise;
    await new Promise<void>(resolve => setImmediate(resolve)); // reply and its microtasks have run
    t.mock.timers.tick(50);
    await assert.rejects(prompt, /acp_drain_timeout/);
    assert.equal(f.session.alive, false);
});
test('natural completion racing explicit cancellation retires instead of reporting a cancel acknowledgement', { timeout: 5000 }, async t => {
    const f = sessionFixture(t); await f.start(); let id: unknown;
    f.onPrompt(message => { id = message['id']; });
    f.onCancel(() => f.reply(id, { stopReason: 'end_turn' }));
    const prompt = f.prompt();
    const cancel = f.session.cancel();
    await assert.rejects(cancel, /acp_cancel_raced_completion/);
    await assert.rejects(prompt, /acp_cancel_raced_completion/);
    assert.equal(f.session.alive, false);
});
test('early child exit rejects the active turn and cleanup is idempotent', { timeout: 5000 }, async t => {
    const f = sessionFixture(t); await f.start(); f.onPrompt(() => {});
    const prompt = f.prompt(); f.exit();
    await assert.rejects(prompt, /acp_child_exit/);
    await f.session.close(); await f.session.close();
    assert.equal(f.session.idle, false);
    assert.equal(f.failures.length, 1);
});
