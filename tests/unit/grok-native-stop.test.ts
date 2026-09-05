import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { GrokSessionOptions } from '../../src/agent/runtime/acp/grok-session.ts';
import { launchControlAgent } from '../fixtures/native-acp-control.mjs';

const root = fs.mkdtempSync(join(tmpdir(), 'grok-stop-'));
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: (cli: string) => {
        assert.equal(cli, 'grok', 'the fixture must never select a fallback provider');
        return { available: true, path: process.execPath };
    },
} });
const { AcpSession } = await import('../../src/agent/runtime/acp/session.ts');
const peers: ReturnType<typeof launchControlAgent>[] = [];
const sessions: InstanceType<typeof AcpSession>[] = [];
const factoryInputs: GrokSessionOptions[] = [];
test.mock.module('../../src/agent/runtime/acp/grok-session.js', { namedExports: {
    createGrokSession: async (input: GrokSessionOptions) => {
        factoryInputs.push(input);
        assert.equal(input.permissions, 'auto');
        const peer = launchControlAgent(root, 'held'); peers.push(peer);
        // Real ACP transport/session, controlled IPC peer. Grok authentication,
        // version and advertised model negotiation belong to separate probes.
        const session = new AcpSession(peer.child as ChildProcessWithoutNullStreams, {
            permissions: input.permissions, promptTimeoutMs: 8000,
            requestTimeoutMs: 2000, controlTimeoutMs: 600, drainTimeoutMs: 2000,
        });
        sessions.push(session);
        await session.start({ cwd: root,
            ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}) });
        return session;
    },
} });
test.mock.module('../../src/agent/runtime/acp/cursor-session.js', { namedExports: {
    createCursorSession: () => { throw new Error('unexpected Cursor factory in Grok test'); },
} });
const agent = await import('../../src/agent/spawn.ts');
const gateway = await import('../../src/orchestrator/gateway.ts');
const submissions: Parameters<typeof gateway.submitMessage>[] = [];
test.mock.module('../../src/orchestrator/gateway.js', { namedExports: { ...gateway,
    submitMessage: (...args: Parameters<typeof gateway.submitMessage>) => {
        submissions.push(args); return gateway.submitMessage(...args);
    },
} });
const { steerHandler } = await import('../../src/cli/handlers-runtime.ts');
const { withSessionScope } = await import('../../src/core/session-context.ts');
const { db } = await import('../../src/core/db.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { poolStats } = await import('../../src/agent/runtime-pool.ts');
const { clearGoalTimers } = await import('../../src/agent/lifecycle-handler.ts');
const { settleAllPending } = await import('../../src/orchestrator/request-registry.ts');
type Event = { event: string; data: Record<string, unknown> };
let serial = 0;
test.beforeEach(t => {
    submissions.length = 0; factoryInputs.length = 0;
    config.settings.cli = 'grok'; config.settings.workingDir = root; config.settings.projectDirs = [root];
    config.settings.permissions = 'auto'; config.settings.fallbackOrder = []; config.settings.activeOverrides = {};
    config.settings.perCli = { ...config.settings.perCli, grok: { model: 'default', effort: '', transport: 'native' } };
    config.settings.memory = { ...config.settings.memory, enabled: false };
    config.settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
    fs.mkdirSync(join(config.JAW_HOME, 'prompts'), { recursive: true });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network in Grok Stop fixture'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
});
test.afterEach(async () => {
    for (const item of [...agent.messageQueue]) agent.removeQueuedMessage(item.id);
    for (const scope of [...agent.activeMainProcesses.keys()]) agent.killActiveAgent(scope, 'user');
    for (const session of sessions.splice(0)) await session.close();
    for (const peer of peers.splice(0)) {
        if (peer.child.exitCode === null && peer.child.signalCode === null) peer.child.kill();
        await peer.exited;
    }
    clearGoalTimers(); settleAllPending('dropped', 'grok-stop-fixture-cleanup');
    assert.equal(poolStats().busy, 0);
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function options() {
    const id = ++serial;
    return { cli: 'grok', model: 'default', effort: '', origin: 'web',
        scopeKey: `grok-stop-scope-${id}`, chatSessionId: `grok-stop-chat-${id}`, requestId: `grok-stop-request-${id}`,
        sysPrompt: 'OPERATIONAL_SENTINEL: keep output local.', _skipHistory: true, _isSmokeContinuation: true };
}
function rows(sessionId: string) {
    return db.prepare('SELECT role, content FROM messages WHERE session_id=? ORDER BY id').all(sessionId) as Array<{ role: string; content: string }>;
}
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
async function start(t: test.TestContext) {
    const opts = options(), events: Event[] = [], partial = Promise.withResolvers<void>();
    let exits = 0;
    t.after(subscribe(event => {
        if (event.data['scope'] !== opts.scopeKey && event.data['sessionId'] !== opts.chatSessionId) return;
        events.push(event);
        if (event.event === 'agent_runtime' && event.data['kind'] === 'message') partial.resolve();
    }));
    const run = agent.spawnAgent('ORIGINAL_A: continue old task.', { ...opts, lifecycle: { onExit: () => { exits++; } } });
    await Promise.race([partial.promise, run.promise.then(() => { throw new Error('Grok main ended before fixture partial'); })]);
    const peer = peers.at(-1)!;
    await peer.waitFor(value => value.kind === 'prompt');
    const owner = agent.activeMainProcesses.get(opts.scopeKey)!;
    assert.equal(owner.meta.cli, 'grok'); assert.equal(typeof owner.replaceTurn, 'function');
    assert.equal(owner.steerTurnInBand, undefined); assert.equal(factoryInputs.length, 1);
    const slash = (instruction: string) => withSessionScope({ scope: opts.scopeKey, chatSessionId: opts.chatSessionId },
        () => steerHandler([instruction], { interface: 'web', locale: 'en' }));
    const meta = { origin: 'web' as const, scope: opts.scopeKey, chatSessionId: opts.chatSessionId, midRunPolicy: 'steer' as const };
    const prompts = () => peers.flatMap(value => value.records.filter(record => record.kind === 'prompt'));
    return { opts, events, run, peer, owner, slash, meta, prompts, exits: () => exits };
}
type Fixture = Awaited<ReturnType<typeof start>>;
function singleTerminal(f: Fixture) {
    assert.equal(f.exits(), 1);
    assert.equal(f.events.filter(event => event.event === 'agent_done').length, 1);
    const native = f.events.filter(event => event.event === 'agent_runtime');
    assert.equal(native.filter(event => event.data['kind'] === 'turn-end').length, 1);
    assert.equal(new Set(native.map(event => event.data['runId'])).size, 1);
    assert.equal(agent.activeMainProcesses.has(f.opts.scopeKey), false);
    assert.equal(f.owner.replaceTurn, undefined); assert.equal(poolStats().busy, 0);
}
function noResurrection(f: Fixture, instructions: string[]) {
    assert.equal(submissions.length, 0, 'slash must not resubmit a stopped input');
    assert.equal(agent.messageQueue.filter(item => item.scope === f.opts.scopeKey).length, 0);
    assert.equal(f.prompts().length, 1);
    for (const instruction of instructions) {
        assert.equal(rows(f.opts.chatSessionId).some(row => row.content.includes(instruction)), false);
        assert.equal(f.events.some(event => event.event === 'new_message' && event.data['content'] === instruction), false);
        assert.equal(f.events.some(event => event.event === 'queue_update'
            && Array.isArray(event.data['queued'])
            && event.data['queued'].some((item: { prompt: string }) => item.prompt.includes(instruction))), false);
        assert.equal(f.prompts().some(value => String(value.prompt).includes(instruction)), false);
    }
    assert.equal(f.events.some(event => event.event === 'steer_started'), false);
    assert.equal(rows(f.opts.chatSessionId).some(row => row.role === 'assistant'), false);
    singleTerminal(f);
}
function cancelledReceipt(f: Fixture, requestId: string) {
    const receipts = f.events.filter(event => event.event === 'request_settled' && event.data['requestId'] === requestId);
    assert.equal(receipts.length, 1); assert.equal(receipts[0]!.data['outcome'], 'cancelled');
    assert.equal(receipts[0]!.data['reason'], 'native-steer-stopped');
    assert.equal(receipts[0]!.data['scope'], f.opts.scopeKey);
    assert.equal(receipts[0]!.data['sessionId'], f.opts.chatSessionId);
}

test('Grok main accepts raw B through actual /steer without Cursor context reinjection', { timeout: 10000 }, async t => {
    const f = await start(t), instruction = 'RAW_GROK_B: answer the second task.';
    const b = f.slash(instruction);
    await f.peer.waitFor(value => value.kind === 'cancel');
    assert.equal(f.exits(), 0); assert.equal(f.prompts().length, 1);
    await f.peer.command('release-cancel'); assert.equal((await b).ok, true);
    await f.peer.waitFor(value => value.kind === 'prompt' && value.index === 2);
    assert.equal(String(f.prompts()[1]!.prompt), instruction);
    assert.doesNotMatch(String(f.prompts()[1]!.prompt), /ORIGINAL_A|OPERATIONAL_SENTINEL|partial_output|Previous request|Accepted redirect/);
    assert.deepEqual(rows(f.opts.chatSessionId).slice(1), [{ role: 'user', content: instruction }]);
    assert.equal(f.events.filter(event => event.event === 'steer_started').length, 1);
    assert.equal(f.exits(), 0); assert.equal(submissions.length, 0); assert.equal(agent.messageQueue.length, 0);
    await f.peer.command('finish', { text: '_B_FINAL' });
    const result = await f.run.promise;
    assert.equal(result.code, 0); assert.equal(result.text, 'PARTIAL_2_B_FINAL');
    assert.equal(new Set(f.prompts().map(value => value.pid)).size, 1);
    assert.equal(new Set(f.prompts().map(value => value.sid)).size, 1);
    singleTerminal(f);
});

for (const ingress of ['slash', 'gateway'] as const) {
    test(`Grok ${ingress}: pending B then Stop then old cancelled reply cannot resubmit B`, { timeout: 10000 }, async t => {
        const f = await start(t), instruction = `STOPPED_${ingress}_B`;
        const b = ingress === 'slash' ? f.slash(instruction) : undefined;
        const submission = ingress === 'gateway' ? gateway.submitMessage(instruction, f.meta) : undefined;
        if (submission) { assert.equal(submission.action, 'started'); assert.equal(submission.disposition, 'steered'); }
        await f.peer.waitFor(value => value.kind === 'cancel');
        assert.equal(f.exits(), 0); assert.equal(agent.killActiveAgent(f.opts.scopeKey, 'user'), true);
        await f.peer.command('release-cancel');
        if (b) assert.equal((await b).ok, true);
        const result = await f.run.promise;
        assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(result.runtimeOutcome.finalText, null);
        await checkpoint(); noResurrection(f, [instruction]);
        if (submission) { assert.ok(submission.requestId); cancelledReceipt(f, submission.requestId); }
    });
}

for (const ingress of ['slash', 'gateway'] as const) {
    test(`Grok ${ingress}: busy C observed while B is pending cannot enqueue after immediate Stop`, { timeout: 10000 }, async t => {
        const f = await start(t), b = f.slash('PENDING_B');
        await f.peer.waitFor(value => value.kind === 'cancel');
        const busy = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        const replace = f.owner.replaceTurn!;
        const observed = t.mock.method(f.owner, 'replaceTurn', async (...args: Parameters<typeof replace>) => {
            const result = await replace(...args);
            assert.deepEqual(result, { kind: 'race', reason: 'busy' });
            busy.resolve(); await release.promise;
            return result;
        });
        t.after(() => release.resolve());
        const c = ingress === 'slash' ? f.slash('STOPPED_BUSY_C') : undefined;
        const submission = ingress === 'gateway' ? gateway.submitMessage('STOPPED_BUSY_C', f.meta) : undefined;
        // Both ingresses reach the real replacement controller's busy result.
        // Hold that result before its consumer can reach actual enqueue.
        await busy.promise;
        // Main cleanup compares the installed hook by identity; restore it while
        // the observed C call is still held so teardown exercises real ownership.
        observed.mock.restore();
        assert.equal(agent.killActiveAgent(f.opts.scopeKey, 'user'), true);
        release.resolve();
        await f.peer.command('release-cancel');
        assert.equal((await b).ok, true); if (c) assert.equal((await c).ok, true);
        assert.equal((await f.run.promise).runtimeOutcome?.status, 'stopped');
        await checkpoint(); noResurrection(f, ['PENDING_B', 'STOPPED_BUSY_C']);
        if (submission) {
            assert.equal(submission.action, 'started'); assert.ok(submission.requestId);
            cancelledReceipt(f, submission.requestId);
        }
    });
}

test('Grok fresh input after Stop is admitted and runs once on the reusable native session', { timeout: 10000 }, async t => {
    const f = await start(t), b = f.slash('STOPPED_B');
    await f.peer.waitFor(value => value.kind === 'cancel');
    assert.equal(agent.killActiveAgent(f.opts.scopeKey, 'user'), true);
    await f.peer.command('release-cancel'); assert.equal((await b).ok, true);
    assert.equal((await f.run.promise).runtimeOutcome?.status, 'stopped');
    await checkpoint(); noResurrection(f, ['STOPPED_B']);
    // Exercise real idle admission and persistence. Gate only the unrelated
    // orchestration/FSM side effects, then hand its admitted row to real main.
    const fresh = gateway.submitMessage('FRESH_AFTER_STOP_D', { ...f.meta, skipOrchestrate: true });
    assert.equal(fresh.action, 'started'); assert.equal(fresh.disposition, 'new_run');
    assert.equal(rows(f.opts.chatSessionId).filter(row => row.content === 'FRESH_AFTER_STOP_D').length, 1);
    const next = agent.spawnAgent('FRESH_AFTER_STOP_D', { ...f.opts, requestId: fresh.requestId, _skipInsert: true });
    await f.peer.waitFor(value => value.kind === 'prompt' && value.index === 2);
    assert.equal(peers.length, 1); assert.equal(factoryInputs.length, 1);
    assert.match(String(f.prompts()[1]!.prompt), /FRESH_AFTER_STOP_D/);
    assert.doesNotMatch(String(f.prompts()[1]!.prompt), /STOPPED_B/);
    await f.peer.command('finish', { text: '_D_FINAL' });
    assert.equal((await next.promise).text, 'PARTIAL_2_D_FINAL');
    assert.equal(f.events.filter(event => event.event === 'agent_done').length, 2);
    const ends = f.events.filter(event => event.event === 'agent_runtime' && event.data['kind'] === 'turn-end');
    assert.equal(ends.length, 2); assert.equal(new Set(ends.map(event => event.data['runId'])).size, 2);
    assert.deepEqual(rows(f.opts.chatSessionId).filter(row => row.role === 'assistant'), [{ role: 'assistant', content: 'PARTIAL_2_D_FINAL' }]);
    assert.equal(agent.messageQueue.length, 0); assert.equal(poolStats().busy, 0);
});
