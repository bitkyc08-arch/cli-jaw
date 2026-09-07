import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { MainRunState } from '../../src/agent/spawn.ts';
import type { BusEvent } from '../../src/core/event-bus.ts';

// Ported by assertion from 184d9826b07e909d3b050626aa98eafcde908da5.
// Real steer admission/commit/SQLite/bus/journal/Web reducer and final renderer;
// only replacement dispatch and browser transport are ports. No provider or ACP
// cancellation proof is claimed: cursor-acp-steer owns that distinct boundary.
const home = process.env.CLI_JAW_HOME!;
let dispatch: (data: Record<string, unknown>) => void;
let opened: () => void;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) {
        if (topic === '*') dispatch = callback;
        return () => {};
    },
    onChannelOpen(callback: () => void) { opened = callback; }, onChannelDisconnect() {}, onChannelUnavailable() {},
} });
// Trace drawer imports bundler-only SVG assets. This suite never opens Trace.
mock.module('../../public/js/features/trace-drawer.js', { namedExports: {
    closeTraceDrawer() {}, openTraceDrawer() { assert.fail('Receipt unexpectedly opened Trace'); },
} });
let agent: typeof import('../../src/agent/spawn.ts');
let bus: typeof import('../../src/core/event-bus.ts');
let sessions: typeof import('../../src/core/chat-sessions.ts');
let persistence: typeof import('../../src/agent/session-persistence.ts');
let liveRun: typeof import('../../src/agent/live-run-state.ts');
let trace: typeof import('../../src/trace/store.ts');
let db: typeof import('../../src/core/db.ts')['db'];
let config: typeof import('../../src/core/config.ts');
let savedSettings: typeof config.settings;
let Projection: typeof import('../../src/agent/runtime/projection.ts')['RuntimeProjection'];
let ui: typeof import('../../public/js/ui.ts');
let ws: typeof import('../../public/js/ws.ts');
let activity: typeof import('../../public/js/features/activity-live.ts');
let history: typeof import('../../public/js/features/activity-history.ts');
let virtual: typeof import('../../public/js/virtual-scroll.ts');
let rendering: typeof import('../../public/js/render.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let binding: { sessionId: string; scope: string };
let runId: string, owner: MainRunState, projection: InstanceType<typeof Projection>;
let events: BusEvent[] = [], inputs: string[] = [];
let holdReceipt = false, serial = 0;
let unsubscribe = () => {};
const unexpectedRequests: string[] = [], dispatchFailures: unknown[] = [];
const requests: string[] = [];
const bootstrapLoad = Promise.withResolvers<void>();
const bootstrapRelease = Promise.withResolvers<void>();
const bootstrapDone = Promise.withResolvers<void>();
const sidebarDone = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
const frames = new Map<number, FrameRequestCallback>();
const timers = new Map<ReturnType<typeof setTimeout>, number>();
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
let frameId = 0;
const globalNames = ['window', 'document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'Node', 'NodeFilter',
    'navigator', 'localStorage', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'IntersectionObserver', 'ResizeObserver', 'atob', 'btoa', 'indexedDB'];
const globals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

function wire(event: BusEvent): void {
    // Serialize the producer packet as the SSE boundary does, never add finality.
    dispatch({ ...JSON.parse(JSON.stringify(event.data)), event: event.event });
}
async function drain(): Promise<void> {
    for (let pass = 0; pass < 50; pass++) {
        const pending = [...frames.values()]; frames.clear();
        for (const frame of pending) frame(Date.now());
        await new Promise<void>(resolve => setImmediate(resolve));
        if (!frames.size) return;
    }
    assert.fail('Web frame queue did not drain within 50 passes');
}

test.before(async () => {
    config = await import('../../src/core/config.ts');
    assert.equal(config.JAW_HOME, home);
    savedSettings = structuredClone(config.settings);
    config.settings.memory.enabled = false;
    config.settings.fallbackOrder = [];
    agent = await import('../../src/agent/spawn.ts');
    bus = await import('../../src/core/event-bus.ts');
    sessions = await import('../../src/core/chat-sessions.ts');
    persistence = await import('../../src/agent/session-persistence.ts');
    liveRun = await import('../../src/agent/live-run-state.ts');
    trace = await import('../../src/trace/store.ts');
    ({ db } = await import('../../src/core/db.ts'));
    ({ RuntimeProjection: Projection } = await import('../../src/agent/runtime/projection.ts'));
    binding = { sessionId: sessions.createChatSession('Web bootstrap').id, scope: 'cursor-web-bootstrap' };
    setupWebUiDom();
    // ws.applyOrcState schedules an unexported 700ms cosmetic pulse on each
    // snapshot. Own browser timers so deleting the DOM cannot strand callbacks.
    mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        const timer = realSetTimeout(() => { timers.delete(timer); callback(...args); }, delay);
        timers.set(timer, delay ?? 0); return timer;
    });
    mock.method(globalThis, 'clearTimeout', timer => {
        timers.delete(timer as ReturnType<typeof setTimeout>); realClearTimeout(timer);
    });
    mock.method(globalThis, 'requestAnimationFrame', callback => { frames.set(++frameId, callback); return frameId; });
    mock.method(globalThis, 'cancelAnimationFrame', id => { frames.delete(id); });
    const warn = console.warn.bind(console);
    mock.method(console, 'warn', (...args: unknown[]) => {
        // Deliberate DOM storage limitation; actual cache writes have their own
        // web-activity-answer-cache suite. All other warnings remain visible.
        if (String(args[0]).startsWith('[idb-cache]')) return;
        warn(...args);
    });
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), 'http://127.0.0.1');
        const key = `${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${url.pathname}${url.search}`;
        requests.push(key);
        try {
            assert.equal(url.origin, 'http://127.0.0.1');
            assert.ok(key.startsWith('GET '));
            if (url.pathname === '/api/auth/token' && !url.search) return Response.json({ token: 'fixture' });
            if (url.pathname === '/api/goal' && !url.search) return Response.json({ ok: true, goal: null,
                pauseGate: { armed: false, attempts: 0, requiredAttempts: 2, reason: null, nextAction: null } });
            if (url.pathname === '/api/settings' && !url.search) return Response.json({ workingDir: home });
            if (url.pathname === '/api/messages') {
                assert.deepEqual([...url.searchParams.entries()], [['limit', '3000'], ['withSession', '1']]);
                return Response.json({ ok: true, data: { sessionId: binding.sessionId, messages: [] } });
            }
            if (url.pathname === '/api/bgtask') {
                assert.deepEqual([...url.searchParams.entries()], [['status', 'running']]);
                return Response.json({ tasks: [] });
            }
            // Explicitly unavailable peripheral sidebars, not fabricated success.
            if (['/api/memory-files', '/api/memory/status'].includes(url.pathname) && !url.search) {
                return Response.json({ error: 'fixture_sidebar_unavailable' }, { status: 503 });
            }
            if (url.pathname === '/api/orchestrate/snapshot') {
                assert.ok([...url.searchParams.keys()].every(name => name === 'session'));
                assert.ok(!url.search || url.searchParams.get('session') === binding.sessionId);
                // Current snapshot is raw top-level, NOT the donor ok/data wrapper.
                return Response.json({ activityIdentity: binding,
                    orc: { state: 'IDLE', scope: binding.scope, ctx: null },
                    heartbeat: { pending: 0, deferredPending: 0 }, workers: [], queued: [],
                    runtime: { queuePending: 0, busy: agent.isAgentBusy(binding.scope) },
                    activeRun: liveRun.getLiveRun(binding.scope) });
            }
            if (url.pathname === '/api/messages/count') {
                assert.ok([...url.searchParams.keys()].every(name => name === 'session'));
                assert.ok(!url.search || url.searchParams.get('session') === binding.sessionId);
                const row = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(binding.sessionId);
                return Response.json({ ok: true, data: row });
            }
            if (url.pathname === '/api/runtime/requests') {
                assert.deepEqual([...url.searchParams.entries()], [['sessionId', binding.sessionId]]);
                return Response.json({ ok: true, data: { requests: [] } });
            }
            if (url.pathname === '/api/traces/activity-runs') {
                assert.deepEqual([...url.searchParams.entries()], [['session', binding.sessionId], ['after', '']]);
                return Response.json({ ok: true, data: { runs: [], pageSize: 40 } });
            }
            throw new Error('Unexpected HTTP route');
        } catch (error) {
            unexpectedRequests.push(`${key}: ${String(error)}`);
            throw error; // API may swallow this; the independent ledger must still fail.
        }
    });
    ui = await import('../../public/js/ui.ts');
    mock.module('../../public/js/ui.js', { namedExports: { ...ui,
        async loadMessages() { bootstrapLoad.resolve(); await bootstrapRelease.promise; return ui.loadMessages(); },
        reconcileChatBottomAfterRestore: (...args: Parameters<typeof ui.reconcileChatBottomAfterRestore>) => {
            ui.reconcileChatBottomAfterRestore(...args);
            if (args[0] === 'reconnect') bootstrapDone.resolve();
        },
    } });
    const memory = await import('../../public/js/features/memory.ts');
    const background = await import('../../public/js/features/bgtask-badge.ts');
    mock.module('../../public/js/features/memory.js', { namedExports: { ...memory,
        async refreshMemorySidebar() { await memory.refreshMemorySidebar(); sidebarDone[0]!.resolve(); },
    } });
    mock.module('../../public/js/features/bgtask-badge.js', { namedExports: { ...background,
        async refreshBgtaskBadge() { await background.refreshBgtaskBadge(); sidebarDone[1]!.resolve(); },
    } });
    ws = await import('../../public/js/ws.ts');
    activity = await import('../../public/js/features/activity-live.ts');
    history = await import('../../public/js/features/activity-history.ts');
    virtual = await import('../../public/js/virtual-scroll.ts');
    rendering = await import('../../public/js/render.ts');
    ({ state } = await import('../../public/js/state.ts'));
    ws.connect(); assert.equal(typeof dispatch, 'function'); opened();
    // Hold the real loader, then observe reconnect's post-snapshot callback and
    // the real sidebar promises. Event-loop turns are not import completion.
    await bootstrapLoad.promise;
    assert.equal(state.activityIdentity, null);
    assert.equal(requests.some(key => key.includes('/api/orchestrate/snapshot')), false);
    bootstrapRelease.resolve();
    await bootstrapDone.promise;
    await Promise.all(sidebarDone.map(done => done.promise));
    assert.ok(requests.includes('GET /api/bgtask?status=running'), 'reconnect bootstrap completed');
    await drain();
    assert.deepEqual(state.activityIdentity, binding);
});

test.beforeEach(async () => {
    rendering.cancelPostRender(); virtual.getVirtualScroll().clear();
    ui.clearSteer(); ui.cleanupToolActivity(); activity.clearLiveActivity();
    document.getElementById('chatMessages')!.replaceChildren();
    binding = { sessionId: sessions.createChatSession('Cursor Web receipt fixture').id, scope: `cursor-web-${++serial}` };
    inputs = []; events = []; holdReceipt = false;
    // Admit this chat while idle, then start a fresh live run. A running snapshot
    // instead requests history recovery, a separately owned N/P test surface.
    await ws.syncOrchestrateSnapshot('cursor-redirect-test', { hydrateRun: true });
    assert.deepEqual(state.activityIdentity, binding);
    assert.equal(state.agentBusy, false);
    runId = trace.startTraceRun({ cli: 'cursor', sessionId: binding.sessionId, scopeKey: binding.scope });
    owner = { process: null, starting: false, steering: false,
        ownerGeneration: persistence.getSessionOwnershipGeneration(binding.scope).global,
        meta: { origin: 'web', cli: 'cursor', chatSessionId: binding.sessionId },
        replaceTurn: async (text, commitInput) => { inputs.push(text); commitInput(); return { kind: 'dispatched' }; },
    };
    agent.activeMainProcesses.set(binding.scope, owner);
    liveRun.beginLiveRun(binding.scope, 'cursor'); liveRun.setLiveRunTraceId(binding.scope, runId);
    unsubscribe = bus.subscribe(event => {
        if (events.length >= 128) { dispatchFailures.push('event bound exceeded'); return; }
        events.push(event);
        try { if (!(holdReceipt && event.event === 'steer_started')) wire(event); }
        catch (error) { dispatchFailures.push(error); } // bus itself catches listener errors
    });
    projection = new Projection({ ...binding, runId, turnId: runId, audience: 'public' });
    bus.publish('agent', 'agent_status', { running: true, ...binding });
    assert.equal(state.agentBusy, true); assert.equal(agent.isAgentBusy(binding.scope), true);
    await drain();
});

test.afterEach(async () => {
    unsubscribe();
    agent.activeMainProcesses.delete(binding.scope); liveRun.clearLiveRun(binding.scope);
    try {
        trace.finalizeTraceRun(runId, 'interrupted', null, { onlyIfRunning: true });
        await drain();
        assert.deepEqual(unexpectedRequests, []);
        assert.deepEqual(dispatchFailures, []);
    } finally {
        history.disposeActivityHistory(); activity.clearLiveActivity();
        rendering.cancelPostRender(); ui.cleanupToolActivity(); ui.clearSteer();
        virtual.getVirtualScroll().clear();
        assert.equal(frames.size, 0);
        for (const timer of timers.keys()) realClearTimeout(timer);
        timers.clear();
        assert.equal(agent.activeMainProcesses.has(binding.scope), false);
        assert.equal(liveRun.getLiveRun(binding.scope).running, false);
    }
});
test.after(async () => {
    try {
        await drain();
        assert.deepEqual(unexpectedRequests, []); assert.deepEqual(dispatchFailures, []);
        assert.ok(requests.some(path => path.includes('/api/orchestrate/snapshot')));
        console.log('C cleanup: no unknown HTTP, dispatch failures, frames or owned backend runs');
    } finally {
        history?.disposeActivityHistory(); activity?.clearLiveActivity();
        rendering?.cancelPostRender(); ui?.cleanupToolActivity(); virtual?.getVirtualScroll().clear();
        for (const timer of timers.keys()) realClearTimeout(timer);
        timers.clear();
        resetWebUiDom(); mock.restoreAll();
        for (const [name, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        if (config && savedSettings) {
            for (const key of Object.keys(config.settings)) Reflect.deleteProperty(config.settings, key);
            Object.assign(config.settings, savedSettings);
        }
        db?.close(); rmSync(home, { recursive: true, force: true });
        assert.equal(existsSync(home), false);
        console.log('C cleanup: DB closed; isolated file home removed; DOM/globals/settings/mocks restored');
    }
});

function startActivity(): void {
    projection.start('cursor'); projection.text('message', 'before', 'Before redirect', 'replace', 'commentary');
    assert.ok(activity.findLiveActivity(runId)); assert.ok(state.currentAgentDiv?.isConnected);
}
async function redirect() {
    const prompt = 'Continue with the redirected task', requestId = `redirect-request-${serial}`;
    assert.equal(await agent.steerAgent(binding.scope, prompt, 'web', { chatSessionId: binding.sessionId, requestId }), 'steered');
    const receipts = events.filter(event => event.event === 'steer_started');
    assert.equal(receipts.length, 1);
    const receipt = receipts[0]!;
    assert.deepEqual(receipt.data, { prompt, origin: 'web', ...binding, requestId, mode: 'cancel-reprompt', localDispatch: true });
    for (const field of ['traceRunId', 'runId', 'runtimeFinality', 'runtimeStatus', 'runtimeOutcome', 'partialText']) {
        assert.equal(Object.hasOwn(receipt.data, field), false);
    }
    assert.deepEqual(inputs, [prompt]);
    assert.deepEqual(db.prepare("SELECT content FROM messages WHERE session_id=? AND role='user'").all(binding.sessionId), [{ content: prompt }]);
    assert.equal(events.filter(event => event.event === 'new_message' && event.data['content'] === prompt).length, 1);
    assert.equal(agent.activeMainProcesses.get(binding.scope), owner);
    assert.equal(agent.isAgentBusy(binding.scope), true);
    assert.equal(liveRun.getLiveRun(binding.scope).traceRunId, runId);
    assert.equal(liveRun.getLiveRun(binding.scope).running, true);
    assert.equal(events.some(event => event.event === 'agent_done' || event.data['kind'] === 'turn-end'), false);
    return receipt;
}
function capture() {
    const host = state.currentAgentDiv!;
    assert.ok(host?.isConnected);
    return { host, html: host.outerHTML, busy: state.agentBusy, steer: ui.isRecentSteer(),
        model: structuredClone(activity.findLiveActivity(runId)!.model), backend: liveRun.getLiveRun(binding.scope) };
}
function unchanged(before: ReturnType<typeof capture>): void {
    assert.equal(state.currentAgentDiv, before.host, 'receipt is not a terminal');
    assert.equal(state.agentBusy, before.busy); assert.equal(ui.isRecentSteer(), before.steer);
    assert.equal(before.host.outerHTML, before.html);
    assert.deepEqual(activity.findLiveActivity(runId)!.model, before.model);
    assert.deepEqual(liveRun.getLiveRun(binding.scope), before.backend);
    assert.equal(agent.activeMainProcesses.get(binding.scope), owner);
    assert.equal(agent.isAgentBusy(binding.scope), true);
}
function finish(expectedRows = 1, answer = 'Exact redirected final'): void {
    const host = state.currentAgentDiv!;
    projection.text('message', 'after', 'After redirect', 'replace', 'commentary');
    assert.ok([...activity.findLiveActivity(runId)!.model.entries.values()]
        .some(entry => entry.kind === 'message' && entry.text === 'After redirect'));
    projection.close({ kind: 'turn-end', status: 'done', finalText: answer });
    const terminals = events.filter(event => event.event === 'agent_runtime' && event.data['runId'] === runId && event.data['kind'] === 'turn-end');
    assert.equal(terminals.length, 1); wire(terminals[0]!);
    assert.equal(document.querySelectorAll('.msg-agent').length, expectedRows);
    assert.equal(host.querySelector('.msg-content')?.getAttribute('data-raw'), answer);
    assert.equal(activity.findLiveActivity(runId)!.message, host);
    assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
}

test('C01/C02: real steerAgent receipt preserves the Web owner through continued Activity and one final', async () => {
    startActivity(); const before = capture();
    await redirect(); unchanged(before); finish();
});
for (const [row, name, patch] of [
    ['C03', 'foreign', { sessionId: 'foreign', scope: 'foreign' }],
    ['C04', 'replayed', { sseReplay: true }],
    ['C05', 'noncanonical metadata', { sessionId: 7, scope: null, requestId: {}, localDispatch: false }],
] as const) test(`${row}: cancel-reprompt ${name} receipt cannot mutate ownership or liveness`, async () => {
    startActivity(); holdReceipt = true; const receipt = await redirect();
    const before = capture(); dispatch({ ...receipt.data, ...patch, event: receipt.event });
    unchanged(before); finish();
});
test('C06: cancel-reprompt receipt preserves a pre-existing steer guard and the eventual final', async () => {
    startActivity(); holdReceipt = true; const receipt = await redirect(); ui.markSteered();
    const before = capture(); assert.equal(before.steer, true);
    wire(receipt); unchanged(before); finish();
});
for (const [row, ending] of [['C07', 'done'], ['C08', 'stopped']] as const) {
    test(`${row}: late A receipt cannot revive ${ending} A or retire same-session B`, async () => {
        startActivity(); holdReceipt = true;
        const receipt = await redirect(), aRunId = runId, aHost = state.currentAgentDiv!;
        const answerA = ending === 'done' ? 'Answer A' : 'Partial A';
        projection.close({ kind: 'turn-end', status: ending, finalText: answerA });
        trace.finalizeTraceRun(aRunId, ending === 'stopped' ? 'interrupted' : 'done');
        agent.activeMainProcesses.delete(binding.scope); liveRun.clearLiveRun(binding.scope);
        const aHtml = aHost.outerHTML, aModel = structuredClone(activity.findLiveActivity(aRunId)!.model);
        const stoppedGuard = ui.isRecentSteer();
        assert.equal(aHost.querySelector('.msg-content')?.getAttribute('data-raw'), answerA);
        assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
        wire(receipt);
        assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
        assert.equal(ui.isRecentSteer(), stoppedGuard); assert.equal(aHost.outerHTML, aHtml);
        assert.deepEqual(activity.findLiveActivity(aRunId)!.model, aModel);
        assert.equal(document.querySelectorAll('.msg-agent').length, 1);

        // Same exact binding: metadata alone cannot identify this stale receipt.
        runId = trace.startTraceRun({ cli: 'cursor', sessionId: binding.sessionId, scopeKey: binding.scope });
        assert.notEqual(runId, aRunId);
        owner = { ...owner, meta: { ...owner.meta } };
        agent.activeMainProcesses.set(binding.scope, owner);
        liveRun.beginLiveRun(binding.scope, 'cursor'); liveRun.setLiveRunTraceId(binding.scope, runId);
        bus.publish('agent', 'agent_status', { running: true, ...binding });
        projection = new Projection({ ...binding, runId, turnId: runId, audience: 'public' });
        startActivity();
        const before = capture(); assert.notEqual(before.host, aHost); assert.equal(before.busy, true);
        wire(receipt); unchanged(before);
        assert.equal(aHost.outerHTML, aHtml); assert.deepEqual(activity.findLiveActivity(aRunId)!.model, aModel);
        finish(2, 'Exact B final');
        assert.equal(aHost.outerHTML, aHtml);
        assert.deepEqual(activity.findLiveActivity(aRunId)!.model, aModel);
        assert.equal(events.filter(event => event.event === 'agent_runtime' && event.data['kind'] === 'turn-end').length, 2);
    });
}
test('C09 legacy: missing mode retires a no-Activity stream and rejects old packets beyond the time guard', t => {
    assert.equal(activity.findLiveActivity(runId), undefined);
    dispatch({ event: 'agent_output', traceRunId: runId, text: 'Legacy provisional', textLen: 18 });
    const host = state.currentAgentDiv!; assert.ok(host?.isConnected);
    dispatch({ event: 'steer_started' });
    assert.equal(ui.isRecentSteer(), true); assert.equal(state.currentAgentDiv, null);
    assert.equal(state.agentBusy, true, 'legacy replacement is still steering');
    const count = document.querySelectorAll('.msg-agent').length, html = host.outerHTML;
    const later = Date.now() + 10_000; t.mock.method(Date, 'now', () => later);
    assert.equal(ui.isRecentSteer(), false);
    for (const sseReplay of [false, true]) {
        dispatch({ event: 'agent_output', traceRunId: runId, text: 'OLD REPLAY', textLen: 100, sseReplay });
        dispatch({ event: 'agent_done', traceRunId: runId, text: 'OLD FINAL', sseReplay });
        assert.equal(document.querySelectorAll('.msg-agent').length, count);
        assert.equal(host.outerHTML, html); assert.equal(state.currentAgentDiv, null);
        assert.equal(state.agentBusy, true);
    }
});
test('C09 Activity: missing-mode receipt preserves an admitted Activity owner and its later final', () => {
    startActivity(); const before = capture();
    dispatch({ event: 'steer_started' }); unchanged(before); finish();
});
