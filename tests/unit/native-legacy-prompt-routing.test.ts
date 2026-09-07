import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

// Observe the real spawn -> bootstrap -> argv chain. Availability is deliberately
// false at the final preflight, after argv preparation, so no provider is launched.
const calls: string[] = [];
const argvCalls: Array<{ kind: 'fresh' | 'resume'; prompt: string; argv: string[] }> = [];
const bootstrapInputs: Parameters<typeof import('../../src/agent/agy-bootstrap.ts').buildAgyBootstrapEnvelope>[0][] = [];
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: (cli: string) => {
        calls.push(`detect:${cli}`);
        return { available: false, path: 'fixture-no-provider' };
    },
} });
const capabilities = await import('../../src/agent/agy-capabilities.ts');
test.mock.module('../../src/agent/agy-capabilities.js', { namedExports: { ...capabilities,
    detectAgyCapabilities: () => {
        calls.push('capabilities');
        return { print: true, printFlag: '-p', conversation: true, model: false,
            printTimeout: false, logFile: false, addDir: false,
            dangerousSkipPermissions: false, sandbox: false };
    },
} });
const bootstrap = await import('../../src/agent/agy-bootstrap.ts');
test.mock.module('../../src/agent/agy-bootstrap.js', { namedExports: { ...bootstrap,
    buildAgyBootstrapEnvelope: (input: Parameters<typeof bootstrap.buildAgyBootstrapEnvelope>[0]) => {
        calls.push('bootstrap'); bootstrapInputs.push(input);
        return bootstrap.buildAgyBootstrapEnvelope(input);
    },
} });
const args = await import('../../src/agent/args.ts');
test.mock.module('../../src/agent/args.js', { namedExports: { ...args,
    buildArgs: (...input: Parameters<typeof args.buildArgs>) => {
        calls.push('argv:fresh');
        const argv = args.buildArgs(...input);
        argvCalls.push({ kind: 'fresh', prompt: input[3], argv }); return argv;
    },
    buildResumeArgs: (...input: Parameters<typeof args.buildResumeArgs>) => {
        calls.push('argv:resume');
        const argv = args.buildResumeArgs(...input);
        argvCalls.push({ kind: 'resume', prompt: input[4], argv }); return argv;
    },
} });
const builder = await import('../../src/prompt/builder.ts');
let regenerations = 0;
test.mock.module('../../src/prompt/builder.js', { namedExports: { ...builder,
    regenerateB: (...input: Parameters<typeof builder.regenerateB>) => {
        regenerations++;
        return builder.regenerateB(...input);
    },
} });
const { spawnAgent, activeMainProcesses } = await import('../../src/agent/spawn.ts');
const requests = await import('../../src/orchestrator/request-registry.ts');
const { addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
const database = await import('../../src/core/db.ts');
const { setPendingBootstrapPrompt, peekPendingBootstrapPrompt } = await import('../../src/core/main-session.ts');
const home = config.JAW_HOME;
let serial = 0;
test.beforeEach(t => {
    calls.length = 0; argvCalls.length = 0; bootstrapInputs.length = 0;
    regenerations = 0;
    config.settings.workingDir = home; config.settings.projectDirs = [home];
    config.settings.permissions = 'auto'; config.settings.fallbackOrder = [];
    config.settings.activeOverrides = {};
    config.settings.memory = { ...config.settings.memory, enabled: false };
    config.settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
    fs.mkdirSync(join(home, 'prompts'), { recursive: true });
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 6, 13, 2).getTime() });
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('unexpected provider/network request'); });
});
test.afterEach(() => { assert.equal(activeMainProcesses.size, 0); });
function options(cli: string) {
    const id = ++serial;
    return { cli, model: 'default', effort: '', origin: 'web', sysPrompt: 'OPERATIONAL_RULES_ONLY',
        scopeKey: `legacy-routing-${id}`, chatSessionId: `legacy-chat-${id}`, _isSmokeContinuation: true };
}

test('retired selection fails before prompt preparation and preserves pending context', async t => {
    const opts = options('jwc');
    config.settings.perCli = { ...config.settings.perCli,
        jwc: { model: 'saved-model', provider: 'anthropic' } };
    setPendingBootstrapPrompt('COMPACT_NOT_CURRENT', opts.scopeKey);
    const historyRead = t.mock.method(database.getRecentMessages, 'all');
    try {
        const run = spawnAgent('CURRENT_REQUEST', opts);
        assert.equal(run.child, null);
        const result = await run.promise;
        assert.equal(result.code, 78);
        assert.match(result.text, /^retired_runtime:jwc:/);
        assert.equal(historyRead.mock.callCount(), 0);
        assert.equal(peekPendingBootstrapPrompt(opts.scopeKey), 'COMPACT_NOT_CURRENT');
        assert.deepEqual(argvCalls, []); assert.deepEqual(bootstrapInputs, []);
        assert.deepEqual(calls, [], 'retired selection must not probe another provider');
        assert.equal(regenerations, 0);
    } finally {
        setPendingBootstrapPrompt(null, opts.scopeKey);
    }
});

for (const selection of ['settings', 'override', 'session', 'employee', 'fallback'] as const) {
    test(`retired ${selection} selection settles its request and releases only its scope`, async () => {
        config.settings.cli = selection === 'settings' ? 'jwc' : selection === 'session' ? '' : 'pi';
        if (selection === 'session') database.updateSession.run('jwc', null, 'saved', 'auto', home, 'high');
        const opts = { ...options('jwc'), requestId: `retired-${selection}`,
            ...(selection === 'employee' ? { agentId: 'retired-worker' } : {}),
            ...(selection === 'fallback' ? { _isFallback: true } : {}) };
        const events: Record<string, unknown>[] = [];
        const listener = (type: string, data: Record<string, unknown>) => {
            if (type === 'request_settled' && data['requestId'] === opts.requestId) events.push(data);
        };
        requests.admitRequest(opts.requestId, opts.scopeKey);
        addBroadcastListener(listener);
        const other = { process: null, starting: true, steering: false, ownerGeneration: 0,
            meta: { origin: 'web', cli: 'pi' } };
        activeMainProcesses.set('unrelated-retirement-test', other);
        try {
            const { cli, ...withoutCli } = opts;
            const run = spawnAgent('must not dispatch', selection === 'settings' || selection === 'session' ? withoutCli : opts);
            assert.equal(run.child, null);
            assert.equal((await run.promise).code, 78);
            assert.equal(activeMainProcesses.has(opts.scopeKey), false);
            assert.equal(activeMainProcesses.get('unrelated-retirement-test'), other);
            assert.equal(requests.pendingRequestIds().includes(opts.requestId), false);
            assert.equal(events.length, 1);
            assert.equal(events[0]!['outcome'], 'failed');
            assert.equal(events[0]!['error'], 'retired_runtime:jwc');
            assert.equal(events[0]!['sessionId'], opts.chatSessionId);
            assert.equal(regenerations, 0);
            assert.deepEqual(calls, []);
        } finally {
            activeMainProcesses.delete('unrelated-retirement-test');
            removeBroadcastListener(listener);
            config.settings.cli = 'pi';
        }
    });
}

test('queued request resolves the saved retired selection when its lane is released', async () => {
    const { createQueueController } = await import('../../src/agent/spawn/queue.ts');
    const { SessionLanes } = await import('../../src/orchestrator/session-lanes.ts');
    const opts = options('jwc');
    const requestId = 'retired-queued-request';
    config.settings.cli = 'jwc';
    let busy = true;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    let result: Awaited<ReturnType<typeof spawnAgent>['promise']> | undefined;
    const queue = createQueueController({
        migrateQueuedMessagesV1ToV2: () => {}, isSpawnBusy: () => busy,
        hasBlockingWorkers: () => false, hasPendingWorkerReplays: () => false,
        insertMessage: { run: () => {} }, insertQueuedMessage: { run: () => {} },
        deleteQueuedMessage: { run: () => {} }, listQueuedMessages: { all: () => [] },
        getActiveChatSession: () => opts.chatSessionId, getWorkingDir: () => home,
        isMultiSessionEnabled: () => true, broadcast: () => {},
        importPipeline: async () => ({
            orchestrate: async (prompt: string, meta: { scope: string; chatSessionId: string; requestId: string }) => {
                try {
                    result = await spawnAgent(prompt, { scopeKey: meta.scope, chatSessionId: meta.chatSessionId,
                        requestId: meta.requestId, _skipInsert: true }).promise;
                } finally { finish(); }
            },
            orchestrateContinue: async () => { assert.fail('unexpected continue'); },
            orchestrateReset: async () => { assert.fail('unexpected reset'); },
            isContinueIntent: () => false, isResetIntent: () => false, drainPendingReplays: async () => {},
        }),
    }, new SessionLanes(() => 1));
    requests.admitRequest(requestId, opts.scopeKey);
    queue.enqueueMessage('queued user prompt', 'web', { scope: opts.scopeKey, chatSessionId: opts.chatSessionId, requestId });
    assert.equal(requests.pendingRequestIds().includes(requestId), true);
    busy = false;
    await queue.processQueue(opts.scopeKey);
    await done;
    assert.equal(result?.code, 78);
    assert.equal(requests.pendingRequestIds().includes(requestId), false);
    assert.equal(regenerations, 0);
    assert.deepEqual(calls, []);
    config.settings.cli = 'pi';
});

for (const resume of [false, true]) for (const order of ['task-first', 'context-first'] as const) {
    test(`SF-004b: AGY ${resume ? 'guarded resume' : 'fresh compact handoff'} ${order} prepares enriched argv once`, async () => {
        const opts = options('agy');
        config.settings.perCli = { ...config.settings.perCli,
            agy: { model: 'default', nativeResume: 'guarded', promptOrder: order } };
        database.insertMessage.run('user', 'HISTORY_ONLY', 'agy', 'default', home, opts.chatSessionId);
        if (resume) {
            // Real guarded-resume decision from a valid, owned bucket, not a
            // mocked isResume boolean or an employee-session shortcut.
            const bucket = `agy:${opts.scopeKey}`;
            database.upsertSessionBucket.run(bucket, 'saved-agy-conversation', 'default', null, 0);
            database.db.prepare('UPDATE session_buckets SET updated_at=? WHERE bucket=?').run(Date.now(), bucket);
            database.updateSessionBucketLastRun.run(1, home,
                JSON.stringify({ plannerOnly: false, checkpointSeen: false }), bucket);
        } else setPendingBootstrapPrompt('COMPACT_HANDOFF_ONLY', opts.scopeKey);
        const result = await spawnAgent('CURRENT_AGY_REQUEST', opts).promise;
        assert.equal(result.code, 127, 'stop at mocked availability, after real argv preparation');
        assert.deepEqual(calls, ['detect:agy', 'capabilities', 'bootstrap',
            resume ? 'argv:resume' : 'argv:fresh', 'detect:agy']);
        assert.equal(argvCalls.length, 1); assert.equal(bootstrapInputs.length, 1);
        const task = `260906-01:02PM.\nProject root: ${home}\n`
            + (resume ? '' : 'COMPACT_HANDOFF_ONLY\n\n---\n\n') + 'CURRENT_AGY_REQUEST';
        const history = resume ? '' : '[Recent Context]\n[user] HISTORY_ONLY';
        assert.deepEqual(bootstrapInputs[0], { taskPrompt: task, historyBlock: history,
            workingDir: home, sessionId: resume ? 'saved-agy-conversation' : null,
            order, operationalContext: 'OPERATIONAL_RULES_ONLY' });
        const call = argvCalls[0]!;
        assert.equal(call.kind, resume ? 'resume' : 'fresh');
        assert.deepEqual(call.argv, resume
            ? ['--conversation', 'saved-agy-conversation', '-p', call.prompt] : ['-p', call.prompt]);
        // Independent serializer oracle. Only the hash value is opaque; the
        // supplied task, rules, history, order and conversation are exact.
        const headerEnd = call.prompt.indexOf('\n\n---\n\n');
        const header = call.prompt.slice(0, headerEnd);
        assert.match(header, /^\[CLI-JAW AGY BOOTSTRAP\]\nCLI_JAW_BOOTSTRAP_SHA=[a-f0-9]{16}\n/);
        assert.equal(header.split('\n').slice(2).join('\n'), `cwd=${home}\nsession=${resume ? 'saved-agy-conversation' : 'fresh'}\nrule=This marker proves the current cli-jaw runtime envelope reached AGY.`);
        const taskSection = `[Current cli-jaw task]\n${task}`;
        const context = '[Operational Context — cli-jaw Integration]\nThe following operational guidelines apply to this session. Follow these task rules and use the tools/commands described:\n\nOPERATIONAL_RULES_ONLY';
        const extras = [context, ...(resume ? [] : [`[Recent context / history]\n${history}`])];
        assert.equal(call.prompt.slice(headerEnd + '\n\n---\n\n'.length),
            (order === 'task-first' ? [taskSection, ...extras] : [...extras, taskSection]).join('\n\n---\n\n'));
        assert.equal(peekPendingBootstrapPrompt(opts.scopeKey), null);
    });
}
