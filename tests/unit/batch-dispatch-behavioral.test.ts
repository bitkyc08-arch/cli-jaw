// #458: writes the shared `orc_state` row via setState/resetState. Needs its own
// CLI_JAW_HOME so a concurrent test file cannot clobber it. Must precede every
// DB-touching import: config.ts binds DB_PATH at module evaluation.
import '../setup/isolated-home.ts';
// Behavioral harness for batch async dispatch (WP6, 260703).
// Real singletons: worker-registry, state-machine/core-db (temp CLI_JAW_HOME),
// boss-auth (real token via initBossToken). Mocked: distribute.runSingleAgent
// (the only external effect) and pipeline.drainPendingReplays (would otherwise
// try to re-invoke a real boss agent from inside the test).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const distributeUrl = new URL('../../src/orchestrator/distribute.ts', import.meta.url).href;
const pipelineUrl = new URL('../../src/orchestrator/pipeline.ts', import.meta.url).href;
const realDistribute = await import('../../src/orchestrator/distribute.js');
const realPipeline = await import('../../src/orchestrator/pipeline.js');

type RunBehavior = (ap: Record<string, unknown>) => Promise<{ text: string; tools: unknown[] }>;
let runBehavior: RunBehavior = async () => ({ text: 'PASS', tools: [] });
const runCalls: Array<Record<string, unknown>> = [];
let drainCalls = 0;

mock.module(distributeUrl, {
    namedExports: {
        ...realDistribute,
        runSingleAgent: async (ap: Record<string, unknown>) => {
            runCalls.push(ap);
            return runBehavior(ap);
        },
    },
});
mock.module(pipelineUrl, {
    namedExports: {
        ...realPipeline,
        drainPendingReplays: async () => { drainCalls++; return 0; },
    },
});

const { registerOrchestrateRoutes } = await import('../../src/routes/orchestrate.js');
const { initBossToken } = await import('../../src/core/boss-auth.js');
const { resolveOrcScope } = await import('../../src/orchestrator/scope.js');
const { setState, getCtx, resetState } = await import('../../src/orchestrator/state-machine.js');
const { getWorkerSlot, claimWorker, cancelWorker } = await import('../../src/orchestrator/worker-registry.js');

const bossToken = initBossToken();
const scope = resolveOrcScope({ origin: 'web', workingDir: null });

type Handler = (req: unknown, res: unknown) => Promise<unknown> | unknown;
const routes = new Map<string, Handler>();
const capture = (method: string) => (path: string, ...handlers: Handler[]) => {
    routes.set(`${method} ${path}`, handlers[handlers.length - 1]!);
};
const fakeApp = {
    post: capture('POST'), get: capture('GET'), put: capture('PUT'),
    delete: capture('DELETE'), patch: capture('PATCH'),
};
registerOrchestrateRoutes(fakeApp as never, ((_req: unknown, _res: unknown, next: () => void) => next()) as never);
const batchHandler = routes.get('POST /api/orchestrate/dispatch/batch');

function fakeReq(body: Record<string, unknown>) {
    return { body, headers: { 'x-jaw-boss-token': bossToken }, ip: '127.0.0.1' };
}
function fakeRes() {
    const state: { status: number; body: Record<string, unknown> | null } = { status: 200, body: null };
    const res = {
        status(code: number) { state.status = code; return res; },
        json(payload: Record<string, unknown>) { state.body = payload; return res; },
        on(_ev: string, _cb: () => void) { return res; },
        writableFinished: true,
        writableEnded: false,
    };
    return { res, state };
}
async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(cond(), 'condition not met within timeout');
}
type WorkerEntry = { agent: string; accepted: boolean; agentId?: string; runId?: string; error?: string };

test('behavioral: batch wait:false answers 202 with pre-claimed runIds, completes detached, marks pendingReplay', async () => {
    assert.ok(batchHandler, 'batch route registered');
    runCalls.length = 0;
    runBehavior = async () => ({ text: 'PASS — audit clean', tools: [] });
    const { res, state } = fakeRes();
    await batchHandler!(fakeReq({
        wait: false,
        agents: [
            { virtual: 'harness-alpha', task: 'audit slice A', parallel: true, affected_files: ['a.ts'] },
            { virtual: 'harness-beta', task: 'audit slice B', parallel: true, affected_files: ['b.ts'] },
        ],
    }), res);

    assert.equal(state.status, 202);
    const workers = (state.body?.["workers"] || []) as WorkerEntry[];
    assert.equal(workers.length, 2);
    for (const w of workers) {
        assert.equal(w.accepted, true, `${w.agent} accepted`);
        assert.match(String(w.runId), /^wr_/, 'pre-claimed runId in 202 body');
        assert.ok(w.agentId, 'agentId in 202 body');
    }
    await waitFor(() => workers.every(w => getWorkerSlot(String(w.agentId))?.state === 'done'));
    for (const w of workers) {
        assert.equal(getWorkerSlot(String(w.agentId))?.pendingReplay, true, 'result eligible for replay');
    }
    assert.equal(runCalls.length, 2, 'both workers executed exactly once');
});

test('behavioral: A-state batch PASS verdicts persist auditStatus (gate credit)', async () => {
    runBehavior = async () => ({ text: 'Verified. PASS', tools: [] });
    setState('A', {
        originalPrompt: 'harness', workingDir: null, plan: 'the plan',
        workerResults: [], origin: 'web',
    }, scope);
    try {
        const { res, state } = fakeRes();
        await batchHandler!(fakeReq({
            wait: false,
            agents: [
                { virtual: 'harness-alpha', task: 'audit part 1', parallel: true, affected_files: ['x.ts'] },
                { virtual: 'harness-beta', task: 'audit part 2', parallel: true, affected_files: ['y.ts'] },
            ],
        }), res);
        assert.equal(state.status, 202);
        await waitFor(() => getCtx(scope)?.auditStatus === 'pass');
        assert.equal(getCtx(scope)?.auditStatus, 'pass');
    } finally {
        resetState(scope);
    }
});

test('behavioral: FINDING-2 guard — a crashed worker suppresses the positive aggregate', async () => {
    let call = 0;
    runBehavior = async () => {
        call++;
        if (call === 1) return { text: 'All good. PASS', tools: [] };
        throw new Error('worker exploded mid-run');
    };
    setState('A', {
        originalPrompt: 'harness', workingDir: null, plan: 'the plan',
        workerResults: [], origin: 'web',
    }, scope);
    try {
        const { res, state } = fakeRes();
        await batchHandler!(fakeReq({
            wait: false,
            agents: [
                { virtual: 'harness-alpha', task: 'audit part 1', parallel: false },
                { virtual: 'harness-beta', task: 'audit part 2', parallel: false },
            ],
        }), res);
        assert.equal(state.status, 202);
        const workers = (state.body?.["workers"] || []) as WorkerEntry[];
        await waitFor(() => workers.every(w => {
            const s = getWorkerSlot(String(w.agentId))?.state;
            return s === 'done' || s === 'failed';
        }));
        // Give the detached persist a beat, then assert it did NOT credit the gate.
        await new Promise(r => setTimeout(r, 100));
        assert.notEqual(getCtx(scope)?.auditStatus, 'pass',
            'one PASS beside a crashed peer must not satisfy the A gate');
    } finally {
        resetState(scope);
    }
});

test('behavioral: pre-claim fail-fast — busy NAMED agent rejected in 202 while others accept', async () => {
    // Virtual employees mint a fresh UUID id per dispatch and can never be
    // busy (discovered by this harness) — fail-fast pre-claim semantics apply
    // to NAMED (DB) employees, so register one in the temp DB.
    const { insertEmployee } = await import('../../src/core/db.js');
    try { insertEmployee.run('emp-harness-1', 'HarnessNamed', 'claude', 'sonnet', 'backend'); }
    catch { /* already inserted on a previous run */ }
    runBehavior = async () => ({ text: 'DONE', tools: [] });
    const held = claimWorker({ id: 'emp-harness-1', name: 'HarnessNamed' }, 'hold the slot');
    try {
        const { res, state } = fakeRes();
        await batchHandler!(fakeReq({
            wait: false,
            agents: [
                { agent: 'HarnessNamed', task: 'will be busy', parallel: true, affected_files: ['p.ts'] },
                { virtual: 'harness-beta', task: 'should run', parallel: true, affected_files: ['q.ts'] },
            ],
        }), res);
        assert.equal(state.status, 202);
        const workers = (state.body?.["workers"] || []) as WorkerEntry[];
        const named = workers.find(w => w.agent === 'HarnessNamed')!;
        const beta = workers.find(w => w !== named)!;
        assert.equal(named.accepted, false, 'busy named agent rejected at claim time');
        assert.match(String(named.error), /worker_busy/);
        assert.equal(beta.accepted, true, 'independent agent unaffected');
        await waitFor(() => getWorkerSlot(String(beta.agentId))?.state === 'done');
    } finally {
        cancelWorker(held.agentId);
    }
});
