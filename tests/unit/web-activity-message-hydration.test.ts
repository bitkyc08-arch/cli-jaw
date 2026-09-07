import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { CachedMessage } from '../../public/js/features/idb-cache.ts';
import type { SessionListResponse } from '../../public/js/features/session-hub.ts';

// Actual loadMessages/API/sessionHub/VS/HTML/history. Storage is an observed port,
// and the existing geometry seam mounts fixture rows; neither is browser/IDB proof.
// Current VS_THRESHOLD=1 makes nonempty hydrateSmallHistory unreachable. Do not
// alter the threshold just to claim that production branch was exercised.
const options = { timeout: 10_000 };
const response = (data: unknown) => Response.json({ ok: true, data });
const writes: Array<{ scope: string; rows: CachedMessage[] }> = [];
const cacheRows = new Map<string, CachedMessage[]>();
const cacheReads: string[] = [];
let scope = 'default';
let readCache: (target: string) => Promise<CachedMessage[]>;
mock.module('../../public/js/features/idb-cache.js', { namedExports: {
    getMessageScope: () => scope,
    setMessageScope: (value: string) => { scope = value; },
    cacheMessages: async (rows: CachedMessage[], target = scope) => { writes.push({ scope: target, rows: structuredClone(rows) }); },
    getScopedMessages: async (target = scope) => { cacheReads.push(target); return readCache(target); },
    replaceCachedAnswer: async () => {},
} });

// Reused from web-activity-answer-cache: fake only the layout engine, not VS mappers.
class Geometry {
    constructor(public options: Record<string, unknown>) {}
    _didMount() { return () => {}; } _willUpdate() {} measureElement() {} measure() {}
    getVirtualItems() {
        return Array.from({ length: Number(this.options['count']) }, (_, index) => ({ index,
            start: index * 80, size: 80, end: (index + 1) * 80, key: index }));
    }
    getTotalSize() { return Number(this.options['count']) * 80; }
    setOptions(options: Record<string, unknown>) { this.options = options; }
    scrollToIndex() {} scrollToOffset() {}
}
mock.module('@tanstack/virtual-core', { namedExports: {
    Virtualizer: Geometry, elementScroll() {}, observeElementRect() {}, observeElementOffset() {},
} });

let loader: typeof import('../../public/js/features/message-history.ts');
let sessionHub: typeof import('../../public/js/features/session-hub.ts');
let history: typeof import('../../public/js/features/activity-history.ts');
let live: typeof import('../../public/js/features/activity-live.ts');
let virtual: typeof import('../../public/js/virtual-scroll.ts');
let current: HTMLElement | null = null;
const requests: URL[] = [];
const unexpected: string[] = [];
const work = new Set<Promise<void>>();
const releases: Array<() => void> = [];
let serve: (url: URL, init?: RequestInit) => Promise<Response>;
let caseNumber = 0;
let workingDir = '';
const runs = { A: 'tr_hydration_A_00000000', B: 'tr_hydration_B_00000000' };
const sessions: SessionListResponse = { active: 'B', sessions: [
    { id: 'A', seq: 1, label: 'A', message_count: 1, source: 'local' },
    { id: 'B', seq: 2, label: 'B', message_count: 1, source: 'local' },
] };
function select(id: 'A' | 'B', path = id === 'A' ? '/1' : '/2'): void {
    window.history.replaceState({}, '', path);
    const roster = path === '/1' && id === 'B'
        ? { ...sessions, sessions: [{ ...sessions.sessions[1]!, seq: 1 }] } : sessions;
    assert.equal(sessionHub.configureSessionView(roster), 'session');
    assert.equal(sessionHub.currentSessionId(), id);
}
function offMode(): void {
    window.history.replaceState({}, '', '/');
    assert.equal(sessionHub.configureSessionView({ active: 'A', sessions: [] }), 'off');
    assert.equal(sessionHub.currentSessionId(), null);
}
function setIdentity(sessionId: string): void {
    const identity = { sessionId, scope: `local:${sessionId}` };
    live.setLiveActivityIdentity(identity);
    history.setActivityHistoryIdentity(identity, { terminal() {}, refreshIdentity: async () => {} });
    history.setActivityHistoryReadReady(false);
}
function load(): Promise<void> { const promise = loader.loadMessages(); work.add(promise); return promise; }
function rowsFor(id: 'A' | 'B') {
    return [{ id: id === 'A' ? 101 : 202, role: 'assistant', content: `${id} EXACT ANSWER`, trace_run_id: runs[id] }];
}
function cacheKey(path: string): string {
    return loader.buildMessageScopeIdentity({ locationKey: `${window.location.origin}${path}`, workingDir });
}
function row(id: string | number): HTMLElement {
    const value = document.querySelector<HTMLElement>(`.msg[data-message-id="${id}"]`);
    assert.ok(value, `message ${id} must be mounted`); return value;
}
function holdPath(pathname: string, result: Response) {
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<Response>();
    const previous = serve;
    let taken = false;
    serve = async (url, init) => {
        if (!taken && url.pathname === pathname) {
            taken = true; assert.ok(init?.signal); started.resolve(init.signal);
            return release.promise; // Ignore cancellation intentionally, as a late transport can.
        }
        return previous(url, init);
    };
    const finish = () => release.resolve(result); releases.push(finish);
    return { started: started.promise, finish };
}

test.before(async () => {
    setupWebUiDom();
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
        if (url.origin !== window.location.origin || (init?.method ?? 'GET') !== 'GET') unexpected.push(url.href);
        if (url.pathname === '/api/auth/token') return Response.json({ token: 'message-fixture-token' });
        requests.push(url);
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer message-fixture-token');
        if (url.pathname === '/api/dashboard/notes/info') return response({ root: null });
        if (/^\/api\/traces\/[^/]+\/activity$/.test(url.pathname)) {
            const sessionId = url.searchParams.get('session')!, runId = url.pathname.split('/')[3]!;
            const after = Number(url.searchParams.get('after'));
            return response({ sessionId, scope: `local:${sessionId}`, runId, status: 'running',
                events: after === 0 ? [{ version: 1, sessionId, scope: `local:${sessionId}`, runId,
                    turnId: `turn-${runId}`, seq: 1, kind: 'turn-start', provider: 'pi' }] : [],
                through: 1, nextAfter: 1, hasMore: false, incomplete: false, loss: null });
        }
        return serve(url, init);
    });
    loader = await import('../../public/js/features/message-history.ts');
    sessionHub = await import('../../public/js/features/session-hub.ts');
    history = await import('../../public/js/features/activity-history.ts');
    live = await import('../../public/js/features/activity-live.ts');
    virtual = await import('../../public/js/virtual-scroll.ts');
    live.configureLiveActivityHost({ currentMessage: () => current, useMessage: node => { current = node; },
        createMessage: () => { throw new Error('No live message creation in loader tests'); },
        reconcileMessage: () => false,
        replaceAnswer(node, text) { const body = node.querySelector<HTMLElement>('.msg-content')!; body.textContent = text; body.dataset['raw'] = text; },
        inspectTrace() {}, closeTrace() {},
    });
});
test.beforeEach(() => {
    current = null; writes.length = 0; cacheReads.length = 0; cacheRows.clear(); requests.length = 0; unexpected.length = 0;
    workingDir = `/fixture/work-${++caseNumber}`; scope = 'default';
    readCache = async target => structuredClone(cacheRows.get(target) ?? []);
    document.getElementById('chatMessages')!.replaceChildren();
    select('A'); setIdentity('A');
    serve = async url => {
        if (url.pathname === '/api/settings') return response({ workingDir });
        if (url.pathname === '/api/messages') {
            const session = url.searchParams.get('session') === 'B' ? 'B' : 'A';
            return response({ sessionId: session, messages: rowsFor(session) });
        }
        unexpected.push(url.pathname); return Response.json({}, { status: 500 });
    };
});
test.afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await Promise.all(work); work.clear();
    history.disposeActivityHistory(); virtual.getVirtualScroll().clear(); live.clearLiveActivity();
    assert.deepEqual(unexpected, []);
}, options);
test.after(() => { history.disposeActivityHistory(); virtual.getVirtualScroll().clear(); live.clearLiveActivity(); resetWebUiDom(); mock.restoreAll(); });

test('A settings held across path and selected-session switch cannot render or cache A into B', options, async () => {
    const gate = holdPath('/api/settings', response({ workingDir: '/fixture/late-A' }));
    const a = load(); const signal = await gate.started;
    select('B'); setIdentity('B'); const b = load();
    await b; await a;
    assert.equal(signal.aborted, true);
    assert.equal(row(202).dataset['messageSessionId'], 'B');
    const before = document.getElementById('chatMessages')!.innerHTML;
    const recorded = structuredClone(writes);
    gate.finish(); await load();
    assert.equal(document.getElementById('chatMessages')!.innerHTML, before);
    assert.deepEqual(writes, recorded);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.scope, cacheKey('/2'));
    assert.equal(writes[0]?.rows[0]?.session_id, 'B');
    assert.equal(requests.some(url => url.pathname === '/api/messages' && url.searchParams.get('session') === 'A'), false);
});

for (const path of ['/1', '/2']) {
test(`A messages held across selected-ID switch to ${path} cannot replace B or enter its cache`, options, async () => {
    const gate = holdPath('/api/messages', response({ sessionId: 'A', messages: rowsFor('A') }));
    const a = load(); const signal = await gate.started;
    select('B', path); setIdentity('B'); const b = load();
    await b; await a;
    assert.equal(signal.aborted, true);
    gate.finish(); await load();
    assert.equal(row(202).querySelector('.msg-content')?.textContent?.trim(), 'B EXACT ANSWER');
    assert.equal(document.querySelector('[data-message-id="101"]'), null);
    assert.deepEqual(writes.map(write => [write.scope, write.rows.map(message => message.session_id)]), [[cacheKey(path), ['B']]]);
    const reads = requests.filter(url => url.pathname === '/api/messages');
    assert.deepEqual(reads.map(url => url.searchParams.get('session')), ['A', 'B', 'B']);
    assert.ok(reads.every(url => url.searchParams.get('withSession') === '1' && url.searchParams.get('limit') === '3000'));
});
}

test('resolved withSession envelope stamps real API identity through normalization, lazy VS and cache writer', options, async () => {
    offMode(); setIdentity('resolved-chat');
    const previous = serve;
    serve = async (url, init) => url.pathname === '/api/messages' ? response({ sessionId: 'resolved-chat', messages: [
        { id: 301, role: 'user', content: 'question', server_message_id: 999 },
        { id: 302, role: 'assistant', content: 'EXACT SAVED', trace_run_id: runs.A, server_message_id: 999,
            tool_log: '[{"label":"Read","detail":"retained tool"}]' },
        { id: 'browser-like-id', role: 'assistant', content: 'COMPAT STRING ID', server_message_id: 999 },
    ] }) : previous(url, init);
    await load();
    assert.equal(virtual.getVirtualScroll().active, true);
    assert.equal(row(301).dataset['messageSessionId'], 'resolved-chat');
    const answer = row(302);
    assert.equal(answer.dataset['messageSessionId'], 'resolved-chat');
    assert.equal(answer.dataset['serverMessageId'], '302');
    assert.equal(answer.dataset['traceRunId'], runs.A);
    assert.equal(answer.dataset['activitySaved'], 'true');
    assert.equal(answer.querySelector('.msg-content')?.getAttribute('data-raw'), 'EXACT SAVED');
    assert.equal(row('browser-like-id').hasAttribute('data-server-message-id'), false);
    assert.equal(row('browser-like-id').hasAttribute('data-activity-saved'), false);
    assert.deepEqual(writes[0]?.rows.map(message => [message.message_id, message.session_id, message.trace_run_id]), [
        [301, 'resolved-chat', null], [302, 'resolved-chat', runs.A], ['browser-like-id', 'resolved-chat', null],
    ]);
    assert.equal(requests.find(url => url.pathname === '/api/messages')?.searchParams.has('session'), false);
    const hydration = history.hydrateActivityHost(answer, runs.A, true); work.add(hydration); await hydration;
    assert.ok(answer.querySelector('.activity-turn'), 'loader registered the actual resolved session and loaded run');
    assert.ok(requests.filter(url => url.pathname.endsWith('/activity')).every(url => url.searchParams.get('session') === 'resolved-chat'));
});

test('old array response with an explicit requested session retains that known semantic owner', options, async () => {
    const previous = serve;
    serve = async (url, init) => url.pathname === '/api/messages' ? Response.json(rowsFor('A')) : previous(url, init);
    await load();
    assert.equal(row(101).dataset['messageSessionId'], 'A');
    const hydration = history.hydrateActivityHost(row(101), runs.A, true); work.add(hydration); await hydration;
    assert.ok(row(101).querySelector('.activity-turn'));
    assert.equal(writes[0]?.rows[0]?.session_id, 'A');
});

test('old array response without requested identity stays readable without semantic grant', options, async () => {
    offMode(); setIdentity('snapshot-chat');
    const previous = serve;
    serve = async (url, init) => url.pathname === '/api/messages' ? Response.json(rowsFor('A')) : previous(url, init);
    await load();
    const answer = row(101);
    assert.equal(answer.querySelector('.msg-content')?.getAttribute('data-raw'), 'A EXACT ANSWER');
    assert.equal(answer.hasAttribute('data-message-session-id'), false);
    const hydration = history.hydrateActivityHost(answer, runs.A, true); work.add(hydration); await hydration;
    assert.equal(requests.some(url => url.pathname.endsWith('/activity')), false);
    assert.equal(answer.querySelector('.activity-turn'), null);
    assert.equal(Object.hasOwn(writes[0]!.rows[0]!, 'session_id'), false);
});

test('offline B selects B rows, derives saved ID only from message_id and labels unknown cache separately', options, async () => {
    select('B'); setIdentity('B');
    const base = { role: 'assistant', timestamp: 1 };
    cacheRows.set(cacheKey('/2'), [
        { ...base, id: 901, message_id: 401, session_id: 'B', content: 'B SAVED', trace_run_id: runs.B },
        { ...base, id: 902, session_id: 'B', content: 'B IDB ONLY' },
        { ...base, id: 903, session_id: 'A', content: 'A FOREIGN MUST NOT RENDER', trace_run_id: runs.A },
        { ...base, id: 904, content: '<b>UNKNOWN LEGACY</b>', trace_run_id: 'tr_legacy_000000000000' },
    ]);
    const previous = serve;
    serve = async (url, init) => url.pathname === '/api/messages' ? Response.json({}, { status: 503 }) : previous(url, init);
    await load();
    assert.equal(row(401).dataset['serverMessageId'], '401');
    assert.equal(row(401).dataset['messageSessionId'], 'B');
    assert.equal(row(902).hasAttribute('data-server-message-id'), false);
    assert.equal(row(902).hasAttribute('data-activity-saved'), false);
    assert.equal(document.querySelector('[data-message-id="903"]'), null);
    assert.equal(document.querySelector('[data-message-id="904"]'), null);
    assert.equal(document.getElementById('chatMessages')!.textContent?.includes('A FOREIGN MUST NOT RENDER'), false);
    const preview = document.querySelector<HTMLElement>('.activity-legacy-cache')!;
    assert.ok(preview); assert.match(preview.textContent!, /Unverified legacy cache preview/);
    assert.equal(preview.querySelector('pre')?.textContent, '<b>UNKNOWN LEGACY</b>');
    assert.equal(preview.querySelector('b'), null);
    assert.equal(preview.querySelector('[data-message-session-id], .msg-agent'), null);
    assert.deepEqual(cacheReads, [cacheKey('/2')]); assert.deepEqual(writes, []);
    assert.equal(requests.some(url => url.pathname.endsWith('/activity')), false);
});

test('mismatched envelope session never blesses foreign text as the selected conversation', options, async () => {
    select('B'); setIdentity('B');
    const previous = serve;
    serve = async (url, init) => url.pathname === '/api/messages'
        ? response({ sessionId: 'A', messages: rowsFor('A') }) : previous(url, init);
    await load();
    assert.equal(document.querySelector('[data-message-id="101"]'), null);
    assert.deepEqual(writes, []);
    assert.equal(requests.some(url => url.pathname.endsWith('/activity')), false);
});

function blockedCache() {
    const started = Promise.withResolvers<string>();
    const release = Promise.withResolvers<CachedMessage[]>();
    readCache = target => { started.resolve(target); return release.promise; };
    const finish = () => release.resolve([{ id: 991, message_id: 601, session_id: 'A',
        role: 'assistant', content: 'EXPIRED CACHE MUST NOT APPLY', timestamp: 1, trace_run_id: runs.A }]);
    releases.push(finish);
    return { started: started.promise, finish };
}

test('HTTP failure then blocked cache expires at the loader deadline; late rows stay inert and same-view retry is fresh', options, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cache = blockedCache();
    const previous = serve;
    let signal: AbortSignal | undefined;
    serve = async (url, init) => {
        if (url.pathname !== '/api/messages') return previous(url, init);
        signal = init?.signal ?? undefined;
        return Response.json({}, { status: 503 });
    };
    const expired = load();
    assert.equal(await cache.started, cacheKey('/1'));
    assert.ok(signal); assert.equal(signal.aborted, false);
    t.mock.timers.tick(29_999); await nextTurn();
    assert.equal(loader.historyReloadInFlight(), true, 'deadline has not elapsed');
    t.mock.timers.tick(1); await nextTurn();
    assert.equal(signal.aborted, true, 'the real 30s loader timer fired');
    assert.equal(signal.reason.name, 'TimeoutError');
    assert.equal(loader.historyReloadInFlight(), false, 'blocked cache must not retain the expired singleflight');
    await expired; // Completes without releasing the blocked IDB boundary.
    cache.finish(); await nextTurn();
    assert.equal(document.querySelector('[data-message-id="601"]'), null, 'late cache cannot apply even before a new epoch starts');
    assert.deepEqual(writes, []);
    assert.equal(scope, cacheKey('/1'));
    serve = previous;
    await load();
    assert.equal(row(101).querySelector('.msg-content')?.getAttribute('data-raw'), 'A EXACT ANSWER');
    assert.equal(requests.filter(url => url.pathname === '/api/messages').length, 2, 'same-view retry must issue a new HTTP request');
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.scope, cacheKey('/1'));
    assert.equal(loader.historyReloadInFlight(), false);
});

test('cache deadline releases transcript suspension before any retry without granting unknown cache ownership', options, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cache = blockedCache(); const previous = serve;
    serve = async (url, init) => url.pathname === '/api/messages'
        ? Response.json({}, { status: 503 }) : previous(url, init);
    const expired = load(); await cache.started;
    t.mock.timers.tick(30_000); await nextTurn();
    // A real live-owned row can arrive after the failed initial transcript load.
    const message = document.createElement('div'); message.className = 'msg msg-agent';
    message.innerHTML = '<div class="agent-body"><div class="msg-content">LIVE</div></div>';
    document.getElementById('chatMessages')!.append(message); current = message;
    live.ingestLiveActivity({ version: 1, sessionId: 'A', scope: 'local:A', runId: runs.A,
        turnId: `turn-${runs.A}`, seq: 1, kind: 'turn-start', provider: 'pi' });
    const hydrate = history.hydrateActivityHost(message, runs.A, true); work.add(hydrate); await hydrate;
    assert.ok(requests.some(url => url.pathname === `/api/traces/${runs.A}/activity`),
        'deadline must release prepareActivityTranscript suspension for an independently owned live row');
    await expired;
    assert.equal(document.querySelector('[data-message-id="601"]'), null);
});

test('superseding a held cache releases old work without releasing the new view transcript suspension', options, async () => {
    const cache = blockedCache(); const previous = serve;
    serve = async (url, init) => url.pathname === '/api/messages' && url.searchParams.get('session') === 'A'
        ? Response.json({}, { status: 503 }) : previous(url, init);
    const old = load(); assert.equal(await cache.started, cacheKey('/1'));
    select('B'); setIdentity('B');
    const gate = holdPath('/api/settings', response({ workingDir }));
    const next = load(); await gate.started; await nextTurn();
    let oldSettled = false; void old.then(() => { oldSettled = true; }); await nextTurn();
    assert.equal(oldSettled, true, 'view cancellation must release cache wait without waiting for its result');
    assert.equal(loader.historyReloadInFlight(), true, 'new view still owns singleflight');
    const message = document.createElement('div'); message.className = 'msg msg-agent';
    message.innerHTML = '<div class="agent-body"><div class="msg-content">B LIVE</div></div>';
    document.getElementById('chatMessages')!.append(message); current = message;
    live.ingestLiveActivity({ version: 1, sessionId: 'B', scope: 'local:B', runId: runs.B,
        turnId: `turn-${runs.B}`, seq: 1, kind: 'turn-start', provider: 'pi' });
    const hydrate = history.hydrateActivityHost(message, runs.B, true); work.add(hydrate); await hydrate;
    assert.equal(requests.some(url => url.pathname.endsWith('/activity')), false, 'old cancellation cannot unsuspend pending B');
    cache.finish(); await nextTurn();
    assert.equal(document.querySelector('[data-message-id="601"]'), null);
    current = null; gate.finish(); await next;
    assert.equal(row(202).dataset['messageSessionId'], 'B');
    assert.equal(writes[0]?.scope, cacheKey('/2'));
    assert.equal(writes[0]?.rows[0]?.session_id, 'B');
});
