import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

// Node does not load the provider SVG assets; markup/handler/drawer stay real.
mock.module('../../public/js/provider-icons.js', { namedExports: { providerLabel: (slug: string) => slug } });

const RUN = 'tr_process_admission_0001';
const SEQ = 143;
const VIEW = 'selected-view';
const OWNER = 'server-owner';
const RAW = 'Retained trace detail';
const calls: URL[] = [];
let block: typeof import('../../public/js/features/process-block.ts');
let drawer: typeof import('../../public/js/features/trace-drawer.ts');
let holdSnapshot: Promise<Response> | null = null;
const json = (data: unknown) => Response.json(data);
const ok = (data: unknown) => json({ ok: true, data });
const snapshot = () => json({ activityIdentity: { sessionId: OWNER, scope: 'default' },
    orc: { state: 'IDLE', scope: 'default', ctx: null }, workers: [], queued: [],
    runtime: { busy: false, queuePending: 0 }, activeRun: null });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test.beforeEach(async t => {
    setupWebUiDom(); holdSnapshot = null;
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://fixture');
        if (url.pathname === '/api/auth/token') return json({ token: 'fixture-token' });
        calls.push(url);
        if (url.pathname === '/api/orchestrate/snapshot') return holdSnapshot ?? snapshot();
        if (url.pathname === `/api/traces/${RUN}`) return ok({ id: RUN, cli: 'cursor', model: 'fixture',
            agentLabel: 'main', status: 'done', rawRetentionStatus: 'available', eventCount: 1, byteCount: 21, startedAt: 1 });
        if (url.pathname === `/api/traces/${RUN}/events`) return ok({ total: 1, events: [
            { run_id: RUN, seq: SEQ, source: 'tool', event_type: 'tool_result', preview: 'retained',
                bytes: 21, retention_status: 'available', created_at: 1 },
        ] });
        if (url.pathname === `/api/traces/${RUN}/events/${SEQ}`) return ok({ runId: RUN, seq: SEQ,
            source: 'tool', eventType: 'tool_result', preview: 'retained', bytes: 21,
            retentionStatus: 'available', createdAt: 1, raw: RAW });
        throw new Error(`Unexpected request ${url}`);
    });
    block = await import('../../public/js/features/process-block.ts');
    drawer = await import('../../public/js/features/trace-drawer.ts');
    const { configureSessionView } = await import('../../public/js/features/session-hub.ts');
    configureSessionView({ active: VIEW, sessions: [
        { id: VIEW, seq: 1, label: null, message_count: 0, source: 'local', remoteKey: null },
    ] }, '/1');
    calls.length = 0;
});
test.afterEach(() => {
    drawer.closeTraceDrawer();
    block.releaseProcessBlockDetails(document.getElementById('chatMessages'));
    block.stopBlockTicker(); resetWebUiDom();
});

function renderTrace(id = 'retained-step'): HTMLElement {
    const host = document.createElement('div'); host.className = 'msg msg-agent';
    host.innerHTML = block.buildProcessBlockHtml([{ id, type: 'tool', icon: 'tool', label: 'Read source',
        detail: 'retained', detailAvailable: true, traceRunId: RUN, traceSeq: SEQ,
        status: 'done', startTime: 1 }], false);
    document.getElementById('chatMessages')!.append(host);
    block.bindProcessBlockInteractions(host);
    block.bindProcessBlockInteractions(host); // Existing delegated binding remains idempotent.
    const trigger = host.querySelector<HTMLElement>('.process-step-trace')!;
    assert.equal(trigger.tagName, 'SPAN', 'exercise production markup, not a manufactured disabled button');
    assert.equal(trigger.getAttribute('role'), 'button');
    assert.ok(trigger.closest('button.process-step-toggle'));
    return trigger;
}
function admission(trigger: HTMLElement, allowed: boolean): void {
    // Boundary contract written by main-owned history.traceAllowed; no history replacement here.
    trigger.setAttribute('aria-disabled', String(!allowed));
    trigger.tabIndex = allowed ? 0 : -1;
}
type Activation = 'click' | 'Enter' | ' ';
function activate(trigger: HTMLElement, activation: Activation): void {
    trigger.focus();
    if (activation === 'click') { trigger.click(); return; }
    const event = new window.KeyboardEvent('keydown', { key: activation, bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, 'Trace key cannot activate its parent row button or scroll');
}
async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 1000; i++) { if (check()) return; await tick(); }
    assert.fail('Expected trace state did not settle');
}
function assertNotOpened(): void {
    assert.notEqual(document.getElementById('traceDrawerOverlay')?.classList.contains('open'), true);
    assert.equal(calls.filter(url => url.pathname.startsWith('/api/traces/')).length, 0);
}
async function assertPermitted(): Promise<void> {
    await until(() => document.getElementById('traceEventRaw')?.textContent === RAW);
    assert.equal(document.getElementById('traceDrawerOverlay')?.classList.contains('open'), true);
    const reads = calls.filter(url => url.pathname.startsWith('/api/traces/'));
    assert.equal(reads.length, 3);
    assert.ok(reads.every(url => url.searchParams.get('session') === OWNER));
    const captures = calls.filter(url => url.pathname === '/api/orchestrate/snapshot');
    assert.equal(captures.length, 1); assert.equal(captures[0]!.searchParams.get('session'), VIEW);
}

for (const reason of ['unverified', 'denied']) for (const activation of ['click', 'Enter', ' '] as const) {
    test(`${reason} production Trace span blocks ${JSON.stringify(activation)}, then the same control can be permitted`, async () => {
        const trigger = renderTrace(); admission(trigger, false);
        const rowToggle = trigger.closest('button')!;
        activate(trigger, activation); await tick();
        assert.equal(calls.length, 0, 'blocked activation must not even read snapshot identity');
        assertNotOpened(); assert.equal(rowToggle.getAttribute('aria-expanded'), 'false');
        admission(trigger, true); activate(trigger, activation);
        await assertPermitted();
        assert.equal(rowToggle.getAttribute('aria-expanded'), 'false');
    });
}

for (const activation of ['click', 'Enter', ' '] as const) test(`legacy Trace without admission metadata remains operable via ${JSON.stringify(activation)}`, async () => {
    const trigger = renderTrace(); assert.equal(trigger.hasAttribute('aria-disabled'), false);
    activate(trigger, activation); await assertPermitted();
});

test('permission revoked while snapshot is pending prevents drawer open and raw reads', async () => {
    const trigger = renderTrace(); admission(trigger, true);
    const pending = Promise.withResolvers<Response>(); holdSnapshot = pending.promise;
    activate(trigger, 'click'); await until(() => calls.length === 1);
    admission(trigger, false); pending.resolve(snapshot()); await tick(); await tick();
    assertNotOpened(); assert.equal(calls.length, 1, 'only the previously admitted snapshot was sent');
    holdSnapshot = null; calls.length = 0;
    admission(trigger, true); activate(trigger, 'Enter'); await assertPermitted();
});

test('a blocked click does not supersede another permitted Trace intent', async () => {
    const allowed = renderTrace('allowed'), denied = renderTrace('denied');
    admission(allowed, true); admission(denied, false);
    const pending = Promise.withResolvers<Response>(); holdSnapshot = pending.promise;
    activate(allowed, 'click'); await until(() => calls.length === 1);
    activate(denied, 'click'); await tick();
    assert.equal(calls.length, 1);
    pending.resolve(snapshot()); await assertPermitted();
});
