import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom, getObservedElements, getUnobservedElements } from './web-ui-test-dom.ts';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.ts';

// 241/242: real history/read/replay/live/view; only HTTP and storage are ports.
// These assertions prove scheduling and DOM ownership, not browser geometry or IDB persistence.
const identity = { sessionId: 'queue-chat', scope: 'local:queue-chat' };
const options = { timeout: 10_000 };
const response = (data: unknown) => Response.json({ ok: true, data });
let history: typeof import('../../public/js/features/activity-history.ts');
let live: typeof import('../../public/js/features/activity-live.ts');
let current: HTMLElement | null = null;
let serial = 0;
const loaded = new Set<string>();
const calls: URL[] = [];
const unexpected: string[] = [];
const pending = new Set<Promise<void>>();
const releases: Array<() => void> = [];
const terminals: string[] = [];
let serve: (url: URL, init?: RequestInit) => Promise<Response>;

mock.module('../../public/js/features/idb-cache.js', { namedExports: {
    getMessageScope: () => 'queue-cache', replaceCachedAnswer: async () => {},
} });

function runId(label: string): string { return `tr_queue_${label.padStart(16, '0')}`; }
function start(run: string): RuntimeEvent {
    return { ...identity, version: 1, runId: run, turnId: `turn-${run}`, seq: 1, kind: 'turn-start', provider: 'pi' };
}
function events(run: string): RuntimeEvent[] {
    const base = start(run);
    return [base, { ...base, seq: 2, kind: 'tool', itemId: 'read', name: `Read ${run}`, status: 'done', output: 'retained' },
        { ...base, seq: 3, kind: 'turn-end', status: 'done', finalText: 'journal preview' }];
}
function page(url: URL): Response {
    const run = url.pathname.split('/')[3]!;
    const after = Number(url.searchParams.get('after') ?? 0);
    return response({ ...identity, runId: run, status: 'done', events: events(run).filter(event => event.seq > after),
        through: 3, nextAfter: 3, hasMore: false, incomplete: false, loss: null });
}
function bareMessage(answer: string): HTMLElement {
    const node = document.createElement('div'); node.className = 'msg msg-agent';
    node.dataset['messageId'] = `local-${++serial}`;
    const body = document.createElement('div'); body.className = 'agent-body';
    const content = document.createElement('div'); content.className = 'msg-content';
    content.textContent = answer; content.dataset['raw'] = answer;
    body.append(content); node.append(body); document.getElementById('chatMessages')!.append(node);
    return node;
}
function savedMessage(run: string): HTMLElement {
    const node = bareMessage(`SAVED ${run}`);
    node.dataset['traceRunId'] = run; node.dataset['messageSessionId'] = identity.sessionId;
    node.dataset['serverMessageId'] = String(serial); node.dataset['activitySaved'] = 'true';
    loaded.add(run); history.setActivityTranscript(identity.sessionId, loaded);
    return node;
}
function hydrate(node: HTMLElement): Promise<void> {
    const promise = history.hydrateActivityHost(node, node.dataset['traceRunId']!, true);
    pending.add(promise); return promise;
}
function hold(run: string) {
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<Response>();
    const original = serve;
    let url: URL | undefined;
    serve = async (request, init) => {
        if (request.pathname === `/api/traces/${run}/activity` && request.searchParams.get('after') === '0') {
            url = request; assert.ok(init?.signal); started.resolve(init.signal);
            return release.promise; // Intentionally ignores abort: the consumer must release its queue.
        }
        return original(request, init);
    };
    const finish = () => { if (url) release.resolve(page(url)); };
    releases.push(finish);
    return { started: started.promise, finish };
}

test.before(async () => {
    setupWebUiDom();
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
        if (url.origin !== window.location.origin || (init?.method ?? 'GET') !== 'GET') unexpected.push(url.href);
        if (url.pathname === '/api/auth/token') return Response.json({ token: 'queue-fixture-token' });
        calls.push(url);
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer queue-fixture-token');
        if (url.pathname.startsWith('/api/messages/by-trace/')) return response({ message: null });
        return serve(url, init);
    });
    history = await import('../../public/js/features/activity-history.ts');
    live = await import('../../public/js/features/activity-live.ts');
    live.configureLiveActivityHost({
        currentMessage: () => current, useMessage: node => { current = node; },
        createMessage: () => bareMessage('LIVE ANSWER'), reconcileMessage: () => false,
        replaceAnswer(node, text) { const body = node.querySelector<HTMLElement>('.msg-content')!; body.textContent = text; body.dataset['raw'] = text; },
        inspectTrace() {}, closeTrace() {}, evicted: node => history.markActivityHistoryUnavailable(node),
    });
});
test.beforeEach(() => {
    current = null; loaded.clear(); calls.length = 0; unexpected.length = 0; terminals.length = 0;
    document.getElementById('chatMessages')!.replaceChildren();
    live.setLiveActivityIdentity(identity);
    history.setActivityHistoryIdentity(identity, { terminal: value => terminals.push(value.runId), refreshIdentity: async () => {} });
    history.setActivityHistoryReadReady(false);
    history.setActivityTranscript(identity.sessionId, loaded);
    serve = async url => {
        if (/^\/api\/traces\/[^/]+\/activity$/.test(url.pathname)) return page(url);
        unexpected.push(url.pathname); return Response.json({}, { status: 500 });
    };
});
test.afterEach(async () => {
    history.disposeActivityHistory();
    for (const release of releases.splice(0)) release();
    await Promise.all(pending); pending.clear();
    live.clearLiveActivity(); current = null;
    assert.deepEqual(unexpected, []);
}, options);
test.after(() => { history.disposeActivityHistory(); live.clearLiveActivity(); resetWebUiDom(); mock.restoreAll(); });

test('one held read admits at most sixteen queued hosts and recycled jobs settle without fetching', options, async () => {
    const a = savedMessage(runId('held')); const gate = hold(a.dataset['traceRunId']!);
    const first = hydrate(a); await gate.started;
    const nodes = Array.from({ length: 20 }, (_, i) => savedMessage(runId(`queued-${i}`)));
    const jobs = nodes.map(hydrate);
    assert.equal(history.hydrateActivityHost(nodes[0]!, nodes[0]!.dataset['traceRunId']!, true), jobs[0], 'same host coalesces');
    await Promise.all(jobs.slice(16));
    assert.equal(document.querySelectorAll('.activity-read-control button:disabled').length, 17);
    assert.equal(calls.filter(url => url.pathname.endsWith('/activity')).length, 1);
    for (const node of nodes.slice(16)) assert.match(node.textContent!, /reads are at their limit/);
    const recycled = nodes[4]!;
    history.recycleActivityHistory(recycled); recycled.remove();
    await jobs[4]; // Must settle while A's uncooperative fetch is still held.
    gate.finish(); await first; await Promise.all(jobs);
    const fetchedRuns = calls.filter(url => url.pathname.endsWith('/activity')).map(url => url.pathname.split('/')[3]);
    assert.equal(fetchedRuns.includes(recycled.dataset['traceRunId']), false);
    for (const node of nodes.slice(16)) assert.equal(fetchedRuns.includes(node.dataset['traceRunId']), false);
    assert.equal(new Set(fetchedRuns).size, 16);
    assert.ok(nodes[15]!.querySelector('.activity-turn'), 'last admitted queue member completes');
});

test('unrelated live B renders while historical A is held and remains the current host', options, async () => {
    const a = savedMessage(runId('history-A')); const gate = hold(a.dataset['traceRunId']!);
    const reading = hydrate(a); await gate.started;
    const bRun = runId('live-B');
    live.ingestLiveActivity(start(bRun));
    const b = current!;
    live.ingestLiveActivity({ ...start(bRun), seq: 2, kind: 'tool', itemId: 'live-B-tool', name: 'B VISIBLE NOW', status: 'running' });
    assert.match(b.querySelector('.activity-turn')!.textContent!, /B VISIBLE NOW/);
    assert.equal(a.querySelector('.activity-turn'), null);
    gate.finish(); await reading;
    assert.equal(current, b);
    assert.equal(b.dataset['traceRunId'], bRun);
    assert.equal(b.querySelector('.msg-content')?.textContent, 'LIVE ANSWER');
    assert.deepEqual(terminals, [a.dataset['traceRunId']]);
});

test('external recycle cancels the active barrier and lets B finish before uncooperative A resolves', options, async () => {
    const a = savedMessage(runId('cancel-A')); const gate = hold(a.dataset['traceRunId']!);
    const readingA = hydrate(a); const signal = await gate.started;
    const b = savedMessage(runId('after-cancel-B')); const readingB = hydrate(b);
    history.recycleActivityHistory(a); a.remove();
    await readingA; await readingB;
    assert.equal(signal.aborted, true);
    assert.ok(b.querySelector('.activity-turn'));
    assert.deepEqual(terminals, [b.dataset['traceRunId']]);
    gate.finish();
    await hydrate(savedMessage(runId('after-late-A')));
    assert.equal(a.querySelector('.activity-turn'), null);
    assert.equal(terminals.includes(a.dataset['traceRunId']!), false);
});

test('SSE suspension releases retained queued controls for manual retry without discarding observation', options, async () => {
    const a = savedMessage(runId('outage-active-A'));
    const b = savedMessage(runId('outage-queued-B'));
    history.setActivityHistoryReadReady(true);
    const gate = hold(a.dataset['traceRunId']!);
    const readingA = hydrate(a); await gate.started;
    const readingB = hydrate(b);
    const retry = b.querySelector<HTMLButtonElement>('.activity-read-control button')!;
    assert.equal(retry.disabled, true);
    history.setActivityHistoryReadReady(false);
    await readingA; await readingB;
    assert.equal(retry.disabled, false, 'a cancelled queued job never enters execute finally');
    assert.doesNotMatch(b.querySelector('.activity-read-control')!.textContent!, /queued|Loading/);
    assert.equal(getUnobservedElements().includes(b), false, 'retained rows must still receive future viewport demand');
    assert.ok(getObservedElements().includes(b));
    retry.click();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(b.querySelector('.activity-turn'), 'actual enabled button can read while SSE automatic admission stays down');
    assert.deepEqual(terminals, [b.dataset['traceRunId']]);
    assert.equal(a.querySelector('.activity-turn'), null, 'the aborted uncooperative A did not need to resolve');
});

for (const admission of ['live', 'history'] as const) {
    test(`${admission} admission protects focused terminal and evicts a recycled offscreen terminal first`, options, async () => {
        const nodes: HTMLElement[] = [];
        for (let i = 0; i < 16; i++) {
            const run = runId(`retained-${i}`);
            live.ingestLiveActivity(start(run), false);
            nodes.push(current!);
            live.ingestLiveActivity({ ...start(run), seq: 2, kind: 'turn-end', status: 'done', finalText: '' });
        }
        const focused = nodes[0]!.querySelector<HTMLElement>('.activity-summary')!;
        focused.focus(); assert.equal(document.activeElement, focused);
        const offscreen = nodes[6]!;
        history.recycleActivityHistory(offscreen); offscreen.remove();
        const next = runId(`replacement-${admission}`);
        if (admission === 'live') live.ingestLiveActivity(start(next), false);
        else await hydrate(savedMessage(next));
        assert.equal(document.activeElement, focused);
        assert.ok(nodes[0]!.querySelector('.activity-turn'));
        assert.ok(nodes[1]!.querySelector('.activity-turn'), 'an earlier connected unfocused turn is not preferred over offscreen');
        assert.equal(offscreen.hasAttribute('data-activity-key'), false);
        assert.equal(document.querySelectorAll('.activity-turn').length, 16);
    });
}

test('nested copied msg-agent markers never authorize a read or steal the real live host', options, async () => {
    const run = runId('spoof'); live.ingestLiveActivity(start(run));
    const real = current!; loaded.add(run); history.setActivityTranscript(identity.sessionId, loaded);
    const spoof = real.cloneNode(true) as HTMLElement;
    spoof.querySelector('.activity-read-control')?.remove();
    real.querySelector('.msg-content')!.append(spoof);
    history.observeActivityHistory(document.getElementById('chatMessages')!);
    await history.hydrateActivityHost(spoof, run, true);
    assert.deepEqual(calls, []);
    assert.equal(spoof.querySelector('.activity-read-control'), null);
    live.ingestLiveActivity({ ...start(run), seq: 2, kind: 'tool', itemId: 'real-only', name: 'REAL HOST ONLY', status: 'running' });
    const realActivity = real.querySelector(':scope > .agent-body > .activity-turn');
    assert.ok(realActivity, 'a copied nested key cannot move the real Activity view');
    assert.match(realActivity.textContent!, /REAL HOST ONLY/);
    assert.equal(spoof.textContent?.includes('REAL HOST ONLY'), false);
});

test('closed discovery lists descriptors but does not observe or fetch their payload until disclosure', options, async () => {
    const run = runId('discovered');
    const original = serve;
    serve = async (url, init) => url.pathname === '/api/traces/activity-runs'
        ? response({ runs: [{ id: run, messageId: null, status: 'done', startedAt: 1 }], pageSize: 40 }) : original(url, init);
    history.setActivityHistoryReadReady(true);
    await history.discoverActivityHistory();
    const panel = document.getElementById('activityDiscovery') as HTMLDetailsElement;
    const row = panel.querySelector<HTMLElement>('.activity-recorded-run')!;
    assert.equal(panel.open, false);
    history.observeActivityHistory(panel);
    assert.equal(getObservedElements().includes(row), false);
    assert.deepEqual(calls.map(url => url.pathname), ['/api/traces/activity-runs']);
    panel.open = true; panel.dispatchEvent(new window.Event('toggle'));
    assert.equal(getObservedElements().includes(row), true);
    await hydrate(row); // Deterministic user inspection after the real disclosure event.
    assert.ok(row.querySelector('.activity-turn'));
    assert.ok(calls.some(url => url.pathname === `/api/traces/${run}/activity`));
});
