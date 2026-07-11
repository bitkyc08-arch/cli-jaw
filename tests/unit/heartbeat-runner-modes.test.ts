import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const collectUrl = new URL('../../src/orchestrator/collect.ts', import.meta.url).href;
const sendUrl = new URL('../../src/messaging/send.ts', import.meta.url).href;
const dbUrl = new URL('../../src/core/db.ts', import.meta.url).href;
const stateUrl = new URL('../../src/orchestrator/state-machine.ts', import.meta.url).href;
const spawnUrl = new URL('../../src/agent/spawn.ts', import.meta.url).href;
const registryUrl = new URL('../../src/orchestrator/worker-registry.ts', import.meta.url).href;
const distributeUrl = new URL('../../src/orchestrator/distribute.ts', import.meta.url).href;

const [realSend, realDb, realState, realSpawn, realRegistry, realDistribute] = await Promise.all([
    import('../../src/messaging/send.js'), import('../../src/core/db.js'), import('../../src/orchestrator/state-machine.js'),
    import('../../src/agent/spawn.js'), import('../../src/orchestrator/worker-registry.js'), import('../../src/orchestrator/distribute.js'),
]);

let collectCalls = 0;
let plannerOnly = false;
let employeeBusy = false;
const sent: string[] = [];
const anchors: unknown[][] = [];
const employee = { id: 'emp-1', name: 'reviewer', cli: 'codex', model: null, role: 'reviewer' };

mock.module(collectUrl, { namedExports: {
    orchestrateAndCollectData: async () => {
        collectCalls++;
        return { text: 'status: ok\nsummary: main complete', data: { agyPlannerOnly: plannerOnly } };
    },
    orchestrateAndCollect: async () => 'unused',
} });
mock.module(sendUrl, { namedExports: { ...realSend, sendChannelOutput: async (input: { text: string }) => { sent.push(input.text); return { ok: true }; } } });
mock.module(dbUrl, { namedExports: {
    ...realDb,
    getEmployees: { all: () => [employee] },
    insertHeartbeatAnchor: { run: (...args: unknown[]) => { anchors.push(args); } },
} });
mock.module(stateUrl, { namedExports: { ...realState, getState: () => 'IDLE' } });
mock.module(spawnUrl, { namedExports: { ...realSpawn, isAgentBusy: () => false, messageQueue: [] } });
mock.module(registryUrl, { namedExports: {
    ...realRegistry,
    claimWorker: () => {
        if (employeeBusy) throw new realRegistry.WorkerBusyError({ employeeName: employee.name, task: 'manual' } as never);
        return { agentId: employee.id };
    },
    finishWorker: () => undefined,
    failWorker: () => undefined,
    hasPendingWorkerReplays: () => false,
} });
mock.module(distributeUrl, { namedExports: { ...realDistribute, runSingleAgent: async () => ({ text: 'status: ok\nsummary: employee complete', tools: [] }) } });

const { decideHeartbeatReport, runHeartbeatJob, runHeartbeatScript } = await import('../../src/memory/heartbeat.js');
type Status = 'ok' | 'warning' | 'failed';
const report = (status: Status, userVisible = false) => ({ status, changed: false, recordRequired: false, userVisible, summary: 's', evidence: '', nextAction: '', raw: 's' });

for (const policy of ['always', 'anomaly_only', 'silent'] as const) {
    for (const status of ['ok', 'warning', 'failed'] as const) {
        test(`report gate ${policy} x ${status}`, () => {
            const decision = decideHeartbeatReport(report(status), policy);
            const expectedSend = policy === 'always' || (policy === 'anomaly_only' && status !== 'ok');
            assert.deepEqual(decision, { send: expectedSend, anchor: true, delivered: expectedSend });
        });
    }
}

test('anomaly_only sends an ok report explicitly marked user-visible', () => {
    assert.deepEqual(decideHeartbeatReport(report('ok', true), 'anomaly_only'), { send: true, anchor: true, delivered: true });
});

test('planner-only main heartbeat retries exactly once even when every result is planner-only', async () => {
    collectCalls = 0; plannerOnly = true;
    await runHeartbeatJob({ id: 'retry', name: 'retry', enabled: true, schedule: { minutes: 5 }, prompt: 'check' });
    assert.equal(collectCalls, 2);
});

test('non-planner main heartbeat runs once', async () => {
    collectCalls = 0; plannerOnly = false;
    await runHeartbeatJob({ id: 'once', name: 'once', enabled: true, schedule: { minutes: 5 }, prompt: 'check' });
    assert.equal(collectCalls, 1);
});

test('busy employee produces warning delivery without running employee', async () => {
    employeeBusy = true; sent.length = 0;
    await runHeartbeatJob({ id: 'busy', name: 'busy', runner: 'employee', employee: employee.name, reportPolicy: 'anomaly_only', schedule: { minutes: 5 }, prompt: 'check' });
    employeeBusy = false;
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /\[warning\].*skipped: employee busy/);
});

test('script runner parses real exit-0 contract output', async () => {
    const result = await runHeartbeatScript([process.execPath, '-e', "console.log('status: ok\\nchanged: yes\\nsummary: script complete')"]);
    assert.equal(result.status, 'ok');
    assert.equal(result.changed, true);
    assert.equal(result.summary, 'script complete');
});

test('script runner maps a real nonzero exit to failed', async () => {
    const result = await runHeartbeatScript([process.execPath, '-e', "console.error('boom'); process.exit(3)"]);
    assert.equal(result.status, 'failed');
});

// Timeout configuration remains a source-contract assertion: waiting ten real minutes is not an acceptable unit test.
test('script runner configures the audited timeout and output bound', async () => {
    const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../../src/memory/heartbeat.ts', import.meta.url), 'utf8'));
    assert.match(source, /timeout: 10 \* 60_000, maxBuffer: 64 \* 1024/);
});
