import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { ExitHandlerParams } from '../../src/agent/lifecycle-handler.ts';
import type { BusEvent } from '../../src/core/event-bus.ts';
// tests/run.mts replaces CLI_JAW_HOME; restore only this explicitly isolated fixture home.
const fixtureHome = resolve('.tmp/print-web-ci');
mkdirSync(fixtureHome, { recursive: true });
process.env.CLI_JAW_HOME = fixtureHome;
let dispatch: (event: Record<string, unknown>) => void;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) {
        if (topic === '*') dispatch = callback;
        return () => {};
    },
    onChannelOpen() {}, onChannelDisconnect() {}, onChannelUnavailable() {},
} });
let visibleRows: number[] = [];
let geometryChanged = () => {};
class Geometry {
    constructor(public options: Record<string, unknown>) { geometryChanged = options['onChange'] as () => void; }
    _didMount() { return () => {}; } _willUpdate() {} measureElement() {} measure() {}
    getVirtualItems() { return visibleRows.map(index => ({ index, start: index * 80, size: 80, end: (index + 1) * 80, key: index })); }
    getTotalSize() { return 80; } setOptions(options: Record<string, unknown>) { this.options = options; }
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
let Projection: typeof import('../../src/agent/runtime/projection.ts')['RuntimeProjection'];
let resetGoals: typeof import('../../src/goal/store.ts')['resetGoalStore'];
const identity = { sessionId: `print-web-${Date.now()}`, scope: 'print-web-scope' };
let serial = 0;
let fixtureNow = Date.now();
const tick = () => new Promise<void>(yes => setImmediate(yes));
test.before(async () => {
    ({ db } = await import('../../src/core/db.ts'));
    const { settings } = await import('../../src/core/config.ts');
    settings.memory.enabled = false; settings.fallbackOrder = [];
    db.prepare('INSERT INTO chat_sessions(id,seq,label) VALUES(?,?,?)')
        .run(identity.sessionId, Date.now(), 'print web contract');
    lifecycle = await import('../../src/agent/lifecycle-handler.ts');
    bus = await import('../../src/core/event-bus.ts');
    trace = await import('../../src/trace/store.ts');
    ({ RuntimeProjection: Projection } = await import('../../src/agent/runtime/projection.ts'));
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
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const path = String(input);
        let data: unknown;
        if (path.includes('/orchestrate/snapshot')) data = {
            activityIdentity: identity, orc: { state: 'IDLE', scope: identity.scope, ctx: null },
            heartbeat: { pending: 0, deferredPending: 0 }, workers: [],
            runtime: { queuePending: 0, busy: false }, queued: [], activeRun: null,
        };
        else if (path.includes('/api/runtime/requests?')) data = { requests: [] };
        else if (path.includes('/api/traces/activity-runs')) data = { runs: [], pageSize: 40 };
        else if (path.includes('/api/stats') || path.includes('/api/messages/count')) data = { count: 0 };
        else if (path.includes('/api/auth/token')) return Response.json({ token: 'fixture-token' });
        else throw new Error(`Unexpected fixture HTTP: ${path}`);
        return Response.json({ ok: true, data });
    });
    ui = await import('../../public/js/ui.ts');
    virtual = await import('../../public/js/virtual-scroll.ts');
    live = await import('../../public/js/features/activity-live.ts');
    ({ state } = await import('../../public/js/state.ts'));
    ws = await import('../../public/js/ws.ts'); ws.connect();
});
test.beforeEach(async () => {
    fixtureNow += 1000; // Each case is outside the previous case's legacy finalizer debounce.
    resetGoals(); lifecycle.clearGoalTimers();
    virtual.getVirtualScroll().clear(); visibleRows = [];
    ui.clearSteer(); ui.cleanupToolActivity(); live.clearLiveActivity();
    document.getElementById('chatMessages')!.replaceChildren();
    document.documentElement.dataset['presentationMode'] = 'activity';
    await ws.syncOrchestrateSnapshot('print-fixture', { hydrateRun: true });
    assert.deepEqual(state.activityIdentity, identity, 'identity must come through server snapshot admission');
});
test.after(async () => {
    await tick(); lifecycle.clearGoalTimers(); resetGoals();
    virtual.getVirtualScroll().clear();
    live.clearLiveActivity(); ui.cleanupToolActivity(); resetWebUiDom(); mock.restoreAll();
});

// Same lifecycle fixture/callback relationship as backend 2a043b14's
// tests/unit/print-activity-lifecycle.test.ts:47. No cross-worktree imports.
// The local canonical projection owns record sequencing, bounds and publication.
async function produce(kind: 'answer' | 'empty' | 'error', answer = 'selected print answer', canonicalAnswer = answer) {
    const events: BusEvent[] = [];
    const unsubscribe = bus.subscribe(event => events.push(event));
    const runId = trace.startTraceRun({ cli: 'codex', sessionId: identity.sessionId, scopeKey: identity.scope });
    const projection = new Projection({ ...identity, runId, turnId: runId, audience: 'public' });
    let ends = 0;
    let result: Parameters<ExitHandlerParams['resolve']>[0] | undefined;
    try {
        projection.start('codex');
        projection.text('message', 'prelude', 'Inspecting print fixture', 'replace', 'commentary');
        if (kind === 'empty') projection.tool('tool', { name: 'echo fixture', status: 'done', output: '' });
        const ctx: ExitHandlerParams['ctx'] = {
            fullText: kind === 'answer' ? answer : '', toolLog: kind === 'empty'
                ? [{ icon: 'tool', label: 'echo fixture', toolType: 'tool', status: 'done', detail: '' }] : [],
            traceLog: [], stderrBuf: kind === 'error' ? 'fixture process failed' : '', seenToolKeys: new Set(),
            hasClaudeStreamEvents: false, sessionId: 'provider-private', cost: null, turns: null,
            duration: null, tokens: null, traceRunId: runId, traceAudience: 'public', liveScope: identity.scope,
        };
        await lifecycle.handleAgentExit({
            ctx, code: kind === 'error' ? 1 : 0, cli: 'codex', model: 'fixture', resumeKey: null,
            agentLabel: `print-fixture-${++serial}`, mainManaged: true, origin: 'web', prompt: 'fixture',
            opts: { _skipSessionPersist: true, _isSmokeContinuation: true, _isFallback: true }, cfg: {},
            ownerGeneration: 1, persistenceOwner: { global: 0, scope: 0 }, forceNew: false, empSid: null,
            isResume: false, wasKilled: false, wasSteer: false,
            smokeResult: { isSmoke: false, confidence: 'low', matchedPattern: null, reason: '' },
            effortDefault: '', costLine: '', resolve: value => { result = value; }, activeProcesses: new Map(),
            scopeKey: identity.scope, chatSessionId: identity.sessionId, childProcess: null, releaseMainRun: () => false,
            retryState: { setTimer() {}, setResolve() {}, setOrigin() {}, setIsEmployee() {} },
            fallbackState: new Map(), fallbackMaxRetries: 0, processQueue() {},
            onRuntimeEnd: end => { ends++; projection.close(end); },
        });
        assert.equal(ends, 1); assert.ok(result); assert.equal(result.runtimeOutcome, undefined);
        const terminals = events.filter(event => event.event === 'agent_done'
            || (event.event === 'agent_runtime' && event.data['kind'] === 'turn-end'));
        const legacy = terminals.find(event => event.event === 'agent_done')!;
        const canonical = terminals.find(event => event.event === 'agent_runtime');
        assert.ok(legacy); assert.equal(legacy.data['traceRunId'], runId);
        assert.equal(Object.hasOwn(legacy.data, 'runtimeFinality'), false);
        assert.equal(Object.hasOwn(legacy.data, 'runtimeStatus'), false);
        if (canonical) {
            assert.equal(terminals[0], legacy, 'actual producer is compatibility-first');
            assert.equal(canonical.data['finalText'], kind === 'error' ? null : kind === 'empty' ? '' : canonicalAnswer);
            assert.equal(canonical.data['status'], kind === 'error' ? 'error' : 'done');
        }
        if (kind === 'error') {
            assert.equal(legacy.data['error'], true); assert.ok(legacy.data['errorKind']);
            assert.equal(legacy.data['text'], `❌ ${canonical?.data['error']}`);
        }
        return { events, terminals, legacy, canonical, runId };
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
    assert.ok(visibleText(messages()[0]!).includes(String(f.canonical!.data['error'])),
        'classified diagnostic must remain visible outside collapsed Activity');
}
for (const order of ['legacy-first', 'canonical-first'] as const) {
    test(`real print selected answer: ${order} settles once without native markers`, async () => {
        const f = await produce('answer'); begin(f); finish(f, order);
        assert.equal(messages().length, 1); assert.equal(raw(), f.legacy.data['text']);
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
    assert.equal(messages().length, 1); assert.equal(raw(), f.legacy.data['text']);
    assert.equal(live.findLiveActivity(f.runId)?.model.end, null, 'no fabricated canonical end');
    assert.equal(messages()[0]!.dataset['activityLive'], 'false');
    assert.ok(visibleText(messages()[0]!).includes(String(f.legacy.data['text'])));
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
    assert.equal(messages().length, 1); assert.equal(raw(), f.legacy.data['text']);
});
test('raw legacy-only stream and real print terminal retain the authoritative answer', async () => {
    const f = await produce('answer'); dispatch({ event: 'agent_status', running: true });
    dispatch({ event: 'agent_output', traceRunId: f.runId, text: 'legacy preview', textLen: 14 });
    send(f.legacy); assert.equal(messages().length, 1); assert.equal(raw(), f.legacy.data['text']);
    assert.equal(document.querySelector('.activity-turn'), null);
});
// Source-derived bypass wire, not a handleAgentExit-produced payload: backend
// 2a043b14 spawn.ts:1721-1731 (ACP) and :2991-3005 (ENOENT). Neither stamps a run ID.
for (const source of ['ENOENT', 'ACP'] as const) for (const canonical of [true, false]) {
    test(`early ${source} untagged diagnostic, canonical ${canonical ? 'arrives' : 'missing'}`, async () => {
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
        assert.equal(f.legacy.data['text'], originalAnswer);
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
    vs.onPostRender = viewport => live.remountLiveActivity(viewport);
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
