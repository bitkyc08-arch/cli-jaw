import '../setup/isolated-home.ts';
import { rmSync } from 'node:fs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.ts';

// wp37 N01-N10: synthetic canonical/compatibility wires exercise the real Web host.
// This does not claim a live provider setup failure. Only transport and browser
// geometry/frame clock are substituted; real VS callbacks and Activity stay real.
const fixtureHome = process.env.CLI_JAW_HOME!;
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
// Trace drawer rendering/imported SVG assets are outside the terminal host oracle.
mock.module('../../public/js/features/trace-drawer.js', { namedExports: { closeTraceDrawer() {}, openTraceDrawer() {} } });
let ui: typeof import('../../public/js/ui.ts');
let ws: typeof import('../../public/js/ws.ts');
let activity: typeof import('../../public/js/features/activity-live.ts');
let virtual: typeof import('../../public/js/virtual-scroll.ts');
let rendering: typeof import('../../public/js/render.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let history: typeof import('../../public/js/features/activity-history.ts');
let chat: HTMLElement;
type Ledger = { events: RuntimeEvent[]; status: 'running' | 'done' | 'error' | 'interrupted'; loss: string | null;
    answer: string | null; transcriptAnswer?: string; messageId: number; afterSeedPage?: RuntimeEvent };
const ledger = new Map<string, Ledger>();

type HttpRequest = { method: string; url: string; path: string; query: string };
type HttpAudit = { requests: HttpRequest[]; unexpected: HttpRequest[] };
const httpAudit: HttpAudit = { requests: [], unexpected: [] };
const unexpectedHttp = httpAudit.unexpected;

// Fixture contract, deliberately stricter than server compatibility defaults:
// these consumers must send explicit cursors and a 3000-row withSession window.
function inspectHttp(input: string | URL | Request, init: RequestInit | undefined, audit: HttpAudit) {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const request = { method, url: url.href, path: url.pathname, query: url.search };
    audit.requests.push(request);
    const q = url.searchParams, keys = [...q.keys()];
    const query = (required: string[], optional: string[] = []) =>
        new Set(keys).size === keys.length && required.every(key => q.has(key))
        && keys.every(key => required.includes(key) || optional.includes(key));
    const ownSession = () => q.get('session') === identity.sessionId;
    const optionalSession = () => !q.has('session') || ownSession();
    const decimal = (key: string) => /^\d+$/.test(q.get(key) ?? '') && Number.isSafeInteger(Number(q.get(key)));
    const runId = /^tr_[A-Za-z0-9_-]{16,80}$/;
    const journal = url.pathname.match(/^\/api\/traces\/(tr_[A-Za-z0-9_-]{16,80})\/activity$/);
    const saved = url.pathname.match(/^\/api\/messages\/by-trace\/(tr_[A-Za-z0-9_-]{16,80})$/);
    let valid = false;
    switch (url.pathname) {
        case '/api/auth/token': case '/api/settings': case '/api/goal':
        case '/api/memory-files': case '/api/memory/status': case '/api/stats':
            valid = query([]); break;
        case '/api/bgtask':
            valid = query(['status']) && q.get('status') === 'running'; break;
        case '/api/orchestrate/snapshot': case '/api/messages/count':
            valid = query([], ['session']) && optionalSession(); break;
        case '/api/messages':
            valid = query(['limit', 'withSession'], ['session']) && q.get('limit') === '3000'
                && q.get('withSession') === '1' && optionalSession(); break;
        case '/api/runtime/requests':
            valid = query(['sessionId']) && q.get('sessionId') === identity.sessionId; break;
        case '/api/traces/activity-runs':
            valid = query(['session', 'after']) && ownSession()
                && (q.get('after') === '' || runId.test(q.get('after')!)); break;
        default:
            if (journal) valid = query(['session', 'after', 'limit'], ['through']) && ownSession()
                && decimal('after') && decimal('limit') && Number(q.get('limit')) >= 1 && Number(q.get('limit')) <= 40
                && (!q.has('through') || decimal('through') && Number(q.get('through')) >= Number(q.get('after')));
            else if (saved) valid = query(['session']) && ownSession();
    }
    if (audit.requests.length > 256 || url.origin !== window.location.origin || method !== 'GET' || !valid) {
        audit.unexpected.push(request); // Independent of any caller that catches the rejection.
        throw new Error('Unexpected fixture HTTP: ' + method + ' ' + url.href);
    }
    return { url, request, journal, saved };
}

let historyReads = 0, answerReads = 0;
let selectedScope = 'local:fixture-native-terminal';
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0, serial = 0;
const identity = { sessionId: 'fixture-native-terminal', scope: 'local:fixture-native-terminal' };


async function fixtureFetch(input: string | URL | Request, init?: RequestInit, audit: HttpAudit = httpAudit): Promise<Response> {
    const { url, request, journal, saved } = inspectHttp(input, init, audit);
    const path = url.pathname, q = url.searchParams;
    try {

        if (path === '/api/memory-files') return Response.json({ enabled: false, flushEvery: 10, retentionDays: 30, path: '/fixture/memory', counter: 0, files: [] });
        if (path === '/api/memory/status') return Response.json({ enabled: false, provider: 'local', state: 'disabled', initialized: false, storageRoot: '/fixture/memory' });
        if (path === '/api/bgtask') return Response.json({ tasks: [] });
        if (path === '/api/goal') return Response.json({ ok: true, goal: null,
            pauseGate: { armed: false, attempts: 0, requiredAttempts: 2, reason: null, nextAction: null } });
        if (path === '/api/auth/token') return Response.json({ token: 'fixture' });
        if (path === '/api/settings') return Response.json({ workingDir: '/fixture/work', presentation: { mode: 'activity' } });
        if (path === '/api/runtime/requests') return Response.json({ ok: true, data: { requests: [] } });
        if (path === '/api/messages/count') return Response.json({ ok: true, data: { count: 0 } });
        if (path === '/api/stats') return Response.json({ count: 0 });

        if (journal) {
            historyReads++;
            const runId = journal[1]!, row = ledger.get(runId);
            if (!row) throw new Error('Unknown journal');
            const after = Number(q.get('after')), limit = Number(q.get('limit'));
            const through = q.has('through') ? Number(q.get('through')) : row.events.at(-1)?.seq ?? 0;
            if (after > through || through > (row.events.at(-1)?.seq ?? 0)) throw new Error('Invalid journal cursor');
            const remaining = row.events.filter(event => event.seq > after && event.seq <= through);
            const events = remaining.slice(0, limit), hasMore = events.length < remaining.length;
            const data = { runId, ...identity, status: row.status, events,
                nextAfter: hasMore ? events.at(-1)!.seq : through, through, hasMore,
                incomplete: row.loss !== null || (row.status !== 'running' && !row.events.some(event => event.kind === 'turn-end')),
                loss: row.loss };
            // Simulate a durable append AFTER the seed high-water was captured.
            if (after === 0 && !q.has('through') && row.afterSeedPage) {
                row.events.push(row.afterSeedPage); delete row.afterSeedPage;
            }
            return Response.json({ ok: true, data });
        }
        if (saved) {
            answerReads++;
            const runId = saved[1]!, row = ledger.get(runId);
            if (!row) throw new Error('Unknown saved MESSAGE');
            return Response.json({ ok: true, data: { message: row.answer === null ? null : {
                id: row.messageId, role: 'assistant', content: row.answer, trace_run_id: runId, session_id: identity.sessionId,
            } } });
        }
        if (path === '/api/messages') return Response.json({ ok: true, data: { sessionId: identity.sessionId, messages: [
            { id: 1, role: 'user', content: 'Start native fixture', session_id: identity.sessionId },
            ...[...ledger].map(([runId, row]) => ({ id: row.messageId, role: 'assistant',
                content: row.transcriptAnswer ?? row.answer ?? '', trace_run_id: runId, session_id: identity.sessionId })),
        ] } });
        if (path === '/api/orchestrate/snapshot') return Response.json({
            activityIdentity: { ...identity, scope: selectedScope }, orc: { state: 'IDLE', scope: selectedScope, ctx: null },
            heartbeat: { pending: 0, deferredPending: 0 }, workers: [], queued: [],
            runtime: { queuePending: 0, busy: false }, activeRun: null,
        });
        if (path === '/api/traces/activity-runs') return Response.json({ ok: true, data: {
            runs: [...ledger].filter(([id]) => id > q.get('after')!).sort(([a], [b]) => a.localeCompare(b)).slice(0, 40)
                .map(([id, row]) => ({ id, messageId: row.messageId, status: row.status, startedAt: 1 })), pageSize: 40,
        } });
        throw new Error('Unserved fixture route');
    } catch (error) {
        audit.unexpected.push(request); // Includes unexpected DB/page/serialization failures.
        throw error;
    }
}

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
    mock.method(globalThis, 'fetch', fixtureFetch);
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
    ({ state } = await import('../../public/js/state.ts')); ws.connect(); opened();
    await ui.loadMessages();
    await ws.syncOrchestrateSnapshot('channel-ready', { hydrateRun: true });
});
test.beforeEach(async () => {
    assert.deepEqual(unexpectedHttp, [], 'connection bootstrap HTTP must also be accounted for');
    rendering.cancelPostRender(); virtual.getVirtualScroll().clear();
    ui.cleanupToolActivity(); ui.clearSteer(); activity.clearLiveActivity(); frames.clear();
    history.disposeActivityHistory();
    ledger.clear(); unexpectedHttp.length = 0; httpAudit.requests.length = 0; historyReads = 0; answerReads = 0; selectedScope = identity.scope;
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
    activity.clearLiveActivity(); history.disposeActivityHistory(); frames.clear();
    assert.deepEqual(unexpectedHttp, [], 'no invalid/fallback HTTP schemas may hide a renderer failure');
});
test.after(() => { history.disposeActivityHistory(); rendering.cancelPostRender(); resetWebUiDom(); mock.restoreAll(); rmSync(fixtureHome, { recursive: true }); });

function start() {
    const runId = `tr_${String(++serial).padStart(16, '0')}`;
    const row: Ledger = { events: [], status: 'running', loss: null, answer: null, messageId: 100 + serial }; ledger.set(runId, row);
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
    ledger.get(runId)!.answer = status === 'done' ? text : '';
    dispatch({ event: 'agent_done', traceRunId: runId, ...identity, runtimeStatus: status,
        runtimeFinality: status === 'done' ? 'present' : 'absent', text, ...(status === 'error' ? { error: true } : {}) });
}

test('fresh first-user VS bootstrap mounts setup-error terminal without incidental resize/scroll', () => {
    const f = start(), diagnostic = 'Cursor native setup failed: fixture session/new error';
    compatibility(f.runId, 'error', diagnostic);
    f.runtime(3, { kind: 'turn-end', status: 'error', finalText: null, error: diagnostic });
    drainFrames(); rendering.cancelPostRender();
    assert.equal(activity.findLiveActivity(f.runId)?.model.end?.status, 'error', 'canonical event was admitted and reduced');
    // Native absent compatibility intentionally emits a separate system notice.
    assert.equal(virtual.getVirtualScroll().count, 3, 'one user, one assistant, one independent diagnostic');
    assert.equal(chat.querySelectorAll('.msg-system').length, 1);
    assert.match(chat.querySelector('.msg-system')!.textContent!, /fixture session\/new error/);
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
        const expectedRaw = status === 'done' ? text : ''; // Native absent is never diagnostic-as-answer in either order.
        const row = visible(f)!; assert.ok(row); assert.equal(activity.findLiveActivity(f.runId)?.message, row);
        assert.equal(row.querySelector<HTMLElement>('.activity-turn')?.dataset['status'], status);
        assert.equal(row.querySelector<HTMLElement>('.activity-degraded')?.hidden, true);
        assert.equal(row.querySelector('.msg-content')?.getAttribute('data-raw'), expectedRaw);
        compatibility(f.runId, status, text); f.runtime(4, end);
        assert.equal(virtual.getVirtualScroll().count, status === 'error' && !canonicalFirst ? 3 : 2);
        assert.equal(chat.querySelectorAll('.msg-system').length, status === 'error' && !canonicalFirst ? 1 : 0);
        assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
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
    // Reload the exact saved transcript after the live execution scope changes.
    // The journal retains its original scope; no fixture rewrites stored events.
    row.transcriptAnswer = 'STALE TRANSCRIPT BEFORE EXACT LOOKUP';
    row.answer = 'Exact saved MESSAGE after journal failure';
    // 41 seed events require a second page pinned to high-water 42. A later
    // durable event at 60 exists only after page one, so a wrong suffix loses it.
    for (let i = 0; i < 40; i++) row.events.push({ version: 1, ...identity, runId: f.runId, turnId: f.runId,
        seq: 3 + i, kind: 'tool', itemId: `seed-${i}`, name: `Seed ${i}`, status: 'done' });
    row.afterSeedPage = { version: 1, ...identity, runId: f.runId, turnId: f.runId,
        seq: 60, kind: 'tool', itemId: 'tail-only', name: 'Only after seed high-water', status: 'done' };
    selectedScope = 'local:new-routing-scope';
    await ws.syncOrchestrateSnapshot('historical-scope', { hydrateRun: true });
    await ui.loadMessages(); drainFrames(); rendering.cancelPostRender();
    assert.equal(state.activityIdentity?.scope, selectedScope);
    assert.equal(visible(f)!.querySelector('.msg-content')?.getAttribute('data-raw'), 'STALE TRANSCRIPT BEFORE EXACT LOOKUP');
    const requestStart = httpAudit.requests.length;
    await history.discoverActivityHistory();
    assert.equal(chat.querySelectorAll('.activity-recorded-run').length, 0, 'discovery must not copy a run already in this transcript');
    assert.equal(document.getElementById('activityDiscovery')?.hidden, true);
    const readsBefore = historyReads, answersBefore = answerReads;
    await history.hydrateActivityHost(visible(f)!, f.runId, true);
    assert.equal(answerReads, answersBefore + 1, 'exact saved MESSAGE is read independently of the journal');
    assert.equal(activity.findLiveActivity(f.runId)?.model.identity.scope, identity.scope);
    assert.equal(state.activityIdentity?.scope, selectedScope, 'history cannot rewrite live admission');
    assert.equal(historyReads, readsBefore + 3, 'two fixed-through seed pages and one suffix');
    assert.deepEqual(httpAudit.requests.slice(requestStart).map(({ method, path, query }) => [method, path, query]), [
        ['GET', '/api/traces/activity-runs', '?session=fixture-native-terminal&after='],
        ['GET', `/api/traces/${f.runId}/activity`, '?session=fixture-native-terminal&after=0&limit=40'],
        ['GET', `/api/traces/${f.runId}/activity`, '?session=fixture-native-terminal&after=41&limit=40&through=42'],
        ['GET', `/api/traces/${f.runId}/activity`, '?session=fixture-native-terminal&after=42&limit=40'],
        ['GET', `/api/messages/by-trace/${f.runId}`, '?session=fixture-native-terminal'],
    ], 'original session, exact discovery/seed/pinned page/suffix/MESSAGE sequence');
    assert.equal(activity.findLiveActivity(f.runId)?.model.seq, 60);
    assert.equal(activity.findLiveActivity(f.runId)?.model.entries.size, 41);
    assert.equal(activity.findLiveActivity(f.runId)?.model.entries.get('seed-39')?.kind, 'tool');
    assert.equal(activity.findLiveActivity(f.runId)?.model.entries.get('tail-only')?.kind, 'tool');
    assert.equal(activity.findLiveActivity(f.runId)?.model.end, null);
    assert.equal(visible(f)!.querySelector('.msg-content')?.getAttribute('data-raw'), 'Exact saved MESSAGE after journal failure');
    assert.equal(visible(f)!.querySelector<HTMLElement>('.activity-degraded')?.hidden, false);
    const restored = recycle(f);
    assert.equal(restored.querySelector<HTMLElement>('.activity-degraded')?.hidden, false);
    assert.equal(restored.querySelector('.msg-content')?.getAttribute('data-raw'), 'Exact saved MESSAGE after journal failure');
    assert.equal(activity.findLiveActivity(f.runId)?.model.identity.scope, identity.scope);
    assert.equal(activity.findLiveActivity(f.runId)?.model.seq, 60);
    assert.equal(activity.findLiveActivity(f.runId)?.model.entries.get('tail-only')?.kind, 'tool');
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


// R1/R3 negatives use a separate audit; actual-flow failures are never cleared
// or whitelisted. The exact same fetch fixture handles both lanes.
test('HTTP fixture preserves current wire envelopes and Request init method precedence', { timeout: 5000 }, async () => {
    const audit: HttpAudit = { requests: [], unexpected: [] };
    const messageWire = await (await fixtureFetch('/api/messages?limit=3000&withSession=1&session=' + identity.sessionId, undefined, audit)).json();
    assert.equal(messageWire.ok, true);
    assert.equal(messageWire.data.sessionId, identity.sessionId);
    assert.ok(Array.isArray(messageWire.data.messages));
    assert.equal(Object.hasOwn(messageWire, 'sessionId'), false, 'not the bare compatibility wire');
    const input = new Request(window.location.origin + '/api/messages/count', { method: 'POST' });
    assert.deepEqual(await (await fixtureFetch(input, { method: 'GET' }, audit)).json(), { ok: true, data: { count: 0 } });
    const snapshot = await (await fixtureFetch('/api/orchestrate/snapshot', undefined, audit)).json();
    assert.equal(snapshot.activityIdentity.sessionId, identity.sessionId);
    assert.equal(Object.hasOwn(snapshot, 'data'), false, 'snapshot remains raw');
    assert.equal(audit.requests[1]!.method, 'GET', 'init takes precedence over Request.method');
    assert.deepEqual(audit.unexpected, []);
    assert.deepEqual(unexpectedHttp, []);
});

test('HTTP fixture records wrong init and Request methods even when rejection is caught', { timeout: 5000 }, async () => {
    const audit: HttpAudit = { requests: [], unexpected: [] };
    const path = '/api/messages/count', url = window.location.origin + path;
    for (const [input, init, method] of [
        [path, { method: 'POST' }, 'POST'],
        [new Request(url, { method: 'DELETE' }), undefined, 'DELETE'],
        [new Request(url), { method: 'PUT' }, 'PUT'],
    ] as const) {
        const caught = await fixtureFetch(input, init, audit).catch(error => {
            assert.match(String(error), /Unexpected fixture HTTP/); return null;
        });
        assert.equal(caught, null);
        assert.deepEqual(audit.unexpected.at(-1), { method, url, path, query: '' });
    }
    assert.equal(audit.unexpected.length, 3);
    assert.deepEqual(audit.requests, audit.unexpected);
    assert.deepEqual(unexpectedHttp, [], 'expected negatives never pollute the actual-flow ledger');
});

test('HTTP fixture rejects malformed known queries and partial paths before caught failure', { timeout: 5000 }, async () => {
    const runId = start().runId;
    const audit: HttpAudit = { requests: [], unexpected: [] };
    const session = identity.sessionId, activityPath = '/api/traces/' + runId + '/activity';
    const savedPath = '/api/messages/by-trace/' + runId;
    const invalid = [
        '/api/auth/token/extra', '/prefix/api/auth/token', '/api/settings?extra=1',
        '/api/orchestrate/snapshot?session=foreign', '/api/orchestrate/snapshot?scope=foreign',
        '/api/messages?withSession=1', '/api/messages?limit=3000&withSession=1&extra=1',
        '/api/messages?limit=3000&withSession=1&withSession=1',
        '/api/messages?limit=3000&withSession=1&session=foreign',
        '/api/messages/count?session=foreign', '/api/messages/count?session=' + session + '&session=' + session,
        '/api/messages/count?extra=1', '/api/runtime/requests?sessionId=foreign',
        '/api/runtime/requests?sessionId=' + session + '&sessionId=' + session,
        '/api/traces/activity-runs?after=', '/api/traces/activity-runs?session=foreign&after=',
        '/api/traces/activity-runs?session=' + session + '&after=&extra=1',
        '/api/traces/activity-runs?session=' + session + '&session=' + session + '&after=',
        '/api/traces/activity-runs?session=' + session + '&after=not-a-trace',
        activityPath + '?session=' + session + '&limit=40', activityPath + '?session=' + session + '&after=0',
        activityPath + '?session=foreign&after=0&limit=40',
        activityPath + '?session=' + session + '&after=0&limit=40&extra=1',
        activityPath + '?session=' + session + '&after=0&after=0&limit=40',
        activityPath + '?session=' + session + '&after=-1&limit=40',
        activityPath + '?session=' + session + '&after=0&limit=41',
        activityPath + '?session=' + session + '&after=2&limit=40&through=1',
        '/not-api/traces/' + runId + '/activity?session=' + session + '&after=0&limit=40',
        savedPath + '?session=foreign', savedPath + '?session=' + session + '&session=' + session,
        savedPath + '?session=' + session + '&extra=1',
    ];
    // A valid owned journal exists, so missing fixture data cannot mask a query bug.
    assert.equal((await fixtureFetch(activityPath + '?session=' + session + '&after=0&limit=40', undefined, audit)).ok, true);
    const offset = audit.requests.length;
    for (const pathAndQuery of invalid) {
        const caught = await fixtureFetch(pathAndQuery, undefined, audit).catch(error => {
            assert.match(String(error), /Unexpected fixture HTTP/); return null;
        });
        assert.equal(caught, null, pathAndQuery);
        const split = pathAndQuery.indexOf('?');
        assert.deepEqual(audit.unexpected.at(-1), {
            method: 'GET', url: window.location.origin + pathAndQuery,
            path: split < 0 ? pathAndQuery : pathAndQuery.slice(0, split),
            query: split < 0 ? '' : pathAndQuery.slice(split),
        });
    }
    assert.equal(audit.unexpected.length, invalid.length);
    assert.deepEqual(audit.requests.slice(offset), audit.unexpected);
    assert.deepEqual(unexpectedHttp, []);
});
