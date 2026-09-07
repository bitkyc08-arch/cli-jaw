import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withSessionScope } from '../../src/core/session-context.ts';
import type { CliCommandContext } from '../../src/cli/command-context.ts';
import { cancelSteerInputs } from '../../src/agent/steer-input-guard.ts';

const calls: Array<{ name: string; args: unknown[] }> = [];
let busy = true, capable = true;
let outcome: 'steered' | 'fallback-queue' | 'new-run' | 'cancelled' | Error = 'steered';
let stopBeforeReturn = false;
let mainGate: Promise<void> | undefined, exitGate: Promise<void> | undefined;
let mainEntered: (() => void) | undefined, exitEntered: (() => void) | undefined;
const record = (name: string, args: unknown[]) => { calls.push({ name, args }); };
test.mock.module('../../src/agent/spawn.js', { namedExports: {
    isAgentBusy: (scope: string) => { record('busy', [scope]); return busy; },
    canSteerAgent: (scope: string) => { record('capable', [scope]); return capable; },
    steerAgent: async (...args: unknown[]) => {
        record('steer', args); if (outcome instanceof Error) throw outcome;
        if (stopBeforeReturn) cancelSteerInputs(String(args[0]));
        return outcome;
    },
    killActiveAgent: (...args: unknown[]) => { record('kill', args); return true; },
    waitForProcessEnd: async (...args: unknown[]) => { record('wait-process', args); },
    waitForMainProcessEnd: async (...args: unknown[]) => { record('wait-main', args); mainEntered?.(); await mainGate; },
    waitForExitSettled: async (...args: unknown[]) => { record('wait-exit', args); exitEntered?.(); await exitGate; },
    getSteerWaitMsForActiveAgent: () => 5000,
} });
test.mock.module('../../src/orchestrator/gateway.js', { namedExports: {
    submitMessage: (...args: unknown[]) => { record('submit', args); return { action: 'started' }; },
} });
const { steerHandler } = await import('../../src/cli/handlers-runtime.ts');
const binding = { scope: 'slash-native-scope', chatSessionId: 'slash-native-chat' };
const ctx: CliCommandContext = { interface: 'web', locale: 'en' };
const invoke = (args = ['use', 'new', 'instruction'], context = ctx) =>
    withSessionScope(binding, () => steerHandler(args, context));
test.beforeEach(() => {
    calls.length = 0; busy = true; capable = true; outcome = 'steered'; stopBeforeReturn = false;
    mainGate = undefined; exitGate = undefined; mainEntered = undefined; exitEntered = undefined;
});

for (const value of ['steered', 'new-run'] as const) test(`actual slash handler never requeues a ${value} result`, async () => {
    outcome = value;
    const result = await invoke();
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(call => call.name), ['busy', 'capable', 'steer']);
    assert.deepEqual(calls[2]!.args, [binding.scope, 'use new instruction', 'web', binding]);
});

test('actual slash handler queues a no-start exactly once with captured placement', async () => {
    outcome = 'fallback-queue';
    const result = await invoke();
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(call => call.name), ['busy', 'capable', 'steer', 'submit']);
    assert.deepEqual(calls[3]!.args, ['use new instruction', { origin: 'web', ...binding, midRunPolicy: 'followup' }]);
});

test('actual slash handler propagates fatal replacement without queue, kill or resend', async () => {
    const error = new Error('native_replacement_failed'); outcome = error;
    await assert.rejects(invoke, actual => actual === error);
    assert.deepEqual(calls.map(call => call.name), ['busy', 'capable', 'steer']);
});

test('actual slash handler acknowledges a cancelled redirect without follow-up submission', async () => {
    outcome = 'cancelled';
    const result = await invoke();
    assert.equal(result.ok, true); assert.equal(result.type, 'success');
    assert.match(result.text!, /cancelled/i);
    assert.deepEqual(calls.map(call => call.name), ['busy', 'capable', 'steer']);
});

test('slash consumer fences a stale fallback even when the producer returns busy after Stop', async () => {
    outcome = 'fallback-queue'; stopBeforeReturn = true;
    const result = await invoke();
    assert.equal(result.ok, true); assert.match(result.text!, /cancelled/i);
    assert.deepEqual(calls.map(call => call.name), ['busy', 'capable', 'steer']);
});

test('Stop cannot retract a producer-reported successful dispatch at the slash consumer', async () => {
    stopBeforeReturn = true;
    for (const value of ['steered', 'new-run'] as const) {
        calls.length = 0; outcome = value;
        assert.equal((await invoke()).type, 'steer');
        assert.deepEqual(calls.map(call => call.name), ['busy', 'capable', 'steer']);
    }
});

test('empty or idle slash steer does not dispatch or queue', async () => {
    assert.equal((await invoke([])).ok, false); assert.deepEqual(calls, []);
    busy = false; assert.equal((await invoke()).ok, false);
    assert.deepEqual(calls.map(call => call.name), ['busy']);
});

test('no-capability web handler keeps kill, process wait, exit barrier and one follow-up order', async () => {
    capable = false;
    assert.equal((await invoke()).ok, true);
    assert.deepEqual(calls.map(call => call.name), ['busy', 'capable', 'kill', 'wait-main', 'wait-exit', 'submit']);
    assert.deepEqual(calls.find(call => call.name === 'wait-main')!.args, [binding.scope, 5000]);
    assert.deepEqual(calls.at(-1)!.args, ['use new instruction', { origin: 'web', ...binding }]);
});

test('no-capability remote handler retains existing handoff without a second submission', async () => {
    capable = false;
    const result = await invoke(undefined, { interface: 'slack', locale: 'en', clearSession: async () => { record('clear', []); } });
    assert.equal(result.ok, true); assert.equal(result.steerPrompt, 'use new instruction');
    assert.deepEqual(calls.map(call => call.name), ['busy', 'capable', 'kill', 'wait-main', 'wait-exit', 'clear']);
});

for (const remote of [false, true]) test(`fallback ${remote ? 'remote' : 'web'} steer awaits main then captured exit barrier exactly once`, async () => {
    capable = false;
    const main = Promise.withResolvers<void>(), exit = Promise.withResolvers<void>();
    mainGate = main.promise; exitGate = exit.promise;
    const atMain = Promise.withResolvers<void>(), atExit = Promise.withResolvers<void>();
    mainEntered = atMain.resolve; exitEntered = atExit.resolve;
    const context: CliCommandContext = remote ? { interface: 'slack', locale: 'en', clearSession: async () => { record('clear', []); } } : ctx;
    const running = invoke(undefined, context);
    try {
        // On the old path this resolves at exit instead of main: the already
        // existing inclusive call is observed, not a missing new export.
        await Promise.race([atMain.promise, atExit.promise]);
        assert.deepEqual(calls.map(call => call.name), ['busy', 'capable', 'kill', 'wait-main']);
        assert.deepEqual(calls.find(call => call.name === 'kill')!.args, [binding.scope, 'steer']);
        assert.deepEqual(calls.at(-1)!.args, [binding.scope, 5000]);
        main.resolve(); await atExit.promise;
        assert.deepEqual(calls.map(call => call.name), ['busy', 'capable', 'kill', 'wait-main', 'wait-exit']);
        assert.deepEqual(calls.at(-1)!.args, [binding.scope]);
        exit.resolve(); assert.equal((await running).ok, true);
        assert.deepEqual(calls.map(call => call.name), ['busy', 'capable', 'kill', 'wait-main', 'wait-exit', remote ? 'clear' : 'submit']);
    } finally { main.resolve(); exit.resolve(); await running; }
});
