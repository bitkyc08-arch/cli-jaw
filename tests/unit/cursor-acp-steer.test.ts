import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { spawn } from 'node:child_process';
import { launchControlAgent } from '../fixtures/native-acp-control.mjs';
import type { RemoteTarget } from '../../src/messaging/types.ts';

const root = fs.mkdtempSync(join(tmpdir(), 'cursor-main-control-'));
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: () => ({ available: true, path: process.execPath }) } });
const factory = await import('../../src/agent/runtime/acp/cursor-session.ts');
const peers: ReturnType<typeof launchControlAgent>[] = [];
const sessions: Awaited<ReturnType<typeof factory.createCursorSession>>[] = [];
let mode = 'held';
test.mock.module('../../src/agent/runtime/acp/cursor-session.js', { namedExports: { ...factory,
    createCursorSession: async (input: Parameters<typeof factory.createCursorSession>[0]) => {
        const peer = launchControlAgent(root, mode); peers.push(peer);
        // Preserve the real factory/session/pool; only executable launch is substituted.
        const spawnImpl = (() => peer.child) as typeof spawn;
        const session = await factory.createCursorSession({ ...input, spawnImpl,
            requestTimeoutMs: 2000, controlTimeoutMs: 600, drainTimeoutMs: 2000 });
        sessions.push(session); return session;
    } } });
const agent = await import('../../src/agent/spawn.ts');
const gateway = await import('../../src/orchestrator/gateway.ts');
const submissions: Parameters<typeof gateway.submitMessage>[] = [];
test.mock.module('../../src/orchestrator/gateway.js', { namedExports: { ...gateway,
    submitMessage: (...args: Parameters<typeof gateway.submitMessage>) => {
        submissions.push(args); return gateway.submitMessage(...args);
    } } });
const { steerHandler } = await import('../../src/cli/handlers-runtime.ts');
const { withSessionScope } = await import('../../src/core/session-context.ts');
const { db, insertMessage } = await import('../../src/core/db.ts');
const { createChatSession } = await import('../../src/core/chat-sessions.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { poolStats } = await import('../../src/agent/runtime-pool.ts');
const { clearGoalTimers } = await import('../../src/agent/lifecycle-handler.ts');
let serial = 0;
type Event = { event: string; data: Record<string, unknown> };
test.beforeEach(t => {
    mode = 'held'; submissions.length = 0;
    config.settings.cli = 'cursor'; config.settings.workingDir = root; config.settings.projectDirs = [root];
    config.settings.permissions = 'auto'; config.settings.fallbackOrder = []; config.settings.activeOverrides = {};
    config.settings.perCli = { ...config.settings.perCli, cursor: { model: 'default', effort: '', transport: 'native' } };
    config.settings.memory = { ...config.settings.memory, enabled: false };
    config.settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
    fs.mkdirSync(join(config.JAW_HOME, 'prompts'), { recursive: true });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network in owned ACP test'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
});
test.afterEach(async () => {
    for (const item of [...agent.messageQueue]) agent.removeQueuedMessage(item.id);
    for (const session of sessions.splice(0)) await session.close();
    for (const peer of peers.splice(0)) {
        if (peer.child.exitCode === null && peer.child.signalCode === null) peer.child.kill();
        await peer.exited;
    }
    clearGoalTimers(); assert.equal(poolStats().busy, 0);
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function options(target?: RemoteTarget) {
    const id = ++serial;
    return { cli: 'cursor', model: 'default', effort: '', origin: 'web',
        scopeKey: `control-scope-${id}`, chatSessionId: createChatSession(`control-chat-${id}`).id, requestId: `control-request-${id}`,
        sysPrompt: 'OPERATIONAL_SENTINEL: keep output local.', _skipHistory: true, _isSmokeContinuation: true,
        ...(target ? { target } : {}) };
}
function rows(session: string) {
    return db.prepare('SELECT role, content FROM messages WHERE session_id=? ORDER BY id').all(session);
}
async function start(t: test.TestContext, target?: RemoteTarget) {
    const opts = options(target), events: Event[] = [], firstPartial = Promise.withResolvers<void>();
    let exits = 0;
    const off = subscribe(event => {
        if (event.data['scope'] !== opts.scopeKey && event.data['sessionId'] !== opts.chatSessionId) return;
        events.push(event);
        if (event.event === 'agent_runtime' && event.data['kind'] === 'message') firstPartial.resolve();
    });
    t.after(off);
    const run = agent.spawnAgent('ORIGINAL_A: continue old task.', { ...opts, lifecycle: { onExit: () => { exits++; } } });
    await firstPartial.promise;
    const peer = peers.at(-1)!;
    await peer.waitFor(value => value.kind === 'prompt');
    const owner = agent.activeMainProcesses.get(opts.scopeKey)!;
    assert.equal(typeof owner.replaceTurn, 'function', 'actual main must install the replacement hook');
    assert.equal(owner.steerTurnInBand, undefined);
    const slash = (instruction: string) => withSessionScope({ scope: opts.scopeKey, chatSessionId: opts.chatSessionId },
        () => steerHandler([instruction], { interface: 'web', locale: 'en' }));
    const prompts = () => peer.records.filter(value => value.kind === 'prompt');
    const noFinal = () => {
        assert.equal(exits, 0);
        assert.equal(events.some(event => event.event === 'agent_done' || event.event === 'agent_runtime' && event.data['kind'] === 'turn-end'), false);
        assert.equal(rows(opts.chatSessionId).some(row => (row as { role: string }).role === 'assistant'), false);
        assert.equal(agent.activeMainProcesses.get(opts.scopeKey), owner); assert.equal(poolStats().busy, 1);
    };
    return { opts, events, run, peer, owner, slash, prompts, noFinal, exits: () => exits };
}

test('actual /steer A -> B -> C preserves PID/SID/logical run and reinjects only accepted context', { timeout: 10000 }, async t => {
    const f = await start(t);
    const b = f.slash('REDIRECT_B: change to the second task.');
    await f.peer.waitFor(value => value.kind === 'cancel'); f.noFinal();
    const queued = await f.slash('QUEUED_ONLY: must not enter C context.');
    assert.equal(queued.ok, true); assert.equal(submissions.length, 1);
    assert.equal(submissions[0]![1].midRunPolicy, 'followup');
    assert.equal(agent.messageQueue.length, 1); assert.equal(f.prompts().length, 1);
    await assert.rejects(agent.steerAgent(f.opts.scopeKey, 'FOREIGN_ONLY', 'web', { chatSessionId: 'foreign-chat' }), /owner/i);
    await f.peer.command('release-cancel'); assert.equal((await b).ok, true);
    await f.peer.waitFor(value => value.kind === 'prompt' && value.index === 2); f.noFinal();
    const c = f.slash('CURRENT_C: stop old tasks and answer C only.');
    await f.peer.waitFor(value => value.kind === 'cancel' && value.index === 2); f.noFinal();
    await f.peer.command('release-cancel'); assert.equal((await c).ok, true);
    await f.peer.waitFor(value => value.kind === 'prompt' && value.index === 3); f.noFinal();
    const [aWire, bWire, cWire] = f.prompts().map(value => String(value.prompt));
    assert.match(aWire!, /OPERATIONAL_SENTINEL/); assert.match(aWire!, /ORIGINAL_A/);
    assert.match(bWire!, /<partial_output>\nPARTIAL_1_LATE_1\n<\/partial_output>/);
    assert.match(bWire!, /\[Previous request - read-only context\]\nORIGINAL_A: continue old task\./);
    assert.match(cWire!, /\[Accepted redirect - read-only context\]\nREDIRECT_B: change to the second task\./);
    assert.ok(cWire!.endsWith('[Current Message]\nCURRENT_C: stop old tasks and answer C only.'));
    for (const prompt of [bWire!, cWire!]) {
        assert.equal(prompt.split('OPERATIONAL_SENTINEL').length - 1, 1);
        assert.equal(prompt.split('ORIGINAL_A').length - 1, 1);
        assert.doesNotMatch(prompt, /QUEUED_ONLY|FOREIGN_ONLY/);
    }
    const initial = rows(f.opts.chatSessionId)[0] as { role: string; content: string };
    assert.equal(initial.role, 'user'); assert.ok(initial.content.endsWith('\nORIGINAL_A: continue old task.'));
    assert.deepEqual(rows(f.opts.chatSessionId).slice(1), [
        { role: 'user', content: 'REDIRECT_B: change to the second task.' },
        { role: 'user', content: 'CURRENT_C: stop old tasks and answer C only.' },
    ]);
    // Prevent the intentionally queued independent followup from starting at final release.
    agent.removeQueuedMessage(agent.messageQueue[0]!.id);
    await f.peer.command('finish', { text: '_C_FINAL' });
    const result = await f.run.promise;
    assert.equal(result.code, 0); assert.equal(result.text, 'PARTIAL_3_C_FINAL');
    assert.equal(new Set(f.prompts().map(value => value.pid)).size, 1);
    assert.equal(new Set(f.prompts().map(value => value.sid)).size, 1);
    const runtime = f.events.filter(event => event.event === 'agent_runtime');
    assert.equal(new Set(runtime.map(event => event.data['runId'])).size, 1);
    assert.equal(runtime.filter(event => event.data['kind'] === 'turn-end').length, 1);
    assert.equal(f.events.filter(event => event.event === 'agent_done').length, 1);
    assert.equal(f.events.filter(event => event.event === 'steer_started').length, 2);
    assert.equal(rows(f.opts.chatSessionId).length, 4);
    assert.equal(agent.activeMainProcesses.has(f.opts.scopeKey), false); assert.equal(poolStats().busy, 0);
    assert.equal(f.owner.replaceTurn, undefined);
    assert.equal(f.exits(), 1);
});

test('fast Node B completion still records raw input/events before the sole main MESSAGE', { timeout: 10000 }, async t => {
    mode = 'fast'; const f = await start(t);
    const response = Promise.withResolvers<void>(), written = Promise.withResolvers<() => void>();
    const stream = f.peer.child.stdin!, write = stream.write;
    const sawResponse = (chunk: Buffer) => { if (String(chunk).includes('FAST_FINAL')) response.resolve(); };
    f.peer.child.stdout!.on('data', sawResponse);
    t.after(() => f.peer.child.stdout!.off('data', sawResponse));
    t.mock.method(stream, 'write', function (...args: unknown[]) {
        if (String(args[0]).includes('"method":"session/prompt"')) {
            const callback = args.at(-1);
            assert.equal(typeof callback, 'function');
            args[args.length - 1] = (...values: unknown[]) => {
                let released = false;
                written.resolve(() => {
                    if (released) return;
                    released = true;
                    Reflect.apply(callback as (...values: unknown[]) => void, undefined, values);
                });
            };
        }
        return Reflect.apply(write, stream, args);
    });
    const redirect = f.slash('FAST_B_RAW');
    const releaseWrite = await written.promise;
    t.after(releaseWrite);
    await response.promise; f.noFinal();
    assert.equal(rows(f.opts.chatSessionId).length, 1, 'B must not persist before local dispatch completes');
    releaseWrite(); assert.equal((await redirect).ok, true);
    const result = await f.run.promise;
    await f.peer.waitFor(value => value.kind === 'prompt' && value.index === 2);
    assert.equal(result.text, 'FAST_FINAL'); assert.equal(submissions.length, 0);
    assert.deepEqual(rows(f.opts.chatSessionId).slice(1), [
        { role: 'user', content: 'FAST_B_RAW' }, { role: 'assistant', content: 'FAST_FINAL' },
    ]);
    const input = f.events.findIndex(event => event.event === 'new_message' && event.data['content'] === 'FAST_B_RAW');
    const steer = f.events.findIndex(event => event.event === 'steer_started');
    const terminal = f.events.findIndex(event => event.event === 'agent_done');
    assert.ok(input >= 0 && input < steer && steer < terminal);
    assert.equal(f.events.filter(event => event.event === 'agent_done').length, 1);
    assert.equal(f.events.filter(event => event.event === 'agent_runtime' && event.data['kind'] === 'turn-end').length, 1);
});

for (const failure of ['missing-cancel', 'exit-on-cancel', 'commit'] as const) {
    test(`actual slash ${failure} is fatal with zero queue/retry`, { timeout: 10000 }, async t => {
        mode = failure === 'commit' ? 'fast' : failure;
        const f = await start(t); let attempts = 0;
        if (failure === 'commit') t.mock.method(insertMessage, 'run', () => { attempts++; throw new Error('PRIVATE_INSERT_FAILURE'); });
        await assert.rejects(f.slash('FAILED_B'));
        const result = await f.run.promise;
        assert.notEqual(result.code, 0); assert.equal(result.runtimeOutcome?.finalText, null);
        if (failure === 'commit') await f.peer.waitFor(value => value.kind === 'prompt' && value.index === 2);
        assert.equal(submissions.length, 0); assert.equal(agent.messageQueue.length, 0);
        assert.equal(f.prompts().length, failure === 'commit' ? 2 : 1);
        assert.equal(attempts, failure === 'commit' ? 1 : 0);
        assert.equal(rows(f.opts.chatSessionId).some(row => (row as { content: string }).content === 'FAILED_B'), false);
        assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_INSERT_FAILURE/);
        assert.equal(agent.activeMainProcesses.has(f.opts.scopeKey), false);
    });
}

test('captured Slack target is retained while foreign target/chat/scope cannot redirect or persist', { timeout: 10000 }, async t => {
    const target: RemoteTarget = { channel: 'slack', targetKind: 'channel', peerKind: 'channel',
        targetId: 'C_FIXTURE', threadId: '123.456', guildId: 'T_FIXTURE' };
    const f = await start(t, target);
    for (const meta of [{ chatSessionId: 'foreign' }, { target: { ...target, targetId: 'C_FOREIGN' } },
        { target: { ...target, threadId: '999.000' } }, { remoteKey: 'foreign-binding' }]) {
        await assert.rejects(agent.steerAgent(f.opts.scopeKey, 'FOREIGN_TARGET', 'web', meta), /owner/i);
    }
    assert.equal((await withSessionScope({ scope: 'foreign-scope', chatSessionId: f.opts.chatSessionId },
        () => steerHandler(['FOREIGN_SCOPE'], { interface: 'web', locale: 'en' }))).ok, false);
    assert.equal(f.peer.records.some(value => value.kind === 'cancel'), false);
    const accepted = agent.steerAgent(f.opts.scopeKey, 'REMOTE_B', 'web', { target, chatSessionId: f.opts.chatSessionId });
    await f.peer.waitFor(value => value.kind === 'cancel');
    // Caller mutation after admission must not alter the captured prompt/event target.
    target.targetId = 'C_MUTATED';
    await f.peer.command('release-cancel'); assert.equal(await accepted, 'steered');
    await f.peer.waitFor(value => value.kind === 'prompt' && value.index === 2);
    const prompt = String(f.prompts()[1]!.prompt);
    assert.match(prompt, /Current Slack conversation: channel_id=C_FIXTURE; thread_ts=123\.456/);
    assert.doesNotMatch(prompt, /C_MUTATED|FOREIGN_TARGET|FOREIGN_SCOPE/);
    const event = f.events.find(value => value.event === 'steer_started')!;
    assert.equal((event.data['target'] as RemoteTarget).targetId, 'C_FIXTURE');
    assert.deepEqual(rows(f.opts.chatSessionId).slice(1), [{ role: 'user', content: 'REMOTE_B' }]);
    await f.peer.command('finish', { text: '_REMOTE_FINAL' }); await f.run.promise;
});

test('main Stop during cancellation suppresses B and reuses the same idle native process safely', { timeout: 10000 }, async t => {
    const f = await start(t);
    // Direct outcome/reuse control; the ingress regressions below verify no resubmission.
    const redirect = agent.steerAgent(f.opts.scopeKey, 'STOPPED_B', 'web', { chatSessionId: f.opts.chatSessionId });
    await f.peer.waitFor(value => value.kind === 'cancel');
    assert.equal(agent.killActiveAgent(f.opts.scopeKey, 'user'), true);
    await f.peer.command('release-cancel');
    assert.equal(await redirect, 'cancelled');
    const stopped = await f.run.promise;
    assert.equal(stopped.runtimeOutcome?.status, 'stopped'); assert.equal(stopped.runtimeOutcome.finalText, null);
    assert.equal(f.prompts().length, 1); assert.equal(f.owner.replaceTurn, undefined);
    assert.equal(rows(f.opts.chatSessionId).some(row => (row as { content: string }).content === 'STOPPED_B'), false);
    assert.equal(poolStats().busy, 0);
    const next = agent.spawnAgent('NEXT_RUN_D', { ...f.opts, requestId: 'next-' + f.opts.requestId });
    await f.peer.waitFor(value => value.kind === 'prompt' && value.index === 2);
    assert.equal(peers.length, 1); assert.doesNotMatch(String(f.prompts()[1]!.prompt), /STOPPED_B/);
    await f.peer.command('finish', { text: '_D_FINAL' });
    assert.equal((await next.promise).text, 'PARTIAL_2_D_FINAL');
    assert.equal(new Set(f.prompts().map(value => value.pid)).size, 1);
    assert.equal(new Set(f.prompts().map(value => value.sid)).size, 1);
});

for (const ingress of ['slash', 'gateway'] as const) {
    test(`WP12-STOP-RESUBMIT: actual ${ingress} cancels pending B after Stop without queue or resurrection`, { timeout: 10000 }, async t => {
        const f = await start(t), instruction = `STOPPED_${ingress}_B`;
        let requestId: string | undefined;
        const redirect = ingress === 'slash' ? f.slash(instruction) : undefined;
        if (ingress === 'gateway') {
            const result = gateway.submitMessage(instruction, { origin: 'web', scope: f.opts.scopeKey,
                chatSessionId: f.opts.chatSessionId, midRunPolicy: 'steer' });
            assert.equal(result.action, 'started'); assert.equal(result.disposition, 'steered');
            requestId = result.requestId; assert.ok(requestId);
        }
        try {
            await f.peer.waitFor(value => value.kind === 'cancel'); f.noFinal();
            assert.equal(agent.killActiveAgent(f.opts.scopeKey, 'user'), true);
            await f.peer.command('release-cancel');
            if (redirect) assert.equal((await redirect).ok, true);
            assert.equal((await f.run.promise).runtimeOutcome?.status, 'stopped');
            // Let detached gateway continuations finish; never await a receipt the buggy
            // branch leaves pending in its queue. No sleep or vendor work is required.
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.deepEqual({ resubmissions: submissions.length,
                queued: agent.messageQueue.filter(item => item.scope === f.opts.scopeKey).length,
                queueAdmissions: f.events.filter(event => event.event === 'queue_update'
                    && Array.isArray(event.data['queued'])
                    && event.data['queued'].some((item: { prompt: string }) => item.prompt === instruction)).length,
                prompts: f.prompts().length,
                userRows: rows(f.opts.chatSessionId).filter(row => (row as { role: string; content: string }).role === 'user'
                    && (row as { content: string }).content === instruction).length,
            }, { resubmissions: 0, queued: 0, queueAdmissions: 0, prompts: 1, userRows: 0 });
            assert.equal(agent.activeMainProcesses.has(f.opts.scopeKey), false);
            if (requestId) {
                const receipts = f.events.filter(event => event.event === 'request_settled' && event.data['requestId'] === requestId);
                assert.equal(receipts.length, 1);
                assert.equal(receipts[0]!.data['outcome'], 'cancelled');
                assert.equal(receipts[0]!.data['reason'], 'native-steer-stopped');
                assert.equal(receipts[0]!.data['scope'], f.opts.scopeKey);
                assert.equal(receipts[0]!.data['sessionId'], f.opts.chatSessionId);
            }
        } finally {
            // A RED implementation may have queued B. Remove only this fixture's
            // queue entries before the existing bounded session/owned-child teardown.
            for (const item of [...agent.messageQueue]) {
                if (item.scope === f.opts.scopeKey) agent.removeQueuedMessage(item.id);
            }
        }
    });
}

test('WP12-STOP-BUSY-C: actual gateway cannot enqueue busy C after immediate Stop', { timeout: 10000 }, async t => {
    const f = await start(t), instruction = 'STOPPED_BUSY_C';
    const b = agent.steerAgent(f.opts.scopeKey, 'PENDING_B', 'web', { chatSessionId: f.opts.chatSessionId });
    void b.catch(() => {});
    try {
        await f.peer.waitFor(value => value.kind === 'cancel'); f.noFinal();
        const c = gateway.submitMessage(instruction, { origin: 'web', scope: f.opts.scopeKey,
            chatSessionId: f.opts.chatSessionId, midRunPolicy: 'steer' });
        // Intentionally no await: C has observed busy but its consumer has not yet
        // processed the asynchronous fallback when the user cancels the scope.
        const stopped = agent.killActiveAgent(f.opts.scopeKey, 'user');
        assert.equal(stopped, true); assert.equal(c.action, 'started'); assert.ok(c.requestId);
        await f.peer.command('release-cancel');
        assert.equal(await b, 'cancelled');
        assert.equal((await f.run.promise).runtimeOutcome?.status, 'stopped');
        await new Promise<void>(resolve => setImmediate(resolve));
        const receipts = f.events.filter(event => event.event === 'request_settled' && event.data['requestId'] === c.requestId);
        assert.deepEqual({
            queueAdmissions: f.events.filter(event => event.event === 'queue_update'
                && Array.isArray(event.data['queued'])
                && event.data['queued'].some((item: { prompt: string }) => item.prompt === instruction)).length,
            queued: agent.messageQueue.filter(item => item.scope === f.opts.scopeKey).length,
            prompts: peers.flatMap(peer => peer.records.filter(value => value.kind === 'prompt')).length,
            userRows: rows(f.opts.chatSessionId).filter(row => (row as { role: string }).role === 'user'
                && (row as { content: string }).content.includes(instruction)).length,
            settlements: receipts.length, outcome: receipts[0]?.data['outcome'],
        }, { queueAdmissions: 0, queued: 0, prompts: 1, userRows: 0, settlements: 1, outcome: 'cancelled' });
        assert.equal(agent.activeMainProcesses.has(f.opts.scopeKey), false);
        assert.equal(receipts[0]!.data['scope'], f.opts.scopeKey);
        assert.equal(receipts[0]!.data['sessionId'], f.opts.chatSessionId);
    } finally {
        // Remove a buggy late admission before bounded owned-session teardown;
        // never await a receipt whose resurrected run is deliberately held open.
        for (const item of [...agent.messageQueue]) {
            if (item.scope === f.opts.scopeKey) agent.removeQueuedMessage(item.id);
        }
    }
});

for (const invalidation of ['owner-object', 'scope-generation'] as const) {
    test(`actual main ${invalidation} loss during cancel drain cannot send/commit B or clear successor`, { timeout: 10000 }, async t => {
        const f = await start(t), hook = f.owner.replaceTurn!;
        const redirect = agent.steerAgent(f.opts.scopeKey, 'STALE_B', 'web', { chatSessionId: f.opts.chatSessionId });
        void redirect.catch(() => {});
        await f.peer.waitFor(value => value.kind === 'cancel');
        const successor = { ...f.owner, process: null, starting: true };
        delete successor.replaceTurn; delete successor.cancelTurn;
        if (invalidation === 'scope-generation') {
            const { bumpScopeSessionGeneration } = await import('../../src/agent/session-persistence.ts');
            bumpScopeSessionGeneration(f.opts.scopeKey);
        }
        if (invalidation === 'owner-object') agent.activeMainProcesses.set(f.opts.scopeKey, successor);
        t.after(() => { if (agent.activeMainProcesses.get(f.opts.scopeKey) === successor) agent.activeMainProcesses.delete(f.opts.scopeKey); });
        await f.peer.command('release-cancel'); await assert.rejects(redirect);
        const outcome = await f.run.promise;
        assert.notEqual(outcome.code, 0); assert.equal(f.prompts().length, 1);
        if (invalidation === 'owner-object') {
            assert.equal(agent.activeMainProcesses.get(f.opts.scopeKey), successor);
            assert.equal(successor.starting, true);
        } else assert.equal(agent.activeMainProcesses.has(f.opts.scopeKey), false);
        const receipt = await hook('STALE_C', () => assert.fail('stale callback committed'));
        assert.notEqual(receipt.kind, 'dispatched');
        assert.equal(rows(f.opts.chatSessionId).some(row => /STALE_[BC]/.test((row as { content: string }).content)), false);
    });
}

for (const behavior of ['fast', 'missing-cancel'] as const) {
    test(`actual gateway ${behavior} settles its accepted request once without inference retry`, { timeout: 10000 }, async t => {
        mode = behavior; const f = await start(t);
        const settled = Promise.withResolvers<void>();
        let requestId: string | undefined;
        const off = subscribe(event => {
            if (event.event === 'request_settled' && event.data['requestId'] === requestId) settled.resolve();
        });
        t.after(off);
        const submission = gateway.submitMessage('GATEWAY_B_RAW', { origin: 'web', scope: f.opts.scopeKey,
            chatSessionId: f.opts.chatSessionId, midRunPolicy: 'steer' });
        requestId = submission.requestId;
        assert.ok(requestId); assert.equal(submission.action, 'started'); assert.equal(submission.disposition, 'steered');
        await settled.promise; const result = await f.run.promise;
        // IPC recording and ACP stdout are independent streams; finality does not flush IPC.
        if (behavior === 'fast') await f.peer.waitFor(value => value.kind === 'prompt' && value.index === 2);
        const receipts = f.events.filter(event => event.event === 'request_settled' && event.data['requestId'] === requestId);
        assert.equal(receipts.length, 1); assert.equal(receipts[0]!.data['outcome'], behavior === 'fast' ? 'steered' : 'failed');
        assert.equal(agent.messageQueue.length, 0); assert.equal(peers.length, 1);
        assert.equal(f.prompts().length, behavior === 'fast' ? 2 : 1);
        if (behavior === 'fast') {
            assert.equal(result.text, 'FAST_FINAL');
            assert.ok(f.events.indexOf(receipts[0]!) < f.events.findIndex(event => event.event === 'agent_done'));
            assert.deepEqual(rows(f.opts.chatSessionId).slice(1), [
                { role: 'user', content: 'GATEWAY_B_RAW' }, { role: 'assistant', content: 'FAST_FINAL' },
            ]);
        } else {
            assert.notEqual(result.code, 0);
            assert.equal(rows(f.opts.chatSessionId).some(row => (row as { content: string }).content === 'GATEWAY_B_RAW'), false);
        }
    });
}
