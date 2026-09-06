import test from 'node:test';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const PROVIDER_ICONS_PATH = resolve(ROOT, 'public/js/provider-icons.js');
const originalFetch = globalThis.fetch;
async function selectSession(id: string): Promise<void> {
    const { configureSessionView } = await import('../../public/js/features/session-hub.ts');
    configureSessionView({ active: id, sessions: [{ id, seq: 1, label: null, message_count: 0, source: 'local', remoteKey: null }] }, '/1');
}

mock.module(PROVIDER_ICONS_PATH, {
    namedExports: {
        providerLabel: (slug: string) => slug,
    },
});

function jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

function apiData(data: unknown): Response {
    return jsonResponse({ ok: true, data });
}

function installScrollIntoView(): void {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: () => { /* noop for jsdom */ },
    });
}

function nextTick(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

function deferredResponse(): {
    promise: Promise<Response>;
    resolve: (response: Response) => void;
} {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

test.afterEach(async () => {
    const { closeTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    closeTraceDrawer();
    globalThis.fetch = originalFetch;
    resetWebUiDom();
});

test('closing a pending drawer invalidates its response and restores focus', async () => {
    setupWebUiDom(); installScrollIntoView();
    const pending = deferredResponse();
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (input, init) => {
        if (String(input) === '/api/auth/token') return jsonResponse({ token: '' });
        signal = init?.signal; return pending.promise;
    }) as typeof fetch;
    const button = document.getElementById('btnSend')!; button.focus();
    const { openTraceDrawer, closeTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    const opened = openTraceDrawer('tr_pending', 1, 'owner');
    await nextTick(); closeTraceDrawer();
    assert.equal(signal?.aborted, true); assert.equal(document.activeElement, button);
    pending.resolve(apiData({ id: 'tr_pending', cli: 'late', eventCount: 1 }));
    await opened;
    assert.equal(document.getElementById('traceDrawerOverlay')?.classList.contains('open'), false);
    assert.equal(document.getElementById('traceEventList')?.children.length, 0);
});

for (const invalidation of ['none', 'session', 'detached', 'new-intent'] as const) {
    test(`trace trigger captures raw server identity and discards ${invalidation} invalidation`, async () => {
        setupWebUiDom(); installScrollIntoView();
        const pending = deferredResponse(), calls: string[] = [];
        let snapshots = 0;
        globalThis.fetch = (async input => {
            const url = String(input); calls.push(url);
            if (url === '/api/auth/token') return jsonResponse({ token: '' });
            if (url.startsWith('/api/orchestrate/snapshot')) {
                snapshots++; return snapshots === 1 ? pending.promise : jsonResponse({ activityIdentity: { sessionId: 'second-owner', scope: 'default' } });
            }
            if (url.includes('/events/7?')) return apiData({ runId: 'tr_trigger', seq: 7, source: 'tool', raw: 'TRIGGER_RAW' });
            if (url.includes('/events?')) return apiData({ total: 1, events: [{ seq: 7, source: 'tool', eventType: 'tool', preview: 'trigger detail' }] });
            if (url.startsWith('/api/traces/')) return apiData({ id: 'tr_trigger', cli: 'fixture', model: 'fixture',
                agentLabel: 'main', status: 'done', rawRetentionStatus: 'available', eventCount: 1, byteCount: 100, startedAt: 1 });
            throw new Error(`unexpected fetch ${url}`);
        }) as typeof fetch;
        await selectSession('view-one');
        const { bindProcessBlockInteractions } = await import('../../public/js/features/process-block.ts');
        const root = document.createElement('div');
        root.innerHTML = '<button class="process-step-trace" data-trace-run-id="tr_trigger">Open trace</button>';
        document.body.append(root); bindProcessBlockInteractions(root);
        const button = root.querySelector('button')!; button.click();
        for (let i = 0; i < 20 && snapshots === 0; i++) await nextTick();
        assert.equal(snapshots, 1);
        if (invalidation === 'session') await selectSession('view-two');
        if (invalidation === 'detached') root.remove();
        if (invalidation === 'new-intent') button.click();
        pending.resolve(jsonResponse({ activityIdentity: { sessionId: 'server-owner', scope: 'default' } }));
        for (let i = 0; i < 20; i++) await nextTick();
        assert.ok(calls.includes('/api/orchestrate/snapshot?session=view-one'));
        const reads = calls.filter(path => path.startsWith('/api/traces/'));
        if (invalidation === 'none') {
            assert.equal(reads.length, 3); assert.ok(reads.every(path => path.includes('session=server-owner')));
            assert.equal(document.getElementById('traceEventRaw')?.textContent, 'TRIGGER_RAW');
        } else if (invalidation === 'new-intent') {
            assert.equal(reads.length, 3); assert.ok(reads.every(path => path.includes('session=second-owner')));
            assert.equal(document.getElementById('traceEventRaw')?.textContent, 'TRIGGER_RAW');
        } else assert.deepEqual(reads, []);
        const { closeTraceDrawer } = await import('../../public/js/features/trace-drawer.ts'); closeTraceDrawer();
    });
}

test('openTraceDrawer uses retained row offsets independently of sparse seq and carries the explicit owner', async () => {
    setupWebUiDom();
    installScrollIntoView();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === '/api/auth/token') return jsonResponse({ token: '' });
        if (url === '/api/traces/tr_run?session=owner%2Fone') {
            return apiData({
                id: 'tr_run',
                cli: 'codex',
                model: 'gpt-test',
                agentLabel: 'agent',
                status: 'running',
                rawRetentionStatus: 'available',
                eventCount: 145,
                byteCount: 1000,
                startedAt: 1,
            });
        }
        if (url === '/api/traces/tr_run/events?offset=0&limit=80&session=owner%2Fone') {
            return apiData({
                total: 145,
                events: [
                    { seq: 81, source: 'agent', eventType: 'message', preview: 'page start' },
                    { seq: 143, source: 'tool', eventType: 'tool', preview: 'clicked event' },
                ],
            });
        }
        if (url === '/api/traces/tr_run/events/143?session=owner%2Fone') {
            return apiData({
                runId: 'tr_run',
                seq: 143,
                source: 'tool',
                eventType: 'tool',
                preview: 'clicked event',
                raw: 'RAW-143',
            });
        }
        throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const { openTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    await openTraceDrawer('tr_run', 143, 'owner/one');
    await nextTick();

    assert.ok(calls.includes('/api/traces/tr_run/events?offset=0&limit=80&session=owner%2Fone'));
    assert.ok(calls.includes('/api/traces/tr_run/events/143?session=owner%2Fone'));
    assert.equal(document.getElementById('traceEventRaw')?.textContent, 'RAW-143');
    const selected = document.querySelector<HTMLElement>('.trace-event-row[aria-current="true"]');
    assert.equal(selected?.dataset['seq'], '143');
    assert.equal(selected?.dataset['runId'], 'tr_run');
});

test('stale trace open responses cannot overwrite the newer clicked trace', async () => {
    setupWebUiDom();
    installScrollIntoView();
    const summaryA = deferredResponse();
    const summaryB = deferredResponse();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === '/api/auth/token') return jsonResponse({ token: '' });
        if (url === '/api/traces/tr_a') return summaryA.promise;
        if (url === '/api/traces/tr_b') return summaryB.promise;
        if (url === '/api/traces/tr_b/events?offset=0&limit=80') {
            return apiData({
                total: 10,
                events: [{ seq: 6, source: 'tool', eventType: 'tool', preview: 'new event' }],
            });
        }
        if (url === '/api/traces/tr_b/events/6') {
            return apiData({
                runId: 'tr_b',
                seq: 6,
                source: 'tool',
                eventType: 'tool',
                preview: 'new event',
                raw: 'RAW-B',
            });
        }
        throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const { openTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    const oldOpen = openTraceDrawer('tr_a', 5);
    const newOpen = openTraceDrawer('tr_b', 6);

    summaryB.resolve(apiData({
        id: 'tr_b',
        cli: 'codex',
        model: 'gpt-test',
        agentLabel: 'new',
        status: 'running',
        rawRetentionStatus: 'available',
        eventCount: 10,
        byteCount: 100,
        startedAt: 2,
    }));
    await newOpen;
    await nextTick();
    assert.equal(document.getElementById('traceEventRaw')?.textContent, 'RAW-B');

    summaryA.resolve(apiData({
        id: 'tr_a',
        cli: 'codex',
        model: 'gpt-test',
        agentLabel: 'old',
        status: 'running',
        rawRetentionStatus: 'available',
        eventCount: 10,
        byteCount: 100,
        startedAt: 1,
    }));
    await oldOpen;
    await nextTick();

    assert.equal(document.getElementById('traceEventRaw')?.textContent, 'RAW-B');
    assert.equal(document.querySelector<HTMLElement>('.trace-event-row')?.dataset['runId'], 'tr_b');
    assert.equal(calls.includes('/api/traces/tr_a/events?offset=0&limit=80'), false);
});

const PAGER_RUN = 'tr_pager_fixture_00000001';
const OTHER_RUN = 'tr_pager_fixture_00000002';
const OWNER = 'trace-owner/one';
const retainedRows = Array.from({ length: 161 }, (_, index) => ({
    run_id: PAGER_RUN, seq: 17 + index * 7, source: 'tool', event_type: 'tool_result',
    preview: `Retained row ${index}`, bytes: 20, retention_status: 'available', created_at: 1,
}));
function summary(runId: string) {
    return { id: runId, cli: 'cursor', model: 'fixture', agentLabel: runId, status: 'done',
        rawRetentionStatus: 'available', eventCount: 161, byteCount: 3220, startedAt: 1 };
}
function rawDetail(runId: string, seq: number) {
    return { runId, seq, source: 'tool', eventType: 'tool_result', preview: 'retained', bytes: 20,
        retentionStatus: 'available', createdAt: 1, raw: `RAW:${runId}:${seq}` };
}
function pagerFixture() {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    let override: ((url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) | undefined;
    globalThis.fetch = (async (input, init) => {
        const url = new URL(String(input), 'http://fixture');
        if (url.pathname === '/api/auth/token') return jsonResponse({ token: 'trace-fixture-token' });
        calls.push({ url, init });
        const intercepted = override?.(url, init);
        if (intercepted) return intercepted;
        const match = /^\/api\/traces\/(tr_[\w-]+)(?:\/events(?:\/(\d+))?)?$/.exec(url.pathname);
        assert.ok(match, `Unexpected fixture request ${url}`);
        const runId = match[1]!;
        if (match[2]) return apiData(rawDetail(runId, Number(match[2])));
        if (url.pathname.endsWith('/events')) {
            assert.equal(url.searchParams.get('limit'), '80');
            const offset = Number(url.searchParams.get('offset'));
            return apiData({ total: retainedRows.length,
                events: retainedRows.slice(offset, offset + 80).map(row => ({ ...row, run_id: runId })) });
        }
        return apiData(summary(runId));
    }) as typeof fetch;
    return { calls, intercept(next: typeof override) { override = next; } };
}
async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 1000; i++) {
        if (check()) return;
        await nextTick();
    }
    assert.fail('Trace drawer did not reach the expected DOM state');
}
function pagerButton(name: string): HTMLButtonElement {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.trace-drawer-footer button')]
        .find(node => node.textContent === name);
    assert.ok(button, `Missing ${name} pager button`);
    return button;
}
const mountedSeqs = () => [...document.querySelectorAll<HTMLElement>('.trace-event-row')]
    .map(row => Number(row.dataset['seq']));
const pageStatus = () => document.querySelector('.trace-page-status')?.textContent ?? '';

test('existing raw-page click path never accumulates a second 80-row page', async () => {
    setupWebUiDom(); installScrollIntoView();
    pagerFixture();
    const { openTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    await openTraceDrawer(PAGER_RUN, undefined, OWNER);
    document.querySelector<HTMLButtonElement>('.trace-load-more')!.click();
    await until(() => mountedSeqs().includes(retainedRows[80]!.seq));
    assert.equal(mountedSeqs().length, 80);
});

test('161 sparse retained rows replace pages forward/back, preserve one selected detail and return pager focus', async () => {
    setupWebUiDom(); installScrollIntoView();
    const fixture = pagerFixture();
    const { openTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    const seq = retainedRows[85]!.seq;
    await openTraceDrawer(PAGER_RUN, seq, OWNER);
    await until(() => document.getElementById('traceEventRaw')?.textContent === `RAW:${PAGER_RUN}:${seq}`);
    assert.deepEqual(mountedSeqs(), retainedRows.slice(0, 80).map(row => row.seq));
    assert.equal(pagerButton('Previous').disabled, true);
    for (const [name, offset, length] of [['Next', 80, 80], ['Next', 160, 1], ['Previous', 80, 80], ['Previous', 0, 80]] as const) {
        const clicked = pagerButton(name); clicked.focus(); clicked.click();
        await until(() => mountedSeqs()[0] === retainedRows[offset]!.seq);
        assert.deepEqual(mountedSeqs(), retainedRows.slice(offset, offset + length).map(row => row.seq));
        assert.ok(mountedSeqs().length <= 80);
        assert.equal(document.querySelectorAll('#traceEventRaw').length, 1);
        assert.equal(document.getElementById('traceEventRaw')?.textContent, `RAW:${PAGER_RUN}:${seq}`);
        assert.equal(document.querySelector<HTMLElement>('.trace-event-row[aria-current="true"]')?.dataset['seq'],
            offset === 80 ? String(seq) : undefined);
        assert.equal(document.activeElement, offset === 160 ? pagerButton('Previous')
            : offset === 0 ? pagerButton('Next') : clicked);
    }
    assert.deepEqual(fixture.calls.filter(call => call.url.pathname.endsWith('/events'))
        .map(call => Number(call.url.searchParams.get('offset'))), [0, 80, 160, 80, 0]);
    assert.equal(fixture.calls.filter(call => /\/events\/\d+$/.test(call.url.pathname)).length, 1);
    assert.ok(fixture.calls.every(call => call.url.searchParams.get('session') === OWNER));
    assert.ok(fixture.calls.every(call => new Headers(call.init?.headers).get('Authorization') === 'Bearer trace-fixture-token'));
});

test('failed page leaves the displayed rows and selected raw intact and retries the same offset', async () => {
    setupWebUiDom(); installScrollIntoView();
    const fixture = pagerFixture();
    const { openTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    await openTraceDrawer(PAGER_RUN, retainedRows[3]!.seq, OWNER);
    await until(() => document.getElementById('traceEventRaw')?.textContent === `RAW:${PAGER_RUN}:${retainedRows[3]!.seq}`);
    const before = document.getElementById('traceEventList')!.innerHTML;
    const raw = document.getElementById('traceEventRaw')!.textContent;
    fixture.intercept(url => url.searchParams.get('offset') === '80'
        ? new Response('unavailable', { status: 503 }) : undefined);
    pagerButton('Next').click();
    await until(() => /could not be loaded/i.test(pageStatus()));
    assert.equal(document.getElementById('traceEventList')!.innerHTML, before);
    assert.equal(document.getElementById('traceEventRaw')!.textContent, raw);
    assert.equal(pagerButton('Retry').hidden, false);
    fixture.intercept(undefined); pagerButton('Retry').focus(); pagerButton('Retry').click();
    await until(() => mountedSeqs()[0] === retainedRows[80]!.seq);
    assert.equal(mountedSeqs().length, 80); assert.equal(pagerButton('Retry').hidden, true);
    assert.equal(document.activeElement, pagerButton('Next'));
    assert.deepEqual(fixture.calls.filter(call => call.url.pathname.endsWith('/events'))
        .map(call => call.url.searchParams.get('offset')), ['0', '80', '80']);
});

for (const invalidation of ['new-open', 'close'] as const) test(`pending page/detail cannot repaint after ${invalidation}`, async () => {
    setupWebUiDom(); installScrollIntoView();
    const fixture = pagerFixture();
    const { openTraceDrawer, closeTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    const trigger = document.getElementById('btnSend')!; trigger.focus();
    await openTraceDrawer(PAGER_RUN, retainedRows[0]!.seq, OWNER);
    const page = deferredResponse(), detail = deferredResponse();
    const signals: Array<AbortSignal | null | undefined> = [];
    fixture.intercept((url, init) => {
        if (url.searchParams.get('offset') === '80' && url.pathname.includes(PAGER_RUN)) {
            signals.push(init?.signal); return page.promise;
        }
        if (url.pathname === `/api/traces/${PAGER_RUN}/events/${retainedRows[1]!.seq}`) {
            signals.push(init?.signal); return detail.promise;
        }
    });
    document.querySelectorAll<HTMLButtonElement>('.trace-event-row')[1]!.click();
    pagerButton('Next').click(); await until(() => signals.length === 2);
    if (invalidation === 'new-open') await openTraceDrawer(OTHER_RUN, retainedRows[0]!.seq, 'other-owner');
    else closeTraceDrawer();
    assert.ok(signals.every(signal => signal?.aborted));
    const before = document.getElementById('traceDrawerOverlay')!.innerHTML;
    page.resolve(apiData({ total: 161, events: retainedRows.slice(80, 160) }));
    detail.resolve(apiData(rawDetail(PAGER_RUN, retainedRows[1]!.seq)));
    await nextTick(); await nextTick();
    assert.equal(document.getElementById('traceDrawerOverlay')!.innerHTML, before);
    if (invalidation === 'close') assert.equal(document.activeElement, trigger);
    else assert.ok(fixture.calls.filter(call => call.url.pathname.includes(OTHER_RUN))
        .every(call => call.url.searchParams.get('session') === 'other-owner'));
});

test('new open clears old metadata while its summary is pending, including failure', async () => {
    setupWebUiDom(); installScrollIntoView();
    const fixture = pagerFixture();
    const { openTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    await openTraceDrawer(PAGER_RUN, undefined, OWNER);
    assert.match(document.getElementById('traceDrawerMeta')!.textContent!, new RegExp(PAGER_RUN));
    const summaryRead = deferredResponse(); fixture.intercept(url => url.pathname === `/api/traces/${OTHER_RUN}` ? summaryRead.promise : undefined);
    const opening = openTraceDrawer(OTHER_RUN, undefined, 'other-owner');
    assert.equal(document.getElementById('traceDrawerMeta')!.textContent, '');
    assert.equal(document.getElementById('traceDrawerTitle')!.textContent, 'Trace');
    assert.deepEqual(mountedSeqs(), []);
    summaryRead.resolve(new Response('', { status: 404 })); await opening;
    assert.equal(document.getElementById('traceDrawerMeta')!.textContent, '');
    assert.equal(pagerButton('Previous').disabled, true); assert.equal(pagerButton('Next').disabled, true);
});

for (const stage of ['headers', 'body'] as const) test(`page ${stage} deadline uses the existing 15s bound and remains retryable`, async t => {
    setupWebUiDom(); installScrollIntoView();
    const fixture = pagerFixture();
    const { openTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    await openTraceDrawer(PAGER_RUN, undefined, OWNER);
    const deadline = new AbortController();
    t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 15_000); return deadline.signal; });
    let entered = false, cancelled = false;
    let signal: AbortSignal | null | undefined;
    fixture.intercept((url, init) => {
        if (url.searchParams.get('offset') !== '80') return;
        entered = true; signal = init?.signal;
        if (stage === 'headers') return new Promise<Response>(() => {});
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
    });
    pagerButton('Next').click(); await until(() => entered); await nextTick();
    deadline.abort(new DOMException('Owned deadline', 'TimeoutError'));
    await until(() => /could not be loaded/i.test(pageStatus()));
    assert.equal(signal?.aborted, true); if (stage === 'body') assert.equal(cancelled, true);
    assert.deepEqual(mountedSeqs(), retainedRows.slice(0, 80).map(row => row.seq));
    t.mock.restoreAll(); fixture.intercept(undefined); pagerButton('Retry').click();
    await until(() => mountedSeqs()[0] === retainedRows[80]!.seq);
});

test('raw page over 16MiB is cancelled before replacing the mounted page', async () => {
    setupWebUiDom(); installScrollIntoView();
    const fixture = pagerFixture();
    const { openTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    await openTraceDrawer(PAGER_RUN, undefined, OWNER);
    let cancelled = false;
    fixture.intercept(url => url.searchParams.get('offset') === '80' ? new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); },
        cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } }) : undefined);
    pagerButton('Next').click(); await until(() => /could not be loaded/i.test(pageStatus()));
    assert.equal(cancelled, true); assert.equal(mountedSeqs().length, 80);
    assert.equal(mountedSeqs()[0], retainedRows[0]!.seq); assert.equal(pagerButton('Retry').hidden, false);
});

test('initial page failure can retry offset zero and select its first sparse event', async () => {
    setupWebUiDom(); installScrollIntoView();
    const fixture = pagerFixture();
    fixture.intercept(url => url.pathname.endsWith('/events') ? new Response('', { status: 503 }) : undefined);
    const { openTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    await openTraceDrawer(PAGER_RUN, undefined, OWNER);
    assert.deepEqual(mountedSeqs(), []); assert.match(pageStatus(), /could not be loaded/);
    assert.equal(pagerButton('Next').disabled, true);
    fixture.intercept(undefined); pagerButton('Retry').click();
    await until(() => document.getElementById('traceEventRaw')?.textContent === `RAW:${PAGER_RUN}:${retainedRows[0]!.seq}`);
    assert.equal(mountedSeqs().length, 80);
    assert.equal(document.querySelector<HTMLElement>('.trace-event-row[aria-current="true"]')?.dataset['seq'], String(retainedRows[0]!.seq));
    assert.deepEqual(fixture.calls.filter(call => call.url.pathname.endsWith('/events'))
        .map(call => call.url.searchParams.get('offset')), ['0', '0']);
});

test('detail selection races stay independent of paging and abort the replaced detail', async () => {
    setupWebUiDom(); installScrollIntoView();
    const fixture = pagerFixture();
    const { openTraceDrawer } = await import('../../public/js/features/trace-drawer.ts');
    await openTraceDrawer(PAGER_RUN, undefined, OWNER);
    const pending = deferredResponse(); let oldSignal: AbortSignal | null | undefined;
    const oldSeq = retainedRows[1]!.seq, currentSeq = retainedRows[2]!.seq;
    fixture.intercept((url, init) => {
        if (url.pathname === `/api/traces/${PAGER_RUN}/events/${oldSeq}`) {
            oldSignal = init?.signal; return pending.promise;
        }
    });
    document.querySelectorAll<HTMLButtonElement>('.trace-event-row')[1]!.click(); await until(() => !!oldSignal);
    document.querySelectorAll<HTMLButtonElement>('.trace-event-row')[2]!.click();
    await until(() => document.getElementById('traceEventRaw')?.textContent === `RAW:${PAGER_RUN}:${currentSeq}`);
    assert.equal(oldSignal?.aborted, true);
    pagerButton('Next').click(); pagerButton('Next').click();
    await until(() => mountedSeqs()[0] === retainedRows[80]!.seq);
    pending.resolve(apiData(rawDetail(PAGER_RUN, oldSeq))); await nextTick(); await nextTick();
    assert.equal(document.getElementById('traceEventRaw')?.textContent, `RAW:${PAGER_RUN}:${currentSeq}`);
    pagerButton('Previous').click(); await until(() => mountedSeqs()[0] === retainedRows[0]!.seq);
    assert.equal(document.querySelector<HTMLElement>('.trace-event-row[aria-current="true"]')?.dataset['seq'], String(currentSeq));
    assert.deepEqual(fixture.calls.filter(call => call.url.pathname.endsWith('/events'))
        .map(call => call.url.searchParams.get('offset')), ['0', '80', '0']);
});
