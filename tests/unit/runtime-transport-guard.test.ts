import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import type { QueueController, QueueDeps } from '../../src/agent/spawn/queue.ts';

const home = process.env['CLI_JAW_HOME']!;
const forbiddenCalls: string[] = [];
function forbidden(name: string) {
    return (..._args: unknown[]): never => {
        forbiddenCalls.push(name);
        throw new Error(`transport guard crossed forbidden seam: ${name}`);
    };
}

// Install the process firewall before importing application modules. Even a
// missing guard must never launch a provider, capability probe, or shell.
const processSeams = Object.fromEntries(
    ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
        .map(name => [name, forbidden(name)]),
);
test.mock.module('node:child_process', {
    namedExports: { ...childProcess, ...processSeams },
    defaultExport: { ...childProcess, ...processSeams },
});
const config = await import('../../src/core/config.ts');
const settings = { ...config.settings, workingDir: home, projectDirs: [home],
    cli: 'cursor', perCli: {}, activeOverrides: {}, fallbackOrder: [],
    multiSession: { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' },
};
test.mock.module('../../src/core/config.js', { namedExports: {
    ...config, settings, detectCli: forbidden('detectCli'), detectAllCli: forbidden('detectAllCli'),
    getProjectDirs: () => [home],
} });

const selection = await import('../../src/agent/runtime/selection.ts');
let simulatedMainAdapter = false;
const workerEligibility = test.mock.fn((cli: string) => selection.isNativeWorkerImplemented(cli));
test.mock.module('../../src/agent/runtime/selection.js', { namedExports: {
    ...selection,
    isNativeAdapterImplemented: (cli: string) => simulatedMainAdapter || selection.isNativeAdapterImplemented(cli),
    isNativeWorkerImplemented: workerEligibility,
} });
const database = await import('../../src/core/db.ts');
const bucketRead = test.mock.fn((bucket: string) => database.getSessionBucket.get(bucket));
test.mock.module('../../src/core/db.js', { namedExports: {
    ...database, getSessionBucket: { get: bucketRead },
} });
const mainSession = await import('../../src/core/main-session.ts');
const consumeBootstrap = test.mock.fn(mainSession.consumePendingBootstrapPrompt);
test.mock.module('../../src/core/main-session.js', { namedExports: {
    ...mainSession, consumePendingBootstrapPrompt: consumeBootstrap,
} });
// Do not import builder to spread its exports: builder imports spawn eagerly,
// which would bind argv/queue seams before this fixture has installed them.
test.mock.module('../../src/prompt/builder.js', { namedExports: {
    regenerateB: () => {}, getSystemPrompt: () => 'fixture system prompt',
    A1_PATH: `${home}/prompts/A-1.md`, A2_PATH: `${home}/prompts/A-2.md`,
    HEARTBEAT_PATH: `${home}/prompts/HEARTBEAT.md`,
    ...Object.fromEntries([
        'formatSkillListItem', 'resolveLegacyA1Migration', 'loadActiveSkills', 'loadSkillRegistry',
        'getMergedSkills', 'shouldIncludeDesktopControlSection', 'hashAnchorBlock', 'findAnchorTopology',
        'upsertKnownAnchorBlock', 'initPromptFiles', 'getMemoryDir', 'loadRecentMemories',
        'shouldIncludeVisionClickHint', 'getInboundSurfaceContract', 'getSendFileStagingContract',
        'getBoundedLocalSearchContract', 'getEmployeePrompt', 'normalizeTaskTags',
        'getEmployeePromptV2', 'clearPromptCache',
    ].map(name => [name, forbidden(`prompt builder ${name}`)])),
} });
const args = await import('../../src/agent/args.ts');
test.mock.module('../../src/agent/args.js', { namedExports: {
    ...args, buildArgs: forbidden('buildArgs'), buildResumeArgs: forbidden('buildResumeArgs'),
} });
const queue = await import('../../src/agent/spawn/queue.ts');
let controller: QueueController;
test.mock.module('../../src/agent/spawn/queue.js', { namedExports: {
    ...queue,
    createQueueController: (deps: QueueDeps) => (controller = queue.createQueueController(deps)),
} });
const events: Array<{ type: string; data: Record<string, unknown>; audience: string }> = [];
const bus = await import('../../src/core/bus.ts');
test.mock.module('../../src/core/bus.js', { namedExports: {
    ...bus,
    broadcast: (type: string, data: Record<string, unknown>, audience = 'public') => {
        events.push({ type, data, audience });
    },
} });
const { spawnAgent, activeMainProcesses, activeProcesses, isAgentBusy } = await import('../../src/agent/spawn.ts');

test.beforeEach(() => {
    forbiddenCalls.length = 0;
    events.length = 0;
    bucketRead.mock.resetCalls();
    consumeBootstrap.mock.resetCalls();
    workerEligibility.mock.resetCalls();
    simulatedMainAdapter = false;
    controller.resetFallbackState(null);
});
test.afterEach(() => {
    // A RED run can throw at the argv firewall after allocating a main slot.
    // These maps contain fixture-only state, never actual child processes.
    activeMainProcesses.clear();
    activeProcesses.clear();
});

async function assertRejected(cli: string, worker: boolean | 'forceNew' | 'internal', fallback = false, fresh = false) {
    const runKind = typeof worker === 'string' ? worker : worker ? 'worker' : 'main';
    const scope = `local:transport:${cli}:${runKind}:${fresh ? 'fresh' : 'resume'}`;
    const employeeId = `transport-fixture-${cli}`;
    settings.cli = cli;
    settings.perCli = { [cli]: { model: 'fixture-model', effort: '', transport: 'native' } };
    database.updateSession.run(cli, 'singleton-print-sid', 'fixture-model', 'auto', home, '');
    if (!fresh) {
        database.upsertSessionBucket.run(`${cli}:${scope}`, 'bucket-print-sid', 'fixture-model', null, 0);
        database.upsertSessionBucket.run(`native-v1:${cli}:${scope}`, 'bucket-native-sid', 'fixture-model', null, 0);
    }
    mainSession.setPendingBootstrapPrompt('fixture bootstrap must survive', scope);
    const before = {
        session: database.getSession(),
        buckets: database.db.prepare('SELECT * FROM session_buckets ORDER BY bucket').all(),
        messages: database.db.prepare('SELECT * FROM messages ORDER BY id').all(),
    };
    if (fallback) controller.fallbackStateForScope(scope).set(cli, { fallbackCli: 'gemini', retriesLeft: 0 });
    const mkdir = test.mock.method(fs, 'mkdirSync', forbidden('worker isolation mkdir'));
    try {
        const run = spawnAgent('fixture user turn', {
            cli, scopeKey: scope, chatSessionId: 'default', sysPrompt: 'fixture system prompt',
            ...(worker === true ? { agentId: employeeId, ...(fresh ? {} : { employeeSessionId: 'employee-print-sid' }) } : {}),
            ...(worker === 'forceNew' ? { forceNew: true } : {}),
            ...(worker === 'internal' ? { internal: true } : {}),
        });
        assert.equal(run.child, null);
        const result = await run.promise;
        assert.equal(result.code, 78);
        assert.match(result.text, new RegExp(cli));
        assert.match(result.text, /native/i);
        assert.match(result.text, /print|transport|not implemented|unsupported/i);
        assert.deepEqual(forbiddenCalls, [], 'no argv, detection, process, or employee isolation');
        assert.equal(bucketRead.mock.callCount(), 0, 'guard precedes all resume bucket reads');
        assert.equal(consumeBootstrap.mock.callCount(), 0, 'bootstrap is not consumed');
        assert.equal(mainSession.peekPendingBootstrapPrompt(scope), 'fixture bootstrap must survive');
        assert.deepEqual(database.getSession(), before.session);
        assert.deepEqual(database.db.prepare('SELECT * FROM session_buckets ORDER BY bucket').all(), before.buckets);
        assert.deepEqual(database.db.prepare('SELECT * FROM messages ORDER BY id').all(), before.messages);
        assert.equal(activeMainProcesses.has(scope), false, 'rejected main slot is released');
        assert.equal(isAgentBusy(scope), false);
        assert.equal(activeProcesses.size, 0);
        const diagnostic = events.find(event => event.type === 'agent_done' && event.data['error'] === true);
        assert.ok(diagnostic, 'application diagnostic is emitted instead of a model final');
        assert.equal(diagnostic.data['text'], result.text);
        assert.equal(diagnostic.audience, worker ? 'internal' : 'public');
        assert.equal(events.some(event => event.type === 'agent_fallback'), false);
        assert.equal(events.some(event => event.type === 'agent_done' && event.data['error'] !== true), false);
    } finally {
        mkdir.mock.restore();
    }
}

for (const cli of ['cursor', 'grok', 'claude']) {
    for (const worker of [false, true]) {
        test(`${cli} unsupported native ${worker ? 'worker' : 'main'} rejects before resume/argv/side effects`, async () => {
            await assertRejected(cli, worker);
        });
        test(`${cli} unsupported native ${worker ? 'worker' : 'main'} rejects before exhausted fallback`, async () => {
            await assertRejected(cli, worker, true);
        });
        test(`${cli} unsupported native fresh ${worker ? 'worker' : 'main'} rejects before bootstrap/print argv`, async () => {
            await assertRejected(cli, worker, false, true);
        });
    }
    test(`${cli} native worker remains rejected when only the main adapter is implemented`, async () => {
        simulatedMainAdapter = true;
        await assertRejected(cli, true);
        assert.ok(workerEligibility.mock.calls.some(call => call.arguments[0] === cli),
            'worker eligibility must be checked independently of main implementation');
    });
    for (const runKind of ['forceNew', 'internal'] as const) {
        for (const mainImplemented of [false, true]) {
            test(`${cli} native ${runKind} without agentId rejects with main implemented=${mainImplemented}`, async () => {
                simulatedMainAdapter = mainImplemented;
                // Neither path supplies agentId or employeeSessionId. Each
                // independently makes mainManaged=false and needs the worker gate.
                await assertRejected(cli, runKind);
                if (mainImplemented) {
                    assert.ok(workerEligibility.mock.calls.some(call => call.arguments[0] === cli),
                        `${runKind} must check worker support even without agentId`);
                }
            });
        }
    }
}
