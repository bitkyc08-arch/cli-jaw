import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { ExitHandlerParams } from '../../src/agent/lifecycle-handler.ts';
import type { BusEvent } from '../../src/core/event-bus.ts';
// wp37 P01-P23: actual accepted parser -> PrintActivity -> lifecycle -> Web.
// Fixed donor homes are not reused; this file owns only its isolated temp home.
// One file intentionally keeps all 23 cases with their shared DB/producer owner;
// splitting the fixture across files would weaken teardown and duplicate state.
const fixtureHome = process.env.CLI_JAW_HOME!;
let opened: () => void;
let dispatch: (event: Record<string, unknown>) => void;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) {
        if (topic === '*') dispatch = callback;
        return () => {};
    },
    onChannelOpen(callback: () => void) { opened = callback; }, onChannelDisconnect() {}, onChannelUnavailable() {},
} });
// Imported SVG/Trace drawer UI is outside this consumer settlement boundary.
mock.module('../../public/js/features/trace-drawer.js', { namedExports: { closeTraceDrawer() {}, openTraceDrawer() {} } });
let visibleRows: number[] = [];
let geometryChanged = () => {};
class Geometry {
    constructor(public options: Record<string, unknown>) { geometryChanged = options['onChange'] as () => void; }
    _didMount() { return () => {}; } _willUpdate() {} measureElement() {} measure() {}
    getVirtualItems() { return visibleRows.map(index => ({ index, start: index * 80, size: 80, end: (index + 1) * 80, key: index })); }
    getTotalSize() { return Number(this.options['count']) * 80; } setOptions(options: Record<string, unknown>) { this.options = options; }
    scrollToIndex() {} scrollToOffset() {}
}
mock.module('@tanstack/virtual-core', { namedExports: {
    Virtualizer: Geometry, elementScroll() {}, observeElementRect() {}, observeElementOffset() {},
} });
let virtual: typeof import('../../public/js/virtual-scroll.ts');
let ui: typeof import('../../public/js/ui.ts');
let live: typeof import('../../public/js/features/activity-live.ts');
let ws: typeof import('../../public/js/ws.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let lifecycle: typeof import('../../src/agent/lifecycle-handler.ts');
let bus: typeof import('../../src/core/event-bus.ts');
let trace: typeof import('../../src/trace/store.ts');
let db: typeof import('../../src/core/db.ts')['db'];
let createPrintActivity: typeof import('../../src/agent/runtime/print-activity.ts')['createPrintActivity'];
let extractFromEvent: typeof import('../../src/agent/events/index.ts')['extractFromEvent'];
let readActivityPage: typeof import('../../src/trace/activity-journal.ts')['readActivityPage'];
let history: typeof import('../../public/js/features/activity-history.ts');
let rendering: typeof import('../../public/js/render.ts');
let settings: typeof import('../../src/core/config.ts')['settings'];
let oldMemory: boolean, oldFallback: typeof settings.fallbackOrder;

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

let resetGoals: typeof import('../../src/goal/store.ts')['resetGoalStore'];
const identity = { sessionId: `print-web-${Date.now()}`, scope: 'print-web-scope' };
let serial = 0;
let fixtureNow = Date.now();
const tick = () => new Promise<void>(yes => setImmediate(yes));

async function fixtureFetch(input: string | URL | Request, init?: RequestInit, audit: HttpAudit = httpAudit): Promise<Response> {
    const { url, request, journal, saved } = inspectHttp(input, init, audit);
    const path = url.pathname, q = url.searchParams;
    try {

        if (path === '/api/memory-files') return Response.json({ enabled: false, flushEvery: 10, retentionDays: 30, path: '/fixture/memory', counter: 0, files: [] });
        if (path === '/api/memory/status') return Response.json({ enabled: false, provider: 'local', state: 'disabled', initialized: false, storageRoot: '/fixture/memory' });
        if (path === '/api/bgtask') return Response.json({ tasks: [] });
        if (path === '/api/goal') return Response.json({ ok: true, goal: null,
            pauseGate: { armed: false, attempts: 0, requiredAttempts: 2, reason: null, nextAction: null } });
        if (path === '/api/auth/token') return Response.json({ token: 'fixture-token' });
        if (path === '/api/settings') return Response.json({ workingDir: '/fixture/print', presentation: { mode: 'activity' } });
        if (path === '/api/runtime/requests') return Response.json({ ok: true, data: { requests: [] } });
        if (path === '/api/messages/count') return Response.json({ ok: true, data: { count: 0 } });
        if (path === '/api/stats') return Response.json({ count: 0 });

        if (path === '/api/messages') return Response.json({ ok: true, data: { sessionId: identity.sessionId, messages: [] } });
        if (path === '/api/orchestrate/snapshot') return Response.json({
            activityIdentity: identity, orc: { state: 'IDLE', scope: identity.scope, ctx: null },
            heartbeat: { pending: 0, deferredPending: 0 }, workers: [],
            runtime: { queuePending: 0, busy: false }, queued: [], activeRun: null,
        });
        if (path === '/api/traces/activity-runs') return Response.json({ ok: true, data: { runs: [], pageSize: 40 } });
        if (journal) {
            const page = readActivityPage({ runId: journal[1]!, sessionId: identity.sessionId,
                after: Number(q.get('after')), limit: Number(q.get('limit')),
                ...(q.has('through') ? { through: Number(q.get('through')) } : {}) });
            if (!page) throw new Error('Unknown journal');
            return Response.json({ ok: true, data: page });
        }
        if (saved) {
            const rows = db.prepare("SELECT id, role, content, trace_run_id, session_id FROM messages WHERE trace_run_id=? AND session_id=? AND role='assistant'")
                .all(saved[1]!, identity.sessionId);
            if (rows.length > 1) throw new Error('Ambiguous fixture MESSAGE');
            return Response.json({ ok: true, data: { message: rows[0] ?? null } });
        }
        throw new Error('Unserved fixture route');
    } catch (error) {
        audit.unexpected.push(request);
        throw error;
    }
}

test.before(async () => {
    ({ db } = await import('../../src/core/db.ts'));
    ({ settings } = await import('../../src/core/config.ts'));
    oldMemory = settings.memory.enabled; oldFallback = settings.fallbackOrder;
    settings.memory.enabled = false; settings.fallbackOrder = [];
    db.prepare('INSERT INTO chat_sessions(id,seq,label) VALUES(?,?,?)')
        .run(identity.sessionId, Date.now(), 'print web contract');
    lifecycle = await import('../../src/agent/lifecycle-handler.ts');
    bus = await import('../../src/core/event-bus.ts');
    trace = await import('../../src/trace/store.ts');
    ({ createPrintActivity } = await import('../../src/agent/runtime/print-activity.ts'));
    ({ extractFromEvent } = await import('../../src/agent/events/index.ts'));
    ({ readActivityPage } = await import('../../src/trace/activity-journal.ts'));
    ({ resetGoalStore: resetGoals } = await import('../../src/goal/store.ts'));
    lifecycle.setSpawnAgent(() => { throw new Error('Unexpected fixture respawn'); });
    mock.method(Date, 'now', () => fixtureNow);
    mock.method(console, 'log', () => {});
    const warn = console.warn.bind(console);
    mock.method(console, 'warn', (...args: unknown[]) => {
        // This DOM harness intentionally lacks IDB; cache persistence is outside this fixture.
        if (String(args[0]).startsWith('[idb-cache]')) return;
        warn(...args);
    });
    setupWebUiDom();
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('../../public/css/activity.css', import.meta.url), 'utf8');
    document.head.append(style);
    mock.method(globalThis, 'fetch', fixtureFetch);
    ui = await import('../../public/js/ui.ts');
    virtual = await import('../../public/js/virtual-scroll.ts');
    live = await import('../../public/js/features/activity-live.ts');
    ({ state } = await import('../../public/js/state.ts'));
    history = await import('../../public/js/features/activity-history.ts');
    rendering = await import('../../public/js/render.ts');
    ws = await import('../../public/js/ws.ts'); ws.connect(); opened();
    await ui.loadMessages(); await ws.syncOrchestrateSnapshot('channel-ready', { hydrateRun: true });
});
test.beforeEach(async () => {
    assert.deepEqual(unexpectedHttp, []);
    httpAudit.requests.length = 0;
    history.disposeActivityHistory(); rendering.cancelPostRender();
    fixtureNow += 1000; // Each case is outside the previous case's legacy finalizer debounce.
    resetGoals(); lifecycle.clearGoalTimers();
    virtual.getVirtualScroll().clear(); visibleRows = [];
    ui.clearSteer(); ui.cleanupToolActivity(); live.clearLiveActivity();
    document.getElementById('chatMessages')!.replaceChildren();
    document.documentElement.dataset['presentationMode'] = 'activity';
    await ws.syncOrchestrateSnapshot('print-fixture', { hydrateRun: true });
    assert.deepEqual(state.activityIdentity, identity, 'identity must come through server snapshot admission');
});
test.afterEach(async () => {
    await tick(); rendering.cancelPostRender(); history.disposeActivityHistory();
    assert.deepEqual(unexpectedHttp, [], 'caught HTTP failures cannot become a green fixture');
});
test.after(async () => {
    await tick(); lifecycle.clearGoalTimers(); resetGoals();
    virtual.getVirtualScroll().clear();
    live.clearLiveActivity(); ui.cleanupToolActivity(); history.disposeActivityHistory(); rendering.cancelPostRender();
    settings.memory.enabled = oldMemory; settings.fallbackOrder = oldFallback;
    db.close(); resetWebUiDom(); mock.restoreAll(); rmSync(fixtureHome, { recursive: true });
});

// Reuses the current print-activity-lifecycle fixture boundary. Expected bytes
// are explicit inputs, not values computed from the producer's returned events.
async function produce(kind: 'answer' | 'empty' | 'error', answer = 'selected print answer', canonicalAnswer = answer) {
    const events: BusEvent[] = [];
    const unsubscribe = bus.subscribe(event => events.push(event));
    const runId = trace.startTraceRun({ cli: 'codex', sessionId: identity.sessionId, scopeKey: identity.scope });
    let ends = 0, resolves = 0;
    let result: Parameters<ExitHandlerParams['resolve']>[0] | undefined;
    try {
        const ctx: ExitHandlerParams['ctx'] = {
            fullText: '', toolLog: [],
            traceLog: [], stderrBuf: kind === 'error' ? 'fixture process failed' : '', seenToolKeys: new Set(),
            hasClaudeStreamEvents: false, sessionId: 'provider-private', cost: null, turns: null,
            duration: null, tokens: null, traceRunId: runId, traceAudience: 'public', liveScope: identity.scope, activityIdentity: identity,
        };
        ctx.printActivity = createPrintActivity({ ...identity, runId, turnId: runId, audience: 'public' }, 'codex');
        extractFromEvent('codex', { type: 'item.completed', item: { type: 'agent_message',
            text: 'Inspecting print fixture', channel: 'commentary' } }, ctx, 'fixture');
        if (kind === 'answer') extractFromEvent('codex', { type: 'item.completed', item: {
            type: 'agent_message', text: answer } }, ctx, 'fixture');
        if (kind === 'empty') extractFromEvent('codex', { type: 'item.completed', item: {
            id: 'empty-tool', type: 'command_execution', command: 'echo fixture', status: 'completed',
            exit_code: 0, aggregated_output: '' } }, ctx, 'fixture');
        await lifecycle.handleAgentExit({
            ctx, code: kind === 'error' ? 1 : 0, cli: 'codex', model: 'fixture', resumeKey: null,
            agentLabel: `print-fixture-${++serial}`, mainManaged: true, origin: 'web', prompt: 'fixture',
            opts: { _skipSessionPersist: true, _isSmokeContinuation: true, _isFallback: true }, cfg: {},
            ownerGeneration: 1, persistenceOwner: { global: 0, scope: 0 }, forceNew: false, empSid: null,
            isResume: false, wasKilled: false, wasSteer: false,
            smokeResult: { isSmoke: false, confidence: 'low', matchedPattern: null, reason: '' },
            effortDefault: '', costLine: '', resolve: value => { resolves++; result = value; }, activeProcesses: new Map(),
            scopeKey: identity.scope, chatSessionId: identity.sessionId, childProcess: null, releaseMainRun: () => false,
            retryState: { setTimer() {}, setResolve() {}, setOrigin() {}, setIsEmployee() {} },
            fallbackState: new Map(), fallbackMaxRetries: 0, processQueue() {},
            onRuntimeEnd: end => { ends++; ctx.printActivity!.finish(end); },
        });
        assert.equal(ends, 1); assert.equal(resolves, 1); assert.ok(result); assert.equal(result.runtimeOutcome, undefined);
        const terminals = events.filter(event => event.event === 'agent_done'
            || (event.event === 'agent_runtime' && event.data['kind'] === 'turn-end'));
        const legacy = terminals.find(event => event.event === 'agent_done')!;
        const canonical = terminals.find(event => event.event === 'agent_runtime');
        assert.equal(terminals.filter(event => event.event === 'agent_done').length, 1);
        assert.ok(terminals.filter(event => event.event === 'agent_runtime').length <= 1);
        assert.ok(legacy); assert.equal(legacy.data['traceRunId'], runId);
        const expectedText = kind === 'error' ? '❌ codex 실행 실패 (exit 1)' : kind === 'empty' ? '' : answer;
        assert.equal(legacy.data['text'], expectedText);
        if (kind !== 'error') {
            assert.deepEqual(db.prepare("SELECT content,trace_run_id FROM messages WHERE trace_run_id=? AND role='assistant'").all(runId),
                [{ content: kind === 'empty' ? '' : answer, trace_run_id: runId }]);
        }
        assert.equal(Object.hasOwn(legacy.data, 'runtimeFinality'), false);
        assert.equal(Object.hasOwn(legacy.data, 'runtimeStatus'), false);
        if (canonical) {
            assert.equal(terminals[0], legacy, 'actual producer is compatibility-first');
            assert.equal(canonical.data['finalText'], kind === 'error' ? null : kind === 'empty' ? '' : canonicalAnswer);
            assert.equal(canonical.data['status'], kind === 'error' ? 'error' : 'done');
        }
        if (kind === 'error') {
            assert.equal(legacy.data['error'], true); assert.equal(legacy.data['errorKind'], 'exit');
            assert.equal(canonical?.data['error'], 'codex 실행 실패 (exit 1)');
        }
        return { events, terminals, legacy, canonical, runId, expectedText };
    } finally { unsubscribe(); }
}
type Produced = Awaited<ReturnType<typeof produce>>;
function send(event: BusEvent) { dispatch({ ...event.data, event: event.event }); }
function begin(f: Produced, admitted = true, early = false) {
    dispatch({ event: 'agent_status', running: true });
    for (const event of f.events) {
        if (event.event !== 'agent_runtime' || event.data['kind'] === 'turn-end') continue;
        if (early && event.data['kind'] !== 'turn-start') continue;
        if (admitted) send(event);
        else dispatch({ ...event.data, sessionId: 'foreign-session', event: event.event });
    }
}
function finish(f: Produced, order: 'legacy-first' | 'canonical-first') {
    assert.ok(f.canonical, 'small fixture must produce a real canonical terminal');
    for (const event of order === 'legacy-first' ? f.terminals : [...f.terminals].reverse()) send(event);
}
function messages() { return [...document.querySelectorAll<HTMLElement>('.msg-agent')]; }
function raw(message = messages()[0]!) { return message.querySelector('.msg-content')?.getAttribute('data-raw'); }
function diagnostics() { return [...document.querySelectorAll('.msg-system')].map(visibleText).join('\n'); }
function visibleText(root: Element): string {
    if (root instanceof HTMLElement && (root.hidden || getComputedStyle(root).display === 'none')) return '';
    return [...root.childNodes].map(node => node.nodeType === Node.TEXT_NODE ? node.textContent ?? ''
        : node instanceof Element ? (root.tagName === 'DETAILS' && !root.hasAttribute('open')
            && node.tagName !== 'SUMMARY' ? '' : visibleText(node)) : '').join('');
}
function assertDiagnostic(f: Produced) {
    assert.equal(messages().length, 1, 'one answer host, no duplicate diagnostic bubble');
    assert.ok(visibleText(messages()[0]!).includes('codex 실행 실패 (exit 1)'),
        'classified diagnostic must remain visible outside collapsed Activity');
}
for (const order of ['legacy-first', 'canonical-first'] as const) {
    test(`real print selected answer: ${order} settles once without native markers`, async () => {
        const f = await produce('answer'); begin(f); finish(f, order);
        assert.equal(messages().length, 1); assert.equal(raw(), f.expectedText);
        assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
        assert.equal(live.findLiveActivity(f.runId)?.model.end?.status, 'done');
        send(f.legacy); send(f.canonical!); assert.equal(messages().length, 1);
    });
    test(`real print tool-only authoritative empty: ${order}`, async () => {
        const f = await produce('empty');
        dispatch({ event: 'agent_status', running: true });
        dispatch({ event: 'agent_output', traceRunId: f.runId, text: 'old stream commentary', textLen: 21 });
        begin(f); finish(f, order);
        assert.equal(messages().length, 1); assert.equal(raw(), '');
        assert.equal(messages()[0]!.querySelector('.msg-content')?.textContent, '', 'empty is not dispatching or commentary');
        assert.equal(live.findLiveActivity(f.runId)?.model.end?.finalText, '');
        assert.equal(state.agentBusy, false);
    });
    test(`real print error/null: ${order} preserves a visible diagnostic`, async () => {
        const f = await produce('error'); begin(f); finish(f, order); assertDiagnostic(f);
        assert.equal(live.findLiveActivity(f.runId)?.model.end?.finalText, null);
        assert.equal(live.findLiveActivity(f.runId)?.model.end?.status, 'error');
        assert.equal(state.agentBusy, false);
    });
}
test('full print answer >32768 survives actual canonical record-size degradation', async () => {
    const answer = 'a'.repeat(33000) + 'FULL_PRINT_SENTINEL';
    const f = await produce('answer', answer);
    assert.equal(f.canonical, undefined, 'actual 32KiB recorder rejects this terminal, not a fake oversized event');
    const gap = f.events.find(event => event.event === 'agent_runtime_gap'); assert.ok(gap);
    begin(f); send(f.legacy); send(gap);
    assert.equal(messages().length, 1); assert.equal(raw(), answer);
    assert.ok(visibleText(messages()[0]!).includes('FULL_PRINT_SENTINEL'));
    assert.equal(live.findLiveActivity(f.runId)?.degraded, true);
});
for (const kind of ['answer', 'error'] as const) test(`journal gap with lost canonical terminal: ${kind}`, async () => {
    const f = await produce(kind); begin(f);
    dispatch({ event: 'agent_runtime_gap', ...identity, runId: f.runId, reason: 'projection_degraded' });
    send(f.legacy);
    assert.equal(messages().length, 1); assert.equal(raw(), f.expectedText);
    assert.equal(live.findLiveActivity(f.runId)?.model.end, null, 'no fabricated canonical end');
    assert.equal(messages()[0]!.dataset['activityLive'], 'false');
    assert.ok(visibleText(messages()[0]!).includes(String(f.expectedText)));
    if (kind === 'error') assert.doesNotMatch(visibleText(messages()[0]!), /Complete/, 'unmarked error cannot claim successful completion');
});
test('RID-005: late run-tagged A terminals cannot overwrite active B', async () => {
    const a = await produce('answer', 'answer A'), b = await produce('answer', 'answer B');
    begin(a); send(a.legacy); begin(b);
    const host = state.currentAgentDiv; assert.ok(host);
    send(a.canonical!); send(a.legacy);
    assert.equal(state.currentAgentDiv, host); assert.equal(state.agentBusy, true);
    assert.equal(messages().length, 2); finish(b, 'legacy-first');
    assert.equal(raw(host), 'answer B'); assert.equal(raw(messages()[0]), 'answer A');
});
test('unadmitted canonical identity keeps the actual print legacy answer', async () => {
    const f = await produce('answer'); begin(f, false); send(f.legacy);
    assert.equal(live.findLiveActivity(f.runId), undefined);
    assert.equal(messages().length, 1); assert.equal(raw(), f.expectedText);
});
test('raw legacy-only stream and real print terminal retain the authoritative answer', async () => {
    const f = await produce('answer'); dispatch({ event: 'agent_status', running: true });
    dispatch({ event: 'agent_output', traceRunId: f.runId, text: 'legacy preview', textLen: 14 });
    send(f.legacy); assert.equal(messages().length, 1); assert.equal(raw(), f.expectedText);
    assert.equal(document.querySelector('.activity-turn'), null);
});
// P13-P16: synthetic consumer compatibility wires, NOT actual spawn output.
// Current spawn.ts Copilot error and ENOENT error publishers have no run ID.
// Real producer/reentrancy tests remain print-bypass-paths and print-spawn-journal.
for (const source of ['ENOENT', 'ACP'] as const) for (const canonical of [true, false]) {
    test(`synthetic bypass: early ${source} untagged diagnostic, canonical ${canonical ? 'arrives' : 'missing'}`, async () => {
        const f = await produce('error'); begin(f, true, true);
        const diagnostic = source === 'ENOENT' ? "CLI 'codex' 실행 실패 (ENOENT). 설치/경로를 확인하세요."
            : 'Copilot ACP spawn failed: fixture spawn failure';
        dispatch({ event: 'agent_status', running: false, agentId: 'fixture' });
        const host = state.currentAgentDiv!; const before = host.outerHTML; const busy = state.agentBusy;
        dispatch({ event: 'agent_done', text: `❌ ${diagnostic}`, error: true, origin: 'web' });
        assert.equal(state.currentAgentDiv, host); assert.equal(state.agentBusy, busy); assert.equal(host.outerHTML, before);
        assert.ok(diagnostics().includes(diagnostic), 'no-ID diagnostic must be independent and visible in whole chat');
        assert.equal(live.findLiveActivity(f.runId)?.model.end, null);
        assert.equal(live.findLiveActivity(f.runId)?.terminalStatus, undefined, 'no foreground inference or invented terminal');
        if (canonical) send({ ...f.canonical!, data: { ...f.canonical!.data, error: diagnostic } });
        assert.equal(messages().length, 1);
        assert.ok(visibleText(document.getElementById('chatMessages')!).includes(diagnostic));
        assert.equal(live.findLiveActivity(f.runId)?.model.end?.status, canonical ? 'error' : undefined);
        assert.equal(state.currentAgentDiv, canonical ? null : host);
    });
}

test('[296 approved uncorrelated fallback] canonical-first then delayed no-ID error stays independent', async () => {
    const f = await produce('error'); begin(f, true, true);
    const diagnostic = "CLI 'codex' 실행 실패 (ENOENT). 설치/경로를 확인하세요.";
    send({ ...f.canonical!, data: { ...f.canonical!.data, error: diagnostic } });
    assert.ok(visibleText(messages()[0]!).includes(diagnostic));
    const before = messages()[0]!.outerHTML;
    fixtureNow += 501; // Exercise behavior after debounce, without sleeping or inventing an ID.
    dispatch({ event: 'agent_done', text: `❌ ${diagnostic}`, error: true, origin: 'web' });
    assert.equal(messages().length, 1); assert.equal(messages()[0]!.outerHTML, before);
    assert.ok(diagnostics().includes(diagnostic), 'keep independent legacy diagnostic; never guess a historical receipt');
});
test('late no-ID error cannot settle, mark finished, or change active B stream', async () => {
    const a = await produce('error'), b = await produce('answer', 'answer B');
    begin(a); finish(a, 'canonical-first'); begin(b);
    const host = state.currentAgentDiv!; const before = host.outerHTML;
    const model = structuredClone(live.findLiveActivity(b.runId)!.model);
    dispatch({ event: 'agent_done', text: '❌ late unbound failure', error: true, origin: 'web' });
    assert.equal(state.currentAgentDiv, host); assert.equal(state.agentBusy, true); assert.equal(host.outerHTML, before);
    assert.deepEqual(live.findLiveActivity(b.runId)!.model, model); assert.equal(live.findLiveActivity(b.runId)?.terminalStatus, undefined);
    assert.ok(diagnostics().includes('late unbound failure')); assert.equal(messages().length, 2);
    finish(b, 'canonical-first'); assert.equal(raw(host), 'answer B'); assert.equal(state.agentBusy, false);
});

const originalAnswer = 'Use Bearer abcdefghijklmnop and PASSWORD=plain-canary';
const canonicalAnswer = 'Use Bearer [REDACTED] and PASSWORD=[REDACTED]';
for (const order of ['legacy-first', 'canonical-first'] as const) {
    test(`original print bytes win over real redacted projection in the same row: ${order}`, async () => {
        const f = await produce('answer', originalAnswer, canonicalAnswer); begin(f);
        assert.equal(f.expectedText, originalAnswer);
        assert.equal(f.canonical!.data['finalText'], canonicalAnswer, 'producer really redacted the canonical body');
        const host = state.currentAgentDiv!; const messageId = host.dataset['messageId'];
        if (order === 'canonical-first') {
            send(f.canonical!); assert.equal(raw(host), canonicalAnswer);
            send(f.legacy);
        } else { send(f.legacy); send(f.canonical!); }
        assert.equal(messages().length, 1); assert.equal(messages()[0], host);
        assert.equal(host.dataset['messageId'], messageId); assert.equal(raw(host), originalAnswer);
        send(f.canonical!); send(f.legacy);
        assert.equal(messages().length, 1); assert.equal(raw(host), originalAnswer);
    });
}
test('late original compatibility for canonical-first A updates only A after B starts', async () => {
    const a = await produce('answer', originalAnswer, canonicalAnswer), b = await produce('answer', 'answer B');
    begin(a); const aHost = state.currentAgentDiv!; send(a.canonical!);
    begin(b); const bHost = state.currentAgentDiv!; const bBefore = bHost.outerHTML;
    send(a.legacy);
    assert.equal(state.currentAgentDiv, bHost); assert.equal(state.agentBusy, true);
    assert.equal(bHost.outerHTML, bBefore, 'late A must not alter B stream, host or status');
    assert.equal(messages().length, 2); assert.equal(raw(aHost), originalAnswer);
    finish(b, 'legacy-first'); assert.equal(raw(bHost), 'answer B');
});
for (const mounted of [true, false]) test(`canonical-first print correction survives ${mounted ? 'mounted' : 'offscreen'} virtual row recycling`, async () => {
    const f = await produce('answer', originalAnswer, canonicalAnswer); begin(f); send(f.canonical!);
    const oldHost = messages()[0]!; const messageId = oldHost.dataset['messageId']; assert.ok(messageId);
    const items = [{ id: 'virtual-print-row', messageId, html: oldHost.outerHTML, height: 80 }];
    const vs = virtual.getVirtualScroll(); visibleRows = mounted ? [0] : [];
    const messageHistory = await import('../../public/js/features/message-history.ts');
    messageHistory.ensureActivityVirtualCallbacks(vs);
    vs.setItems(items, { toBottom: false });
    const mountedHost = messages()[0];
    assert.equal(messages().length, mounted ? 1 : 0);
    send(f.legacy);
    assert.equal(vs.count, 1, 'correction must not append a virtual item');
    assert.equal(state.currentAgentDiv, null); assert.equal(state.agentBusy, false);
    const cached = document.createElement('div'); cached.innerHTML = items[0]!.html;
    assert.equal(raw(cached), originalAnswer, 'original bytes must reach the stored virtual HTML');
    if (mounted) { assert.equal(messages()[0], mountedHost); assert.equal(raw(mountedHost), originalAnswer); }
    visibleRows = []; geometryChanged(); visibleRows = [0]; geometryChanged();
    assert.equal(messages().length, 1); assert.equal(messages()[0]!.dataset['messageId'], messageId);
    assert.equal(raw(), originalAnswer, 'recycled row must not revert to redacted canonical bytes');
    vs.clear();
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
    const runId = (await produce('answer')).runId;
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
