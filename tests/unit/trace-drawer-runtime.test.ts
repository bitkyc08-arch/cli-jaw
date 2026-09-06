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
    return new Promise(resolve => setTimeout(resolve, 0));
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

test.afterEach(() => {
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
