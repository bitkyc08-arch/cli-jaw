import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { MainRunState } from '../../src/agent/spawn.ts';
import type { BusEvent } from '../../src/core/event-bus.ts';

// Set before dynamic backend imports; the runner owns NODE_ENV.
const home = resolve('.tmp/cascade-redirect-test');
mkdirSync(home, { recursive: true }); process.env.CLI_JAW_HOME = home;
let dispatch: (data: Record<string, unknown>) => void;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) {
        if (topic === '*') dispatch = callback;
        return () => {};
    },
    onChannelOpen() {}, onChannelDisconnect() {}, onChannelUnavailable() {},
} });
let agent: typeof import('../../src/agent/spawn.ts');
let bus: typeof import('../../src/core/event-bus.ts');
let sessions: typeof import('../../src/core/chat-sessions.ts');
let persistence: typeof import('../../src/agent/session-persistence.ts');
let liveRun: typeof import('../../src/agent/live-run-state.ts');
let trace: typeof import('../../src/trace/store.ts');
let db: typeof import('../../src/core/db.ts')['db'];
let Projection: typeof import('../../src/agent/runtime/projection.ts')['RuntimeProjection'];
let ui: typeof import('../../public/js/ui.ts');
let ws: typeof import('../../public/js/ws.ts');
let activity: typeof import('../../public/js/features/activity-live.ts');
let virtual: typeof import('../../public/js/virtual-scroll.ts');
let rendering: typeof import('../../public/js/render.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let binding: { sessionId: string; scope: string };
let runId: string;
let owner: MainRunState;
let projection: InstanceType<typeof Projection>;
let events: BusEvent[] = [], inputs: string[] = [];
let holdReceipt = false;
let unsubscribe = () => {};
let serial = 0;
const wire = (event: BusEvent) => dispatch({ ...event.data, event: event.event });

test.before(async () => {
    const config = await import('../../src/core/config.ts');
    config.settings.memory.enabled = false; config.settings.fallbackOrder = [];
    agent = await import('../../src/agent/spawn.ts');
    bus = await import('../../src/core/event-bus.ts');
    sessions = await import('../../src/core/chat-sessions.ts');
    persistence = await import('../../src/agent/session-persistence.ts');
    liveRun = await import('../../src/agent/live-run-state.ts');
    trace = await import('../../src/trace/store.ts');
    ({ db } = await import('../../src/core/db.ts'));
    ({ RuntimeProjection: Projection } = await import('../../src/agent/runtime/projection.ts'));
    setupWebUiDom();
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const path = String(input);
        if (path.includes('/api/auth/token')) return Response.json({ token: 'fixture' });
        const data = path.includes('/orchestrate/snapshot') ? {
            activityIdentity: binding, orc: { state: 'IDLE', scope: binding.scope, ctx: null },
            heartbeat: { pending: 0, deferredPending: 0 }, workers: [], queued: [],
            runtime: { queuePending: 0, busy: agent.isAgentBusy(binding.scope) },
            activeRun: liveRun.getLiveRun(binding.scope),
        } : path.includes('/api/runtime/requests?') ? { requests: [] }
            : path.includes('/api/traces/activity-runs') ? { runs: [], pageSize: 40 } : { count: 0 };
        return Response.json({ ok: true, data });
    });
    ui = await import('../../public/js/ui.ts');
    ws = await import('../../public/js/ws.ts');
    activity = await import('../../public/js/features/activity-live.ts');
    virtual = await import('../../public/js/virtual-scroll.ts');
    rendering = await import('../../public/js/render.ts');
    ({ state } = await import('../../public/js/state.ts')); ws.connect();
});
test.beforeEach(async t => {
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {});
    rendering.cancelPostRender(); virtual.getVirtualScroll().clear();
    ui.clearSteer(); ui.cleanupToolActivity(); activity.clearLiveActivity();
    document.getElementById('chatMessages')!.replaceChildren();
    binding = { sessionId: sessions.createChatSession('Cursor redirect fixture').id, scope: `cursor-web-${++serial}` };
    runId = trace.startTraceRun({ cli: 'cursor', sessionId: binding.sessionId, scopeKey: binding.scope });
    inputs = []; events = []; holdReceipt = false;
    // Typed runtime port: the real steerAgent owns admission, commit, DB insert and receipt.
    owner = { process: null, starting: false, steering: false,
        ownerGeneration: persistence.getSessionOwnershipGeneration(binding.scope).global,
        meta: { origin: 'web', cli: 'cursor', chatSessionId: binding.sessionId },
        replaceTurn: async (text, commitInput) => { inputs.push(text); commitInput(); return { kind: 'dispatched' }; },
    };
    agent.activeMainProcesses.set(binding.scope, owner);
    liveRun.beginLiveRun(binding.scope, 'cursor'); liveRun.setLiveRunTraceId(binding.scope, runId);
    await ws.syncOrchestrateSnapshot('cursor-redirect-test', { hydrateRun: true });
    assert.deepEqual(state.activityIdentity, binding);
    assert.equal(state.agentBusy, true); assert.equal(agent.isAgentBusy(binding.scope), true);
    unsubscribe = bus.subscribe(event => {
        events.push(event);
        if (!(holdReceipt && event.event === 'steer_started')) wire(event);
    });
    projection = new Projection({ ...binding, runId, turnId: runId, audience: 'public' });
    projection.start('cursor'); projection.text('message', 'before', 'Before redirect', 'replace', 'commentary');
    assert.ok(activity.findLiveActivity(runId)); assert.ok(state.currentAgentDiv?.isConnected);
});
test.afterEach(() => {
    unsubscribe(); agent.activeMainProcesses.delete(binding.scope); liveRun.clearLiveRun(binding.scope);
    rendering.cancelPostRender(); ui.cleanupToolActivity(); activity.clearLiveActivity(); ui.clearSteer();
});
test.after(() => { resetWebUiDom(); mock.restoreAll(); });

async function redirect() {
    const prompt = 'Continue with the redirected task', requestId = `redirect-request-${serial}`;
    assert.equal(await agent.steerAgent(binding.scope, prompt, 'web', { chatSessionId: binding.sessionId, requestId }), 'steered');
    const receipts = events.filter(event => event.event === 'steer_started');
    assert.equal(receipts.length, 1);
    const receipt = receipts[0]!;
    assert.deepEqual(receipt.data, { prompt, origin: 'web', ...binding, requestId, mode: 'cancel-reprompt', localDispatch: true });
    for (const field of ['traceRunId', 'runId', 'runtimeFinality', 'runtimeStatus']) assert.equal(Object.hasOwn(receipt.data, field), false);
    assert.deepEqual(inputs, [prompt]);
    assert.deepEqual(db.prepare("SELECT content FROM messages WHERE session_id=? AND role='user'").all(binding.sessionId), [{ content: prompt }]);
    assert.equal(agent.activeMainProcesses.get(binding.scope), owner);
    assert.equal(agent.isAgentBusy(binding.scope), true);
    assert.equal(liveRun.getLiveRun(binding.scope).traceRunId, runId);
    assert.equal(liveRun.getLiveRun(binding.scope).running, true);
    return receipt;
}
function capture() {
    const host = state.currentAgentDiv!;
    return { host, html: host.outerHTML, busy: state.agentBusy, steer: ui.isRecentSteer(), model: structuredClone(activity.findLiveActivity(runId)!.model) };
}
function unchanged(before: ReturnType<typeof capture>) {
    assert.equal(state.currentAgentDiv, before.host, 'redirect receipt is not a terminal');
    assert.equal(state.agentBusy, before.busy); assert.equal(ui.isRecentSteer(), before.steer);
    assert.equal(before.host.outerHTML, before.html);
    assert.deepEqual(activity.findLiveActivity(runId)!.model, before.model);
}
function finish() {
    projection.text('message', 'after', 'After redirect', 'replace', 'commentary');
    assert.ok([...activity.findLiveActivity(runId)!.model.entries.values()].some(entry => entry.kind === 'message' && entry.text === 'After redirect'));
    projection.close({ kind: 'turn-end', status: 'done', finalText: 'Exact redirected final' });
    const terminal = events.find(event => event.event === 'agent_runtime' && event.data['kind'] === 'turn-end')!;
    assert.ok(terminal); wire(terminal);
    assert.equal(events.filter(event => event.event === 'agent_runtime' && event.data['kind'] === 'turn-end').length, 1);
    assert.equal(document.querySelectorAll('.msg-agent').length, 1);
    assert.equal(document.querySelector('.msg-content')?.getAttribute('data-raw'), 'Exact redirected final');
    assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
}

test('real steerAgent cancel-reprompt receipt preserves the live Web owner through continued Activity and one final', async () => {
    const before = capture(); await redirect(); unchanged(before); finish();
});
test('actual redirect receipt does not retire the logical run or drop its later final', async () => {
    await redirect(); finish();
});
for (const [name, patch] of Object.entries({
    foreign: { sessionId: 'foreign', scope: 'foreign' }, replayed: { sseReplay: true },
    'noncanonical metadata': { sessionId: 7, scope: null, requestId: {}, localDispatch: false },
})) test(`cancel-reprompt ${name} receipt makes no ownership or liveness mutation`, async () => {
    holdReceipt = true; const receipt = await redirect();
    const before = capture(); dispatch({ ...receipt.data, ...patch, event: receipt.event }); unchanged(before); finish();
});
test('cancel-reprompt classification never clears a pre-existing steer guard', async () => {
    holdReceipt = true; const receipt = await redirect(); ui.markSteered();
    const before = capture(); wire(receipt); unchanged(before);
});
for (const ending of ['done', 'stopped'] as const) {
    test(`actual A redirect receipt cannot revive ${ending} A or retire same-session B`, async () => {
        holdReceipt = true;
        const receipt = await redirect(); const aRunId = runId; const aHost = state.currentAgentDiv!;
        projection.close({ kind: 'turn-end', status: ending, finalText: ending === 'done' ? 'Answer A' : 'Partial A' });
        trace.finalizeTraceRun(aRunId, ending === 'stopped' ? 'interrupted' : 'done');
        agent.activeMainProcesses.delete(binding.scope); liveRun.clearLiveRun(binding.scope);
        const aHtml = aHost.outerHTML, aModel = structuredClone(activity.findLiveActivity(aRunId)!.model);
        const stoppedGuard = ui.isRecentSteer();
        assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
        wire(receipt);
        assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
        assert.equal(ui.isRecentSteer(), stoppedGuard); assert.equal(aHost.outerHTML, aHtml);
        assert.deepEqual(activity.findLiveActivity(aRunId)!.model, aModel);
        assert.equal(document.querySelectorAll('.msg-agent').length, 1, 'late receipt must not revive A');

        // B deliberately reuses the exact admitted session/scope: metadata cannot
        // distinguish this stale receipt from B. Only nonterminal classification is safe.
        runId = trace.startTraceRun({ cli: 'cursor', sessionId: binding.sessionId, scopeKey: binding.scope });
        assert.notEqual(runId, aRunId);
        owner = { ...owner, meta: { ...owner.meta } };
        agent.activeMainProcesses.set(binding.scope, owner);
        liveRun.beginLiveRun(binding.scope, 'cursor'); liveRun.setLiveRunTraceId(binding.scope, runId);
        bus.publish('agent', 'agent_status', { running: true, ...binding });
        projection = new Projection({ ...binding, runId, turnId: runId, audience: 'public' });
        projection.start('cursor'); projection.text('message', 'B', 'B before late A receipt', 'replace', 'commentary');
        const before = capture(); assert.notEqual(before.host, aHost); assert.equal(before.busy, true);
        wire(receipt); unchanged(before);
        assert.equal(agent.activeMainProcesses.get(binding.scope), owner);
        assert.equal(agent.isAgentBusy(binding.scope), true); assert.equal(liveRun.getLiveRun(binding.scope).traceRunId, runId);
        assert.equal(aHost.outerHTML, aHtml); assert.deepEqual(activity.findLiveActivity(aRunId)!.model, aModel);
        projection.text('message', 'B', 'B continues after late A receipt', 'replace', 'commentary');
        projection.close({ kind: 'turn-end', status: 'done', finalText: 'Exact B final' });
        const terminals = events.filter(event => event.event === 'agent_runtime'
            && event.data['runId'] === runId && event.data['kind'] === 'turn-end');
        assert.equal(terminals.length, 1); wire(terminals[0]!);
        assert.equal(document.querySelectorAll('.msg-agent').length, 2);
        assert.equal(before.host.querySelector('.msg-content')?.getAttribute('data-raw'), 'Exact B final');
        assert.equal(aHost.outerHTML, aHtml);
        assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
    });
}
test('missing legacy mode retains kill/restart retirement beyond the time guard', t => {
    const host = state.currentAgentDiv!;
    dispatch({ event: 'steer_started' });
    assert.equal(ui.isRecentSteer(), true); assert.equal(state.currentAgentDiv, null);
    const count = document.querySelectorAll('.msg-agent').length, html = host.outerHTML;
    const later = Date.now() + 10_000; t.mock.method(Date, 'now', () => later);
    assert.equal(ui.isRecentSteer(), false);
    dispatch({ event: 'agent_output', traceRunId: runId, text: 'OLD REPLAY', textLen: 100, sseReplay: true });
    dispatch({ event: 'agent_done', traceRunId: runId, text: 'OLD FINAL', sseReplay: true });
    assert.equal(document.querySelectorAll('.msg-agent').length, count); assert.equal(host.outerHTML, html);
    assert.equal(state.currentAgentDiv, null);
});
