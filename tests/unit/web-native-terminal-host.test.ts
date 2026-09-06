import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.ts';

// Backend contract proven by scoped-sse-43001-aa0740ed.json: canonical start,
// run-tagged compatibility (native absent), then canonical error/null terminal.
// Only the transport subscription and browser geometry/frame clock are substituted.
// VirtualScroll, TanStack, first-user bootstrap, ws dispatch and Activity stay real.
let dispatch: (data: Record<string, unknown>) => void;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) {
        if (topic === '*') dispatch = callback;
        return () => {};
    },
    onChannelOpen() {}, onChannelDisconnect() {}, onChannelUnavailable() {},
} });
let ui: typeof import('../../public/js/ui.ts');
let ws: typeof import('../../public/js/ws.ts');
let activity: typeof import('../../public/js/features/activity-live.ts');
let virtual: typeof import('../../public/js/virtual-scroll.ts');
let rendering: typeof import('../../public/js/render.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let history: typeof import('../../public/js/features/activity-history.ts');
let chat: HTMLElement;
type Ledger = { events: RuntimeEvent[]; status: 'running' | 'done' | 'error' | 'interrupted'; loss: string | null };
const ledger = new Map<string, Ledger>();
const unexpectedHttp: string[] = [];
let historyReads = 0;
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0, serial = 0;
const identity = { sessionId: 'fixture-native-terminal', scope: 'local:fixture-native-terminal' };

function drainFrames(): void {
    for (let i = 0; i < 12 && frames.size; i++) {
        const pending = [...frames.values()]; frames.clear();
        for (const callback of pending) callback(i * 16);
    }
    assert.equal(frames.size, 0, 'fixture animation frames must settle before terminal delivery');
}
test.before(async () => {
    setupWebUiDom(); chat = document.getElementById('chatMessages')!;
    const raf = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; };
    const cancel = (id: number) => { frames.delete(id); };
    mock.method(globalThis, 'requestAnimationFrame', raf); mock.method(window, 'requestAnimationFrame', raf);
    mock.method(globalThis, 'cancelAnimationFrame', cancel); mock.method(window, 'cancelAnimationFrame', cancel);
    for (const [key, value] of Object.entries({ offsetWidth: 800, offsetHeight: 600, clientWidth: 800, clientHeight: 600 })) {
        Object.defineProperty(chat, key, { configurable: true, get: () => value });
    }
    // JSDOM has no layout: supply row measurement and the adapter's real total
    // height so TanStack can clamp scroll offsets and actually recycle rows.
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { configurable: true,
        get() { return this.classList.contains('msg') ? 80 : 0; } });
    Object.defineProperty(chat, 'scrollHeight', { configurable: true,
        get: () => Math.max(600, parseFloat(chat.querySelector<HTMLElement>('.vs-inner')?.style.height ?? '0') || 0) });
    chat.scrollTo = ((options: ScrollToOptions) => {
        chat.scrollTop = options.top ?? 0; chat.dispatchEvent(new window.Event('scroll'));
    }) as typeof chat.scrollTo;
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input), 'http://fixture.local'), path = url.pathname;
        if (path.includes('/api/auth/token')) return Response.json({ token: 'fixture' });
        const activityPath = path.match(/^\/api\/traces\/(tr_[A-Za-z0-9_-]{16,80})\/activity$/);
        if (activityPath) {
            historyReads++;
            const runId = activityPath[1]!, row = ledger.get(runId);
            if (!row || url.searchParams.get('session') !== identity.sessionId) {
                unexpectedHttp.push(path); return Response.json({ ok: false, error: 'trace_not_found' }, { status: 404 });
            }
            const after = Number(url.searchParams.get('after') ?? 0);
            const through = Number(url.searchParams.get('through') ?? row.events.at(-1)?.seq ?? 0);
            const limit = Number(url.searchParams.get('limit') ?? 40);
            const remaining = row.events.filter(event => event.seq > after && event.seq <= through);
            const events = remaining.slice(0, limit), hasMore = events.length < remaining.length;
            return Response.json({ ok: true, data: { runId, ...identity, status: row.status, events,
                nextAfter: hasMore ? events.at(-1)!.seq : through, through, hasMore,
                incomplete: row.loss !== null || (row.status !== 'running' && !row.events.some(event => event.kind === 'turn-end')),
                loss: row.loss } });
        }
        const allowed = ['/api/orchestrate/snapshot', '/api/runtime/requests', '/api/traces/activity-runs', '/api/messages/count', '/api/goal', '/api/settings'];
        if (!allowed.includes(path)) { unexpectedHttp.push(path); throw new Error(`Unexpected fixture HTTP: ${path}`); }
        const data = path.includes('/orchestrate/snapshot') ? {
            activityIdentity: identity, orc: { state: 'IDLE', scope: identity.scope, ctx: null },
            heartbeat: { pending: 0, deferredPending: 0 }, workers: [], queued: [],
            runtime: { queuePending: 0, busy: false }, activeRun: null,
        } : path.includes('/runtime/requests') ? { requests: [] }
            : path.includes('/activity-runs') ? { runs: [...ledger].filter(([id]) => id > (url.searchParams.get('after') ?? '')).slice(0, 40)
                .map(([id, row], index) => ({ id, messageId: index + 1, status: row.status, startedAt: 1 })), pageSize: 40 }
                : path === '/api/settings' ? { workingDir: '/fixture/work', presentation: { mode: 'activity' } } : { count: 0 };
        return Response.json({ ok: true, data });
    });
    const warn = console.warn.bind(console);
    mock.method(console, 'warn', (...args: unknown[]) => {
        if (String(args[0]).startsWith('[idb-cache]')) return; // Intentionally absent in the shared DOM harness.
        warn(...args);
    });
    ui = await import('../../public/js/ui.ts'); ws = await import('../../public/js/ws.ts');
    activity = await import('../../public/js/features/activity-live.ts');
    history = await import('../../public/js/features/activity-history.ts');
    virtual = await import('../../public/js/virtual-scroll.ts');
    rendering = await import('../../public/js/render.ts');
    ({ state } = await import('../../public/js/state.ts')); ws.connect();
});
test.beforeEach(async () => {
    rendering.cancelPostRender(); virtual.getVirtualScroll().clear();
    ui.cleanupToolActivity(); ui.clearSteer(); activity.clearLiveActivity(); frames.clear();
    ledger.clear(); unexpectedHttp.length = 0; historyReads = 0;
    chat.replaceChildren(); document.documentElement.dataset['presentationMode'] = 'activity';
    await ws.syncOrchestrateSnapshot('terminal-host-fixture', { hydrateRun: true });
    assert.deepEqual(state.activityIdentity, identity);
    // Actual send's successful HTTP branch calls addMessage('user', text).
    // Do not install history callbacks manually: first-user bootstrap is the seam.
    ui.addMessage('user', 'Start native fixture'); drainFrames(); rendering.cancelPostRender();
    assert.equal(virtual.getVirtualScroll().active, true);
    assert.equal(chat.querySelectorAll('.msg-user').length, 1);
});
test.afterEach(() => {
    rendering.cancelPostRender(); virtual.getVirtualScroll().clear(); ui.cleanupToolActivity();
    activity.clearLiveActivity(); frames.clear();
    assert.deepEqual(unexpectedHttp, [], 'no invalid/fallback HTTP schemas may hide a renderer failure');
});
test.after(() => { resetWebUiDom(); mock.restoreAll(); });

function start() {
    const runId = `tr_${String(++serial).padStart(16, '0')}`;
    const row: Ledger = { events: [], status: 'running', loss: null }; ledger.set(runId, row);
    const runtime = (seq: number, body: RuntimeEventBody) => {
        const event: RuntimeEvent = { version: 1, runId, turnId: runId, ...identity, seq, ...body };
        if (!row.events.some(prior => prior.seq === seq)) row.events.push(event);
        if (body.kind === 'turn-end') row.status = body.status === 'stopped' ? 'interrupted' : body.status;
        dispatch({ ...event, event: 'agent_runtime' });
    };
    dispatch({ event: 'agent_status', running: true });
    runtime(2, { kind: 'turn-start', provider: 'cursor' });
    drainFrames(); rendering.cancelPostRender();
    const original = state.currentAgentDiv!;
    assert.ok(original.isConnected); assert.ok(original.querySelector('.activity-turn'));
    return { runId, runtime, original };
}
function compatibility(runId: string, status: 'done' | 'error' | 'stopped', text: string): void {
    dispatch({ event: 'agent_done', traceRunId: runId, ...identity, runtimeStatus: status,
        runtimeFinality: status === 'done' ? 'present' : 'absent', text, ...(status === 'error' ? { error: true } : {}) });
}

test('fresh first-user VS bootstrap mounts setup-error terminal without incidental resize/scroll', () => {
    const f = start(), diagnostic = 'Cursor native setup failed: fixture session/new error';
    compatibility(f.runId, 'error', diagnostic);
    f.runtime(3, { kind: 'turn-end', status: 'error', finalText: null, error: diagnostic });
    drainFrames(); rendering.cancelPostRender();
    assert.equal(activity.findLiveActivity(f.runId)?.model.end?.status, 'error', 'canonical event was admitted and reduced');
    assert.equal(virtual.getVirtualScroll().count, 2, 'terminal row reached virtual storage');
    assert.equal(chat.querySelectorAll('.msg-agent').length, 1, 'stored final must also be mounted without unrelated layout activity');
    const visible = chat.querySelector<HTMLElement>('.msg-agent')!;
    assert.equal(activity.findLiveActivity(f.runId)?.message, visible, 'Activity owner must bind the visible virtual clone');
    const error = visible.querySelector<HTMLElement>('.activity-error')!;
    assert.equal(error.hidden, false); assert.equal(error.textContent, diagnostic);
    assert.equal(visible.querySelector<HTMLElement>('.activity-degraded')?.hidden, true);
    assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
});

test('normal canonical terminal updates the visible compatibility clone and clears its transient incomplete banner', () => {
    const f = start(); compatibility(f.runId, 'done', 'Exact final answer');
    // Isolate clone ownership from missing append invalidation through the actual
    // resize listener; do not call VirtualScroll's private layout implementation.
    window.dispatchEvent(new window.Event('resize')); drainFrames();
    const visible = chat.querySelector<HTMLElement>('.msg-agent')!;
    assert.ok(visible); assert.notEqual(visible, f.original);
    assert.equal(visible.querySelector<HTMLElement>('.activity-degraded')?.hidden, false, 'compatibility is awaiting canonical terminal');
    f.runtime(3, { kind: 'turn-end', status: 'done', finalText: 'Exact final answer' });
    drainFrames(); rendering.cancelPostRender();
    assert.equal(activity.findLiveActivity(f.runId)?.model.end?.status, 'done');
    assert.equal(chat.querySelectorAll('.msg-agent').length, 1);
    assert.equal(visible.querySelector('.msg-content')?.getAttribute('data-raw'), 'Exact final answer');
    assert.equal(visible.querySelector<HTMLElement>('.activity-degraded')?.hidden, true, 'canonical completion must update the visible clone, not a detached host');
    assert.equal(activity.findLiveActivity(f.runId)?.message, visible);
    assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
});

type Run = ReturnType<typeof start>;
function visible(f: Run): HTMLElement | null { return chat.querySelector(`.msg-agent[data-trace-run-id="${f.runId}"]`); }
function complete(f: Run, status: 'done' | 'error' | 'stopped', canonicalFirst: boolean) {
    const text = status === 'done' ? 'Owned final' : status === 'error' ? 'Owned setup error' : '';
    const end = { kind: 'turn-end', status, finalText: status === 'done' ? text : null,
        ...(status === 'error' ? { error: text } : {}) } as const;
    if (canonicalFirst) { f.runtime(4, end); compatibility(f.runId, status, text); }
    else { compatibility(f.runId, status, text); f.runtime(4, end); }
    drainFrames(); rendering.cancelPostRender(); return { text, end };
}
function recycle(f: Run) {
    const original = visible(f)!; assert.ok(original);
    const index = Number(original.dataset['vsIdx']); assert.ok(Number.isInteger(index));
    for (let i = 0; i < 24; i++) ui.addMessage('user', `Viewport filler ${i}`);
    virtual.getVirtualScroll().scrollToIndex(virtual.getVirtualScroll().count - 1); drainFrames();
    assert.equal(visible(f), null, 'real virtualizer must unmount the target row');
    virtual.getVirtualScroll().scrollToIndex(index); drainFrames(); rendering.cancelPostRender();
    const restored = visible(f)!; assert.ok(restored); assert.notEqual(restored, original);
    assert.equal(activity.findLiveActivity(f.runId)?.message, restored); return restored;
}

for (const status of ['done', 'error', 'stopped'] as const) for (const canonicalFirst of [false, true]) {
    test(`fresh VS ${status}/${canonicalFirst ? 'canonical-first' : 'compatibility-first'} survives duplicate terminals and recycling`, () => {
        const f = start(); const { text, end } = complete(f, status, canonicalFirst);
        const expectedRaw = status === 'error' && canonicalFirst ? '' : text; // Null error belongs outside the collapsed disclosure.
        const row = visible(f)!; assert.ok(row); assert.equal(activity.findLiveActivity(f.runId)?.message, row);
        assert.equal(row.querySelector<HTMLElement>('.activity-turn')?.dataset['status'], status);
        assert.equal(row.querySelector<HTMLElement>('.activity-degraded')?.hidden, true);
        assert.equal(row.querySelector('.msg-content')?.getAttribute('data-raw'), expectedRaw);
        compatibility(f.runId, status, text); f.runtime(4, end);
        assert.equal(virtual.getVirtualScroll().count, 2); assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
        const restored = recycle(f);
        assert.equal(restored.querySelector<HTMLElement>('.activity-turn')?.dataset['status'], status);
        assert.equal(restored.querySelector<HTMLElement>('.activity-degraded')?.hidden, true);
        assert.equal(restored.querySelector('.msg-content')?.getAttribute('data-raw'), expectedRaw);
        if (status === 'error') {
            assert.equal(restored.querySelector('.activity-error')?.textContent, text);
            assert.equal(restored.querySelector<HTMLElement>('.activity-error')?.hidden, false);
        }
    });
}

test('real gap semantics stay visible through valid incomplete journal replay and recycling', async () => {
    const f = start(); const row = ledger.get(f.runId)!;
    row.loss = 'storage_error'; row.status = 'done'; // Recording stopped; no fabricated canonical terminal.
    dispatch({ event: 'agent_runtime_gap', ...identity, runId: f.runId, reason: 'projection_degraded' });
    compatibility(f.runId, 'done', 'Answer despite journal failure'); drainFrames();
    assert.equal(visible(f)!.querySelector<HTMLElement>('.activity-degraded')?.hidden, false);
    const readsBefore = historyReads;
    await history.hydrateActivityHost(visible(f)!, f.runId, true);
    assert.ok(historyReads >= readsBefore + 2, 'actual seed and suffix readers consumed valid fixture pages');
    assert.equal(activity.findLiveActivity(f.runId)?.model.end, null);
    assert.equal(visible(f)!.querySelector<HTMLElement>('.activity-degraded')?.hidden, false);
    const restored = recycle(f);
    assert.equal(restored.querySelector<HTMLElement>('.activity-degraded')?.hidden, false);
    assert.equal(restored.querySelector('.msg-content')?.getAttribute('data-raw'), 'Answer despite journal failure');
});

test('late A canonical end binds A virtual row while B host and busy ownership remain unchanged', () => {
    const a = start(); compatibility(a.runId, 'done', 'Answer A'); drainFrames();
    const aRow = visible(a)!; assert.ok(aRow); ui.addMessage('user', 'Start B'); drainFrames();
    const b = start(), bHost = state.currentAgentDiv!, before = bHost.outerHTML;
    a.runtime(4, { kind: 'turn-end', status: 'done', finalText: 'Answer A' });
    compatibility(a.runId, 'done', 'Answer A');
    assert.equal(state.currentAgentDiv, bHost); assert.equal(state.agentBusy, true); assert.equal(bHost.outerHTML, before);
    assert.equal(aRow.querySelector<HTMLElement>('.activity-degraded')?.hidden, true);
    complete(b, 'done', false); assert.equal(virtual.getVirtualScroll().count, 4);
    const restored = recycle(a); assert.equal(restored.querySelector('.msg-content')?.getAttribute('data-raw'), 'Answer A');
    assert.equal(restored.querySelector<HTMLElement>('.activity-degraded')?.hidden, true);
    assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
});
