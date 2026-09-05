import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { MainRunState } from '../../src/agent/spawn.ts';

function forbidden(name: string) {
    return (..._args: unknown[]): never => assert.fail(`common replacement crossed forbidden seam: ${name}`);
}
// A routing regression must not launch a provider or capability probe.
const processSeams = Object.fromEntries(
    ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(name => [name, forbidden(name)]),
);
test.mock.module('node:child_process', {
    namedExports: { ...childProcess, ...processSeams }, defaultExport: { ...childProcess, ...processSeams },
});
const config = await import('../../src/core/config.ts');
const settings = { ...config.settings, cli: 'cursor', workingDir: config.JAW_HOME, projectDirs: [config.JAW_HOME],
    perCli: {}, activeOverrides: {}, fallbackOrder: [],
    multiSession: { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' } };
test.mock.module('../../src/core/config.js', { namedExports: { ...config, settings,
    detectCli: forbidden('detectCli'), detectAllCli: forbidden('detectAllCli') } });
const { activeMainProcesses, canSteerAgent, steerAgent, enqueueMessage, messageQueue, killActiveAgent } = await import('../../src/agent/spawn.ts');
const { MainReplacementOwnerMismatchError } = await import('../../src/agent/runtime/replace-turn.ts');
const { db } = await import('../../src/core/db.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { admitRequest, settleAllPending } = await import('../../src/orchestrator/request-registry.ts');
const { clearGoalTimers } = await import('../../src/agent/lifecycle-handler.ts');
const { bumpScopeSessionGeneration, bumpSessionOwnershipGeneration, resetSessionOwnershipGenerationForTest }
    = await import('../../src/agent/session-persistence.ts');

let serial = 0;
test.beforeEach(t => {
    resetSessionOwnershipGenerationForTest();
    t.mock.method(globalThis, 'fetch', forbidden('fetch'));
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
});
test.afterEach(() => {
    activeMainProcesses.clear(); clearGoalTimers(); settleAllPending('dropped', 'fixture-cleanup');
});
function options() {
    const id = ++serial;
    return { scopeKey: 'replacement-scope-' + id, chatSessionId: 'replacement-chat-' + id, requestId: 'replacement-request-' + id };
}
function rows(sessionId: string) {
    return db.prepare('SELECT role,content FROM messages WHERE session_id=? ORDER BY id').all(sessionId);
}
function capture() {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const off = subscribe(event => events.push({ type: event.event, data: event.data }));
    return { events, off };
}

function heldReplacement(opts: ReturnType<typeof options>) {
    const entered = Promise.withResolvers<void>(), dispatch = Promise.withResolvers<void>();
    let stopped = false;
    const run: MainRunState = { process: null, starting: false, steering: false, ownerGeneration: 7,
        meta: { cli: 'cursor', origin: 'web', chatSessionId: opts.chatSessionId },
        cancelTurn: () => { stopped = true; },
        replaceTurn: async (_text, commitInput) => {
            entered.resolve(); await dispatch.promise;
            commitInput(); return { kind: 'dispatched' };
        } };
    activeMainProcesses.set(opts.scopeKey, run); admitRequest(opts.requestId, opts.scopeKey);
    return { run, entered, dispatch, get stopped() { return stopped; } };
}

for (const finish of ['stop', 'natural'] as const) test(`held native no-start observes ${finish} without guessing from main-map absence`, async () => {
    const opts = options(), f = heldReplacement(opts), { events, off } = capture();
    f.run.replaceTurn = async () => { f.entered.resolve(); await f.dispatch.promise; return { kind: 'race', reason: 'busy' }; };
    const pending = steerAgent(opts.scopeKey, 'uncommitted input', 'web', { requestId: opts.requestId });
    try {
        await f.entered.promise;
        if (finish === 'stop') killActiveAgent(opts.scopeKey, 'user');
        else activeMainProcesses.delete(opts.scopeKey);
        f.dispatch.resolve();
        assert.equal(await pending, finish === 'stop' ? 'cancelled' : 'fallback-queue');
        assert.deepEqual(rows(opts.chatSessionId), []);
        const receipts = events.filter(event => event.type === 'request_settled' && event.data['requestId'] === opts.requestId);
        assert.equal(receipts.length, finish === 'stop' ? 1 : 0);
        if (finish === 'stop') assert.equal(receipts[0]!.data['outcome'], 'cancelled');
    } finally { f.dispatch.resolve(); off(); }
});

for (const invalidation of ['map replacement', 'generation change', 'canonical scope reset', 'canonical global reset'] as const) {
    test(`deferred replacement refuses stale input after ${invalidation}`, async () => {
        const opts = options(), f = heldReplacement(opts), { events, off } = capture();
        const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
        let resolved = false;
        const steering = steerAgent(opts.scopeKey, 'held B', 'web', { requestId: opts.requestId }).then(outcome => {
            resolved = true;
            if (outcome === 'fallback-queue') enqueueMessage('held B', 'web', { scope: opts.scopeKey, chatSessionId: opts.chatSessionId });
            return outcome;
        });
        try {
            await f.entered.promise;
            if (invalidation === 'map replacement') activeMainProcesses.set(opts.scopeKey, { ...f.run });
            else if (invalidation === 'generation change') f.run.ownerGeneration++;
            else {
                if (invalidation === 'canonical scope reset') bumpScopeSessionGeneration(opts.scopeKey);
                else bumpSessionOwnershipGeneration();
                assert.equal(activeMainProcesses.get(opts.scopeKey), f.run);
                assert.equal(f.run.ownerGeneration, 7, 'canonical resets leave the captured run field unchanged');
            }
            const rejected = assert.rejects(steering, error => error instanceof MainReplacementOwnerMismatchError
                && error.code === 'native_replacement_owner_mismatch' && error.message === error.code);
            f.dispatch.resolve(); await rejected;
            assert.equal(resolved, false);
            assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM messages').get(), before);
            assert.deepEqual(events, []);
            assert.equal(messageQueue.some(item => item.scope === opts.scopeKey), false);
        } finally { f.dispatch.resolve(); off(); }
    });
}

test('Stop with the same owner still commits an already dispatched replacement once', async () => {
    const opts = options(), f = heldReplacement(opts), { events, off } = capture();
    const steering = steerAgent(opts.scopeKey, 'held B', 'web', { requestId: opts.requestId });
    try {
        await f.entered.promise;
        f.run.cancelTurn!('user');
        assert.equal(f.stopped, true); assert.equal(activeMainProcesses.get(opts.scopeKey), f.run);
        f.dispatch.resolve(); assert.equal(await steering, 'steered');
        assert.deepEqual(rows(opts.chatSessionId), [{ role: 'user', content: 'held B' }]);
        assert.equal(events.filter(e => e.type === 'new_message').length, 1);
        assert.equal(events.filter(e => e.type === 'steer_started' && e.data['localDispatch'] === true).length, 1);
        assert.equal(events.filter(e => e.type === 'request_settled' && e.data['outcome'] === 'steered').length, 1);
        assert.equal(messageQueue.some(item => item.scope === opts.scopeKey), false);
    } finally { f.dispatch.resolve(); off(); }
});

test('common replacement hook dispatches for Cursor and other providers before in-band steering', async () => {
    for (const cli of ['cursor', 'claude', 'codex-app']) {
        const opts = options(), { events, off } = capture();
        const run: MainRunState = { process: null, starting: false, steering: false, ownerGeneration: 0,
            meta: { cli, origin: 'web', chatSessionId: opts.chatSessionId },
            replaceTurn: async (text, commitInput) => {
                assert.equal(text, 'generic B'); assert.equal(rows(opts.chatSessionId).length, 0);
                commitInput(); return { kind: 'dispatched' };
            } };
        activeMainProcesses.set(opts.scopeKey, run); admitRequest(opts.requestId, opts.scopeKey);
        try {
            assert.equal(canSteerAgent(opts.scopeKey), true, 'replacement hook alone enables CLI steering');
            run.steerTurnInBand = async () => assert.fail('replacement fell through to in-band handler');
            assert.equal(await steerAgent(opts.scopeKey, 'generic B', 'web', { requestId: opts.requestId }), 'steered');
            assert.deepEqual(rows(opts.chatSessionId), [{ role: 'user', content: 'generic B' }]);
            assert.equal(events.filter(e => e.type === 'steer_started' && e.data['mode'] === 'cancel-reprompt'
                && e.data['localDispatch'] === true).length, 1);
            assert.equal(events.filter(e => e.type === 'request_settled' && e.data['requestId'] === opts.requestId).length, 1);
        } finally { off(); activeMainProcesses.delete(opts.scopeKey); }
    }
});

test('common replacement hook distinguishes busy no-start, fatal and inconsistent receipts', async () => {
    const opts = options(), { events, off } = capture();
    const run: MainRunState = { process: null, starting: false, steering: false, ownerGeneration: 0,
        meta: { cli: 'cursor', origin: 'web', chatSessionId: opts.chatSessionId },
        replaceTurn: async () => ({ kind: 'unavailable', reason: 'busy' }) };
    activeMainProcesses.set(opts.scopeKey, run);
    try {
        assert.equal(await steerAgent(opts.scopeKey, 'queued C', 'web'), 'fallback-queue');
        assert.equal(events.find(e => e.type === 'steer_rejected')?.data['reason'], 'busy');
        const failure = new Error('fixture fatal replacement');
        run.replaceTurn = async () => ({ kind: 'failed', error: failure });
        await assert.rejects(steerAgent(opts.scopeKey, 'failed C', 'web'), error => error === failure);
        run.replaceTurn = async () => ({ kind: 'dispatched' });
        await assert.rejects(steerAgent(opts.scopeKey, 'missing callback', 'web'), /native_replacement_inconsistent_receipt/);
        assert.equal(rows(opts.chatSessionId).length, 0);
        run.replaceTurn = async (_text, commitInput) => { commitInput(); commitInput(); return { kind: 'dispatched' }; };
        await assert.rejects(steerAgent(opts.scopeKey, 'duplicate callback', 'web'), /native_replacement_duplicate_input/);
        assert.deepEqual(rows(opts.chatSessionId), [{ role: 'user', content: 'duplicate callback' }]);
    } finally { off(); activeMainProcesses.delete(opts.scopeKey); }
});
