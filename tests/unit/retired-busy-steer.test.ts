import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { MainRunState } from '../../src/agent/spawn.ts';

const forbidden = () => assert.fail('retired admission launched a process or orchestration');
const processSeams = Object.fromEntries(
    ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(name => [name, forbidden]),
);
test.mock.module('node:child_process', {
    namedExports: { ...childProcess, ...processSeams }, defaultExport: { ...childProcess, ...processSeams },
});
test.mock.module('../../src/orchestrator/pipeline.js', { namedExports: {
    orchestrate: forbidden, orchestrateContinue: forbidden, orchestrateReset: forbidden,
    isContinueIntent: () => false, isResetIntent: () => false,
} });
const config = await import('../../src/core/config.ts');
const { reloadSettingsFromDisk } = await import('../../src/core/settings-watch.ts');
const { activeMainProcesses, steerAgent, messageQueue } = await import('../../src/agent/spawn.ts');
const { submitMessage, __resetSubmitDedupForTest } = await import('../../src/orchestrator/gateway.ts');
const { steerHandler } = await import('../../src/cli/handlers-runtime.ts');
const { makeCommandCtx } = await import('../../src/cli/command-context.ts');
const { withSessionScope } = await import('../../src/core/session-context.ts');
const { db, updateSession } = await import('../../src/core/db.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { admitRequest, pendingRequestIds, settleAllPending } = await import('../../src/orchestrator/request-registry.ts');
const initial = config.snapshotSettingsState();
let serial = 0;
test.beforeEach(t => {
    config.replaceSettings({ ...structuredClone(initial.value), cli: 'codex-app',
        workingDir: config.JAW_HOME, multiSession: { ...initial.value.multiSession,
            enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' } }, initial.shape);
    __resetSubmitDedupForTest();
    t.mock.method(globalThis, 'fetch', forbidden);
});
test.afterEach(() => {
    activeMainProcesses.clear();
    settleAllPending('dropped', 'fixture-cleanup');
    config.replaceSettings(structuredClone(initial.value), initial.shape);
});

for (const cli of ['codex-app', 'cursor', 'grok'] as const) {
    for (const entry of ['gateway', 'direct'] as const) {
        test(`${entry}: busy ${cli}, then watched retired choice, rejects only new input`, async () => {
            const id = ++serial, scope = `retired-busy-${id}`, chatSessionId = `retired-chat-${id}`;
            const oldRequestId = `retained-request-${id}`;
            let hookCalls = 0, cancelCalls = 0;
            const run: MainRunState = {
                process: null, starting: false, steering: false, ownerGeneration: 7,
                meta: { cli, origin: 'web', chatSessionId, requestId: oldRequestId },
                cancelTurn: () => { cancelCalls++; },
                ...(cli === 'codex-app'
                    ? { steerTurnInBand: async () => { hookCalls++; return 'steered' as const; } }
                    : { replaceTurn: async (_text: string, commit: () => void) => {
                        hookCalls++; commit(); return { kind: 'dispatched' as const };
                    } }),
            };
            activeMainProcesses.set(scope, run);
            admitRequest(oldRequestId, scope);
            const before = db.prepare('SELECT * FROM messages ORDER BY id').all();
            const events: Array<{ event: string; data: Record<string, unknown> }> = [];
            const off = subscribe(event => events.push(event));
            try {
                assert.equal(reloadSettingsFromDisk({
                    readImpl: () => JSON.stringify({ cli: 'jwc' }), lastSavedRaw: null,
                }), true);
                assert.equal(config.settings.cli, 'jwc');
                let requestId: string;
                if (entry === 'gateway') {
                    const result = submitMessage('new rejected input', { origin: 'web', scope, chatSessionId });
                    assert.equal(result.action, 'rejected');
                    assert.equal(result.reason, 'retired_runtime:jwc');
                    assert.equal(result.disposition, undefined);
                    assert.ok(result.requestId); requestId = result.requestId;
                } else {
                    requestId = `new-request-${id}`;
                    admitRequest(requestId, scope);
                    assert.equal(await steerAgent(scope, 'new rejected input', 'web', { chatSessionId, requestId }), 'retired');
                    assert.equal(await steerAgent(scope, 'duplicate rejected input', 'web', { chatSessionId, requestId }), 'retired');
                }
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(hookCalls, 0);
                assert.equal(cancelCalls, 0);
                assert.equal(activeMainProcesses.get(scope), run);
                assert.equal(run.meta.cli, cli);
                assert.equal(run.ownerGeneration, 7);
                assert.equal(messageQueue.length, 0);
                assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(), before);
                assert.equal(pendingRequestIds().includes(oldRequestId), true);
                assert.equal(pendingRequestIds().includes(requestId), false);
                const receipts = events.filter(event => event.event === 'request_settled' && event.data['requestId'] === requestId);
                assert.equal(receipts.length, 1);
                assert.equal(receipts[0]!.data['outcome'], 'failed');
                assert.equal(receipts[0]!.data['error'], 'retired_runtime:jwc');
                assert.equal(receipts[0]!.data['scope'], scope);
                assert.equal(receipts[0]!.data['sessionId'], chatSessionId);
                assert.equal(events.some(event => ['new_message', 'steer_started', 'agent_done'].includes(event.event)), false);
            } finally { off(); }
        });
    }
}

test('slash steer blocks the no-hook kill path after a watched retirement', async () => {
    const scope = 'retired-slash', chatSessionId = 'retired-slash-chat';
    let cancellations = 0;
    const run: MainRunState = { process: null, starting: false, steering: false, ownerGeneration: 9,
        meta: { cli: 'codex-app', origin: 'web', chatSessionId }, cancelTurn: () => { cancellations++; } };
    activeMainProcesses.set(scope, run);
    reloadSettingsFromDisk({ readImpl: () => '{"cli":"jwc"}', lastSavedRaw: null });
    const ctx = makeCommandCtx('web', 'en', { applySettings: forbidden, clearSession: forbidden });
    const result = await withSessionScope({ scope, chatSessionId }, () => steerHandler(['new input'], ctx));
    assert.equal(result.ok, false);
    assert.equal(result.text, 'retired_runtime:jwc');
    assert.equal(cancellations, 0);
    assert.equal(activeMainProcesses.get(scope), run);
    assert.equal(messageQueue.length, 0);
    const interrupted = submitMessage('do not interrupt the old run', { origin: 'web', scope, chatSessionId,
        midRunPolicy: 'interrupt' });
    assert.equal(interrupted.action, 'rejected');
    assert.equal(interrupted.reason, 'retired_runtime:jwc');
    assert.equal(cancellations, 0);
    assert.equal(activeMainProcesses.get(scope), run);
    assert.equal(messageQueue.length, 0);
});

test('direct steer retains spawn selection precedence: explicit choice, settings, saved session', async () => {
    const scope = 'retired-precedence';
    let calls = 0;
    const run: MainRunState = { process: null, starting: false, steering: false, ownerGeneration: 0,
        meta: { cli: 'codex-app', origin: 'web', chatSessionId: 'precedence-chat' },
        steerTurnInBand: async () => { calls++; return 'unavailable'; } };
    activeMainProcesses.set(scope, run);
    updateSession.run('jwc', null, 'saved', 'auto', config.JAW_HOME, 'high');
    config.settings.cli = '';
    assert.equal(await steerAgent(scope, 'session-selected', 'web'), 'retired');
    config.settings.cli = 'pi';
    assert.equal(await steerAgent(scope, 'explicit-retired', 'web', { cli: 'jwc' }), 'retired');
    config.settings.cli = 'jwc';
    assert.equal(await steerAgent(scope, 'explicit-supported', 'web', { cli: 'codex-app' }), 'fallback-queue');
    assert.equal(calls, 1);
    assert.equal(activeMainProcesses.get(scope), run);
});
