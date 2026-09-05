import test from 'node:test';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const PROVIDER_ICONS_PATH = resolve(ROOT, 'public/js/provider-icons.js');
const originalFetch = globalThis.fetch;

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

test('openTraceDrawer selects sparse seq directly without treating it as a row offset', async () => {
    setupWebUiDom();
    installScrollIntoView();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === '/api/auth/token') return jsonResponse({ token: '' });
        if (url === '/api/traces/tr_run') {
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
        if (url === '/api/traces/tr_run/events?offset=0&limit=80') {
            return apiData({
                total: 145,
                events: [
                    { seq: 81, source: 'agent', eventType: 'message', preview: 'page start' },
                    { seq: 143, source: 'tool', eventType: 'tool', preview: 'clicked event' },
                ],
            });
        }
        if (url === '/api/traces/tr_run/events/143') {
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
    await openTraceDrawer('tr_run', 143);
    await nextTick();

    assert.ok(calls.includes('/api/traces/tr_run/events?offset=0&limit=80'));
    assert.equal(calls.includes('/api/traces/tr_run/events?offset=80&limit=80'), false);
    assert.equal(document.getElementById('traceEventRaw')?.textContent, 'RAW-143');
    const selected = document.querySelector<HTMLElement>('.trace-event-row[aria-current="true"]');
    assert.equal(selected?.dataset['seq'], '143');
    assert.equal(selected?.dataset['runId'], 'tr_run');
});

test('summary, page and detail retain the session captured before an awaited open', async () => {
    setupWebUiDom(); installScrollIntoView();
    let sessionId = 'chat-old';
    const summary = deferredResponse();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input); calls.push(url);
        if (url === '/api/auth/token') return jsonResponse({token:''});
        if (url === '/api/traces/tr_owned?session=chat-old') return summary.promise;
        if (url === '/api/traces/tr_owned/events?offset=0&limit=80&session=chat-old') {
            return apiData({total:1,events:[{seq:900,source:'runtime',eventType:'tool',preview:'safe'}]});
        }
        if (url === '/api/traces/tr_owned/events/900?session=chat-old') return apiData({runId:'tr_owned',seq:900,raw:'OWNED'});
        throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const {openTraceDrawer} = await import('../../public/js/features/trace-drawer.ts');
    const pending = openTraceDrawer('tr_owned',900,sessionId);
    sessionId = 'chat-new';
    summary.resolve(apiData({id:'tr_owned',cli:'pi',model:'test',agentLabel:'agent',eventCount:1,byteCount:1,startedAt:1,rawRetentionStatus:'available',status:'done'}));
    await pending; await nextTick();
    assert.equal(document.getElementById('traceEventRaw')?.textContent,'OWNED');
    assert.equal(calls.filter(url=>url.startsWith('/api/traces/')).length,3);
    assert.ok(calls.filter(url=>url.startsWith('/api/traces/')).every(url=>url.includes('session=chat-old')));
    assert.equal(sessionId,'chat-new');
});

test('closing the drawer cancels its read and ignores a late result', async () => {
    setupWebUiDom(); installScrollIntoView();
    const response = deferredResponse();
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/auth/token') return jsonResponse({token:''});
        signal = init?.signal;
        return response.promise;
    }) as typeof fetch;
    const drawer = await import('../../public/js/features/trace-drawer.ts');
    const pending = drawer.openTraceDrawer('tr_closed',undefined,'chat');
    await nextTick();
    document.querySelector<HTMLButtonElement>('.trace-drawer-close')!.click();
    assert.equal(signal?.aborted,true);
    response.resolve(apiData({id:'tr_closed',cli:'pi',eventCount:1,status:'done'}));
    await pending;
    assert.equal(document.querySelector('#traceDrawerOverlay.open'),null);
    assert.equal(document.querySelector('.trace-event-row'),null);
});

test('the existing process Trace control resolves a server-owned default session before opening', async () => {
    setupWebUiDom(); installScrollIntoView();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input); calls.push(url);
        if (url === '/api/auth/token') return jsonResponse({token:''});
        if (url === '/api/orchestrate/snapshot') return apiData({activityIdentity:{sessionId:'server-active',scope:'remote:scope'}});
        if (url === '/api/traces/tr_clicked?session=server-active') return apiData({id:'tr_clicked',cli:'pi',model:'test',agentLabel:'agent',eventCount:0,byteCount:0,startedAt:1,rawRetentionStatus:'available',status:'done'});
        if (url.includes('/events?offset=0&limit=80&session=server-active')) return apiData({total:0,events:[]});
        throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const {bindProcessBlockInteractions} = await import('../../public/js/features/process-block.ts');
    const root = document.createElement('div');
    root.innerHTML = '<button class="process-step-trace" data-trace-run-id="tr_clicked" data-trace-seq="0">Trace</button>';
    document.body.append(root); bindProcessBlockInteractions(root);
    root.querySelector<HTMLButtonElement>('button')!.click();
    // Lazy import then JSON body consumption complete before this event-loop boundary.
    await nextTick(); await nextTick();
    assert.ok(calls.includes('/api/traces/tr_clicked?session=server-active'));
    assert.ok(calls.includes('/api/traces/tr_clicked/events?offset=0&limit=80&session=server-active'));
});

test('a late snapshot from earlier Trace click cannot reopen it over a newer click', async () => {
    setupWebUiDom(); installScrollIntoView();
    const snapshots = [deferredResponse(),deferredResponse()];
    const calls: string[] = []; let index = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input); calls.push(url);
        if (url === '/api/auth/token') return jsonResponse({token:''});
        if (url === '/api/orchestrate/snapshot') return snapshots[index++]!.promise;
        if (url === '/api/traces/tr_second?session=chat') return apiData({id:'tr_second',cli:'pi',model:'test',agentLabel:'agent',eventCount:0,byteCount:0,startedAt:1,rawRetentionStatus:'available',status:'done'});
        if (url.includes('/tr_second/events?')) return apiData({total:0,events:[]});
        throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const {bindProcessBlockInteractions} = await import('../../public/js/features/process-block.ts');
    const root = document.createElement('div');
    root.innerHTML = '<button class="process-step-trace" data-trace-run-id="tr_first">First</button><button class="process-step-trace" data-trace-run-id="tr_second">Second</button>';
    document.body.append(root); bindProcessBlockInteractions(root);
    const buttons = root.querySelectorAll<HTMLButtonElement>('button');
    buttons[0]!.click(); buttons[1]!.click(); await nextTick();
    snapshots[1]!.resolve(apiData({activityIdentity:{sessionId:'chat',scope:'default'}}));
    await nextTick(); await nextTick();
    snapshots[0]!.resolve(apiData({activityIdentity:{sessionId:'chat',scope:'default'}}));
    await nextTick(); await nextTick();
    assert.match(document.getElementById('traceDrawerMeta')!.textContent!,/tr_second/);
    assert.equal(calls.some(url=>url.includes('/api/traces/tr_first')),false);
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
