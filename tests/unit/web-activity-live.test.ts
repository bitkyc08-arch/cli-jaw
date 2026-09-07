import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
import { encodeRuntimeBody } from '../../src/trace/runtime-body-codec.ts';

let dispatch: (event: Record<string, unknown>) => void;
let opened: () => void;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) { if (topic === '*') dispatch = callback; return () => {}; },
    onChannelOpen(callback: () => void) { opened = () => {
        bootstrapDone = Promise.withResolvers<void>();
        sidebarDone = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        callback();
    }; }, onChannelDisconnect() {}, onChannelUnavailable() {},
} });
mock.module('../../public/js/features/trace-drawer.js', { namedExports: {
    closeTraceDrawer() {}, openTraceDrawer() { assert.fail('unexpected raw Trace action'); },
} });
let unreadNotifications = 0;
const attention = await import('../../public/js/features/attention-badge.ts');
mock.module('../../public/js/features/attention-badge.js', { namedExports: {
    ...attention, notifyUnreadResponse() { unreadNotifications++; attention.notifyUnreadResponse(); },
} });
let ui: typeof import('../../public/js/ui.ts');
let live: typeof import('../../public/js/features/activity-live.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let ws: typeof import('../../public/js/ws.ts');
let serial = 0;
let activeRun: Record<string, unknown> | null = null;
let holdSnapshot: (() => Promise<void>) | null = null;
let pendingRequests: Record<string,unknown>[]=[];
let requestReads=0;
const bootstrapLoad = Promise.withResolvers<void>();
const bootstrapRelease = Promise.withResolvers<void>();
let bootstrapDone = Promise.withResolvers<void>();
let sidebarDone = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
const unexpectedRequests: string[] = [], requests: string[] = [];
test.before(async () => {
    setupWebUiDom();
    const warn = console.warn.bind(console);
    mock.method(console, 'warn', (...args: unknown[]) => {
        // This DOM-only suite deliberately lacks IndexedDB. Its real storage
        // writer and correction ordering are covered by the cache contract suite.
        if (String(args[0]).startsWith('[idb-cache]')) return;
        warn(...args);
    });
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
        const key = `${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${url.pathname}${url.search}`;
        requests.push(key);
        try {
            assert.equal(url.origin, window.location.origin); assert.ok(key.startsWith('GET '));
            if (url.pathname === '/api/messages') {
                assert.deepEqual([...url.searchParams], [['limit', '3000'], ['withSession', '1']]);
                return Response.json({ ok: true, data: { sessionId: 'chat', messages: [] } });
            }
            if (url.pathname === '/api/runtime/requests') {
                assert.deepEqual([...url.searchParams], [['sessionId', 'chat']]);
                requestReads++;
                return Response.json({ ok: true, data: { requests: pendingRequests } });
            }
            if (url.pathname === '/api/traces/activity-runs') {
                assert.deepEqual([...url.searchParams], [['session', 'chat'], ['after', '']]);
                return Response.json({ ok: true, data: { runs: [], pageSize: 40 } });
            }
            if (/^\/api\/traces\/(?:activity|buffered-gap|midrun|buffer-overflow)-\d+\/activity$/.test(url.pathname)) {
                assert.deepEqual([...url.searchParams], [['session', 'chat'], ['after', '0'], ['limit', '40']]);
                // These live fixtures have no retained journal; never fabricate one.
                return Response.json({ ok: false, error: 'activity_unavailable' }, { status: 503 });
            }
            if (url.pathname === '/api/bgtask' && url.search === '?status=running') return Response.json({ tasks: [] });
            if (!url.search) {
                if (url.pathname === '/api/orchestrate/snapshot') {
                    if (holdSnapshot) await holdSnapshot();
                    return Response.json({ activityIdentity: { sessionId: 'chat', scope: 'local:chat' },
                        orc: { state: 'IDLE', scope: 'local:chat', ctx: null },
                        heartbeat: { pending: 0, deferredPending: 0 }, workers: [],
                        runtime: { queuePending: 0, busy: !!activeRun }, queued: [], activeRun });
                }
                if (url.pathname === '/api/auth/token') return Response.json({ token: 'fixture-token' });
                if (url.pathname === '/api/settings') return Response.json({ workingDir: process.env.CLI_JAW_HOME });
                if (url.pathname === '/api/goal') return Response.json({ ok: true, goal: null });
                if (url.pathname === '/api/messages/count') return Response.json({ ok: true, data: { count: 0 } });
                if (url.pathname === '/api/memory-files' || url.pathname === '/api/memory/status')
                    return Response.json({ error: 'fixture_sidebar_unavailable' }, { status: 503 });
            }
            throw new Error('Unexpected HTTP route');
        } catch (error) { unexpectedRequests.push(`${key}: ${String(error)}`); throw error; }
    });
    ui = await import('../../public/js/ui.ts');
    mock.module('../../public/js/ui.js', { namedExports: { ...ui,
        async loadMessages() { bootstrapLoad.resolve(); await bootstrapRelease.promise; return ui.loadMessages(); },
        reconcileChatBottomAfterRestore: (...args: Parameters<typeof ui.reconcileChatBottomAfterRestore>) => {
            ui.reconcileChatBottomAfterRestore(...args);
            if (args[0] === 'reconnect') bootstrapDone.resolve();
        },
    } });
    const memory = await import('../../public/js/features/memory.ts');
    const background = await import('../../public/js/features/bgtask-badge.ts');
    mock.module('../../public/js/features/memory.js', { namedExports: { ...memory,
        async refreshMemorySidebar() { await memory.refreshMemorySidebar(); sidebarDone[0]!.resolve(); },
    } });
    mock.module('../../public/js/features/bgtask-badge.js', { namedExports: { ...background,
        async refreshBgtaskBadge() { await background.refreshBgtaskBadge(); sidebarDone[1]!.resolve(); },
    } });
    live = await import('../../public/js/features/activity-live.ts');
    ({state} = await import('../../public/js/state.ts'));
    ws = await import('../../public/js/ws.ts');
    ws.connect(); opened();
    await bootstrapLoad.promise;
    try {
        assert.equal(state.activityIdentity, null, 'held real history cannot admit the snapshot');
        assert.equal(requests.some(key => key.includes('/api/orchestrate/snapshot')), false);
    } finally {
        bootstrapRelease.resolve(); await bootstrapDone.promise;
        await Promise.all(sidebarDone.map(done => done.promise));
    }
    assert.deepEqual(state.activityIdentity, { sessionId: 'chat', scope: 'local:chat' });
    const historyRead = requests.indexOf('GET /api/messages?limit=3000&withSession=1');
    assert.ok(historyRead >= 0 && historyRead < requests.indexOf('GET /api/orchestrate/snapshot'));
    assert.deepEqual(unexpectedRequests, []);
});
test.beforeEach(async () => {
    activeRun = null; holdSnapshot = null; unreadNotifications = 0;
    pendingRequests=[];
    ui.cleanupToolActivity(); live.clearLiveActivity();
    document.getElementById('chatMessages')!.replaceChildren();
    await ws.syncOrchestrateSnapshot('activity-test', { hydrateRun: true });
});
test.afterEach(() => { assert.deepEqual(unexpectedRequests, []); });
test.after(() => {
    live.clearLiveActivity(); ui.cleanupToolActivity(); resetWebUiDom(); mock.restoreAll();
    assert.deepEqual(unexpectedRequests, []);
});

function runtime(runId: string, seq: number, body: RuntimeEventBody, extra = {}) {
    dispatch({event: 'agent_runtime', version: 1, runId, sessionId: 'chat', scope: 'local:chat', turnId: 'turn', seq, ...body, ...extra});
}
function start(): string {
    const runId = `activity-${++serial}`;
    dispatch({event: 'agent_status', running: true});
    runtime(runId, 1, {kind: 'turn-start', provider: 'codex-app'});
    return runId;
}

test('real SSE dispatch separates tool/commentary and keeps one untruncated authoritative answer', () => {
    const run = start();
    runtime(run, 3, {kind:'message',itemId:'comment',phase:'commentary',operation:'append',text:'Inspecting source'});
    runtime(run, 7, {kind:'tool',itemId:'tool',name:'Read',status:'running',input:'source.ts',output:'live output'});
    dispatch({event:'agent_output',traceRunId:run,text:'legacy draft',textLen:12});
    assert.equal(document.querySelectorAll('.msg-agent').length, 1);
    assert.equal(state.currentAgentDiv?.dataset['activityLive'], 'true');
    assert.match(document.querySelector('.activity-turn')!.textContent!, /Inspecting source|Read/);
    const answer = 'a'.repeat(33000) + 'FULL_ANSWER_SENTINEL';
    runtime(run, 9, {kind:'turn-end',status:'done',finalText:answer});
    dispatch({event:'agent_done',traceRunId:run,text:answer,runtimeFinality:'present',runtimeStatus:'done'});
    assert.equal(document.querySelectorAll('.msg-agent').length, 1);
    assert.equal(document.querySelector('.msg-content')?.getAttribute('data-raw'), answer);
    assert.equal(document.querySelector('.activity-final'), null);
    assert.equal(state.currentAgentDiv, null);
    assert.equal(live.findLiveActivity(run)?.model.end?.finalText?.length, 32768);
});

for (const finalText of [null, '']) test(`native ${finalText === null ? 'absent' : 'empty'} final never uses commentary`, () => {
    const run = start();
    runtime(run, 2, {kind:'reasoning',itemId:'reason',operation:'append',text:'private draft'});
    dispatch({event:'agent_output',traceRunId:run,text:'legacy draft',textLen:12});
    runtime(run, 3, {kind:'turn-end',status:'stopped',finalText});
    assert.equal(document.querySelector('.msg-content')?.getAttribute('data-raw'), '');
    assert.equal(live.findLiveActivity(run)?.model.end?.finalText, finalText);
});

test('compatibility final settles degraded Activity if semantic terminal was lost', () => {
    const run = start();
    runtime(run, 2, {kind:'tool',itemId:'tool',name:'Read',status:'running'});
    dispatch({event:'agent_runtime_gap',runId:run,sessionId:'chat',scope:'local:chat',reason:'projection_degraded'});
    dispatch({event:'agent_done',traceRunId:run,text:'kept answer',runtimeFinality:'present',runtimeStatus:'error'});
    const turn = live.findLiveActivity(run)!;
    assert.equal(turn.model.end, null);
    assert.equal(turn.terminalStatus, 'error');
    assert.equal(turn.degraded, true);
    assert.equal(turn.message.dataset['activityLive'], 'false');
    assert.equal(document.querySelector('.msg-content')?.getAttribute('data-raw'), 'kept answer');
});

test('late canonical terminal from compatibility-complete A cannot finalize active B', () => {
    const a = start();
    dispatch({event:'agent_done',traceRunId:a,text:'answer A',runtimeFinality:'present'});
    const b = start();
    dispatch({event:'agent_output',traceRunId:b,text:'draft B',textLen:7});
    const host = state.currentAgentDiv;
    runtime(a, 5, {kind:'turn-end',status:'done',finalText:'late A'});
    assert.equal(live.findLiveActivity(a)?.degraded, false, 'normal compatibility-first ordering is not permanent data loss');
    assert.equal(state.currentAgentDiv, host);
    assert.equal(state.agentBusy, true);
    assert.equal(document.querySelectorAll('.msg-agent').length, 2);
    runtime(b, 8, {kind:'turn-end',status:'done',finalText:'answer B'});
    assert.equal(host?.querySelector('.msg-content')?.getAttribute('data-raw'), 'answer B');
});

test('retained Activity answer receipt dedupes after the shorter legacy run window rotates', t => {
    const runs: string[] = [];
    for (let i = 0; i < 10; i++) {
        const run = start(); runs.push(run);
        dispatch({event:'agent_done',traceRunId:run,text:`answer ${i}`});
        runtime(run, 3, {kind:'turn-end',status:'done',finalText:`answer ${i}`});
    }
    const before = document.getElementById('chatMessages')!.innerHTML;
    const now = Date.now(); t.mock.method(Date, 'now', () => now + 1000);
    dispatch({event:'agent_done',traceRunId:runs[0],text:'duplicate old answer'});
    dispatch({event:'agent_output',traceRunId:runs[0],text:'old preview',textLen:11});
    assert.equal(document.getElementById('chatMessages')!.innerHTML, before);
    assert.equal(state.currentAgentDiv, null);
});

test('wrong session/scope never mounts a semantic turn; duplicate seq never appends twice', () => {
    const run = start();
    runtime('foreign', 1, {kind:'turn-start',provider:'pi'}, {sessionId:'other'});
    runtime('foreign', 2, {kind:'turn-start',provider:'pi'}, {scope:'other'});
    const event = {kind:'reasoning',itemId:'r',operation:'append',text:'once'} as const;
    runtime(run, 8, event); runtime(run, 8, event);
    assert.equal(live.findLiveActivity('foreign'), undefined);
    assert.equal(document.querySelectorAll('.activity-turn').length, 1);
    assert.equal(live.findLiveActivity(run)?.model.entries.get('r')?.kind, 'reasoning');
    assert.equal(document.querySelectorAll('.msg-agent').length, 1);
});

test('same-session snapshot reconstruction rebinds Activity to the visible active host', async () => {
    const run = start();
    runtime(run, 3, {kind:'tool',itemId:'tool',name:'Read',status:'running'});
    const old = state.currentAgentDiv!;
    old.remove(); ui.cleanupToolActivity();
    activeRun = {running:true,traceRunId:run,cli:'codex-app',text:'restored draft',toolLog:[]};
    await ws.syncOrchestrateSnapshot('reconstructed', {hydrateRun:true});
    const host = state.currentAgentDiv!;
    assert.notEqual(host, old);
    runtime(run, 5, {kind:'tool',itemId:'tool',name:'Read',status:'done',output:'visible result'});
    runtime(run, 8, {kind:'turn-end',status:'done',finalText:'visible final'});
    assert.equal(live.findLiveActivity(run)?.message, host);
    assert.equal(document.querySelectorAll('.activity-turn').length, 1);
    assert.equal(host.querySelector('.msg-content')?.getAttribute('data-raw'), 'visible final');
});

test('a delayed A snapshot cannot replace B started after the read or reset its busy state', async () => {
    const a = start();
    activeRun = { running: true, traceRunId: a, cli: 'cursor', text: 'old A snapshot', toolLog: [] };
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    holdSnapshot = async () => { started.resolve(); await release.promise; };
    const pending = ws.syncOrchestrateSnapshot('late-A', { hydrateRun: true }); await started.promise;
    runtime(a, 2, { kind: 'turn-end', status: 'done', finalText: 'A final' });
    const b = start(); const bHost = state.currentAgentDiv;
    runtime(b, 2, { kind: 'tool', itemId: 'b', name: 'B tool', status: 'running' });
    release.resolve(); await pending;
    assert.equal(state.currentAgentDiv, bHost); assert.equal(state.agentBusy, true);
    assert.equal(bHost?.dataset['traceRunId'], b);
    assert.equal(live.findLiveActivity(b)?.message, bHost);
    runtime(b, 3, { kind: 'turn-end', status: 'done', finalText: 'B final' });
    assert.equal(bHost?.querySelector('.msg-content')?.getAttribute('data-raw'), 'B final');
});

test('debounced second focus does not invalidate the snapshot admitted by the first', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    holdSnapshot = async () => { started.resolve(); await release.promise; };
    window.dispatchEvent(new window.Event('focus'));
    await started.promise;
    window.dispatchEvent(new window.Event('focus'));
    release.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(state.activityIdentity, {sessionId:'chat',scope:'local:chat'});
    const run = start();
    assert.ok(live.findLiveActivity(run));
});

test('virtual restore strips an evicted Activity projection without hiding its answer', () => {
    const run = start();
    runtime(run, 4, {kind:'turn-end',status:'done',finalText:'answer to retain'});
    const saved = live.findLiveActivity(run)!.message.outerHTML;
    for (let i = 0; i < 16; i++) {
        const next = start();
        runtime(next, 4, {kind:'turn-end',status:'done',finalText:'next answer'});
    }
    assert.equal(live.findLiveActivity(run), undefined);
    const viewport = document.createElement('div');
    viewport.innerHTML = saved;
    live.remountLiveActivity(viewport);
    assert.equal(viewport.querySelector('.activity-turn'), null);
    assert.equal(viewport.querySelector('[data-activity-key]'), null);
    assert.equal(viewport.querySelector('.msg-content')?.getAttribute('data-raw'), 'answer to retain');
});

function requestFixture(runId:string){
    return {runId,sessionId:'chat',scope:'local:chat',turnId:'turn',requestId:'request',requestType:'approval',expiresAt:Date.now()+60000,
        view:{title:'Read fixture',fields:[{id:'choice',label:'Allow the read?',multiSelect:false,allowFreeform:false,options:[{id:'allow',label:'Allow'}]}]}};
}
test('clear followed by a live native request remounts actionable controls',async()=>{
    dispatch({event:'clear'});
    const run=start();const pending=requestFixture(run);pendingRequests=[pending];
    runtime(run,2,{kind:'request',requestId:'request',requestType:'approval',view:pending.view});
    try{
        await new Promise<void>(resolve=>setImmediate(resolve));
        assert.ok([...document.querySelectorAll('.native-requests button')].some(button=>button.textContent==='Allow'));
    }finally{
        pendingRequests=[];runtime(run,3,{kind:'request-settled',requestId:'request'});
        await new Promise<void>(resolve=>setImmediate(resolve));
    }
});
test('live canonical-first terminal refreshes requests when settled notification was missed',async()=>{
    const run=start();const pending=requestFixture(run);pendingRequests=[pending];
    runtime(run,2,{kind:'request',requestId:'request',requestType:'approval',view:pending.view});
    await new Promise<void>(resolve=>setImmediate(resolve));
    const before=requestReads;pendingRequests=[];
    try{
        runtime(run,4,{kind:'turn-end',status:'done',finalText:'done'});
        dispatch({event:'agent_done',traceRunId:run,text:'done',runtimeFinality:'present'});
        await new Promise<void>(resolve=>setImmediate(resolve));
        assert.ok(requestReads>before);
        assert.equal(document.querySelector<HTMLElement>('.native-requests')?.hidden,true);
    }finally{
        runtime(run,5,{kind:'request-settled',requestId:'request'});
        await new Promise<void>(resolve=>setImmediate(resolve));
    }
});


for (const first of ['agent_done', 'orchestrate_done'] as const) {
    test(`AB-004: ${first} notifies once; paired completion and new_message do not`, { timeout: 5000 }, async t => {
        const run = start();
        dispatch({event:first,traceRunId:run,text:'final answer'});
        assert.equal(unreadNotifications,1);
        const now = Date.now(); t.mock.method(Date,'now',()=>now+1000);
        dispatch({event:first==='agent_done'?'orchestrate_done':'agent_done',traceRunId:run,text:'final answer'});
        runtime(run,3,{kind:'turn-end',status:'done',finalText:'final answer'});
        assert.equal(unreadNotifications,1);
        const marker=`new-message-${run}`;
        const {getVirtualScroll}=await import('../../public/js/virtual-scroll.ts');
        const vs=getVirtualScroll();
        const add=vs.addItem.bind(vs), append=vs.appendLiveItem.bind(vs);
        let didWrite!:()=>void;
        const written=new Promise<void>(resolve=>{didWrite=resolve;});
        // jsdom has no visible virtual rows. Observe the actual row-store write,
        // rather than waiting for geometry-dependent mounting or fixed timer ticks.
        t.mock.method(vs,'addItem',(id:string,html:string)=>{
            add(id,html);if(html.includes(marker))didWrite();
        });
        t.mock.method(vs,'appendLiveItem',(div:HTMLElement)=>{
            append(div);if(div.textContent?.includes(marker))didWrite();
        });
        try {
            dispatch({event:'new_message',role:'user',content:marker,external:true});
            await written;
            assert.equal(unreadNotifications,1);
        } finally {vs.clear();}
    });
}

for (const order of ['canonical-first', 'compatibility-first'] as const) {
    test(`native ${order} preserves the public answer after actual journal redaction`, () => {
        const run = start();
        const answer = 'Use Bearer fixture-secret and PASSWORD=fixture-password';
        const { body } = encodeRuntimeBody({ version: 1, runId: run, sessionId: 'chat',
            scope: 'local:chat', turnId: 'turn', seq: 3 }, { kind: 'turn-end', status: 'done', finalText: answer });
        assert.ok(body.kind === 'turn-end');
        assert.equal(body.finalText, 'Use Bearer [REDACTED] and PASSWORD=[REDACTED]');
        const canonical = () => runtime(run, 3, body);
        const publicAnswer = () => dispatch({ event: 'agent_done', traceRunId: run, text: answer,
            runtimeFinality: 'present', runtimeStatus: 'done' });
        if (order === 'canonical-first') { canonical(); publicAnswer(); }
        else { publicAnswer(); canonical(); }
        assert.equal(document.querySelectorAll('.msg-agent').length, 1);
        assert.equal(document.querySelector('.msg-content')?.getAttribute('data-raw'), answer);
        assert.equal(unreadNotifications, 1);
        assert.equal(live.findLiveActivity(run)?.model.end?.finalText, body.finalText);
    });
}

test('native absent compatibility cannot turn a diagnostic into a final answer', () => {
    const run = start();
    runtime(run, 2, { kind: 'turn-end', status: 'error', finalText: null, error: 'Provider failed' });
    dispatch({ event: 'agent_done', traceRunId: run, text: 'NOT A MODEL ANSWER', runtimeFinality: 'absent', runtimeStatus: 'error' });
    assert.equal(document.querySelector('.msg-content')?.getAttribute('data-raw'), '');
    assert.equal(document.querySelector('.activity-error')?.textContent, 'Provider failed');
    assert.equal(unreadNotifications, 1);
});

test('compatibility-first native absent diagnostic is a notice, not the answer', () => {
    const run = start(); const host = state.currentAgentDiv;
    dispatch({ event: 'agent_done', traceRunId: run, text: 'Provider diagnostic, not a model answer',
        runtimeFinality: 'absent', runtimeStatus: 'error' });
    assert.equal(host?.querySelector('.msg-content')?.getAttribute('data-raw'), '');
    assert.match(document.querySelector('.msg-system')?.textContent ?? '', /Provider diagnostic/);
    runtime(run, 3, { kind: 'turn-end', status: 'error', finalText: null, error: 'Provider diagnostic' });
    assert.equal(host?.querySelector('.msg-content')?.getAttribute('data-raw'), '');
    assert.equal(unreadNotifications, 1);
});

for (const foreign of [false, true]) test(`pre-admission ${foreign ? 'foreign' : 'owned'} gap preserves its exact identity`, async () => {
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const run = `buffered-gap-${++serial}`;
    activeRun = { running: true, traceRunId: run, cli: 'cursor', text: '', toolLog: [] };
    holdSnapshot = async () => { started.resolve(); await release.promise; };
    ws.connect(); opened(); await started.promise;
    runtime(run, 1, { kind: 'turn-start', provider: 'cursor' });
    runtime(run, 2, { kind: 'message', itemId: 'm', phase: 'commentary', operation: 'replace', text: 'Before storage loss' });
    dispatch({ event: 'agent_runtime_gap', runId: run, sessionId: foreign ? 'other-chat' : 'chat',
        scope: 'local:chat', reason: 'storage_error' });
    release.resolve();
    await bootstrapDone.promise;
    await Promise.all(sidebarDone.map(done => done.promise));
    const turn = live.findLiveActivity(run); assert.ok(turn);
    assert.equal(turn.model.end, null, 'check while the run is still active');
    assert.equal(turn.degraded, !foreign);
    assert.equal(turn.message.querySelector<HTMLElement>('.activity-degraded')?.hidden, foreign);
});

test('late native public correction of A cannot finalize B or replace its current preview', () => {
    const a = start();
    runtime(a, 2, { kind: 'turn-end', status: 'done', finalText: '[REDACTED]' });
    const aHost = live.findLiveActivity(a)!.message;
    const b = start(); const bHost = state.currentAgentDiv;
    runtime(b, 2, { kind: 'tool', itemId: 'b-tool', name: 'Read B', status: 'running' });
    dispatch({ event: 'orchestrate_done', traceRunId: a, text: 'Original A', runtimeFinality: 'present' });
    assert.equal(aHost.querySelector('.msg-content')?.getAttribute('data-raw'), 'Original A');
    assert.equal(state.currentAgentDiv, bHost); assert.equal(state.agentBusy, true);
    assert.equal(live.findLiveActivity(b)?.model.end, null); assert.equal(unreadNotifications, 1);
    runtime(b, 4, { kind: 'turn-end', status: 'done', finalText: 'B final' });
    assert.equal(bHost?.querySelector('.msg-content')?.getAttribute('data-raw'), 'B final');
});

test('one run cannot bind a conflicting turn to a second Activity host', () => {
    const run = start(); const host = state.currentAgentDiv;
    const before = structuredClone(live.findLiveActivity(run)!.model);
    runtime(run, 7, { kind: 'turn-start', provider: 'pi' }, { turnId: 'wrong-turn' });
    runtime(run, 8, { kind: 'turn-end', status: 'done', finalText: 'WRONG' }, { turnId: 'wrong-turn' });
    assert.equal(state.currentAgentDiv, host); assert.equal(document.querySelectorAll('.msg-agent').length, 1);
    assert.deepEqual(live.findLiveActivity(run)!.model, before);
});

test('retained active-turn capacity shows one warning and keeps the new compatibility answer', () => {
    for (let i = 0; i < 16; i++) start();
    const run = start();
    runtime(run, 2, { kind: 'tool', itemId: 'overflow', name: 'Read', status: 'running' });
    assert.equal(live.findLiveActivity(run), undefined);
    assert.equal(document.querySelectorAll('.activity-turn').length, 16);
    assert.equal(document.querySelectorAll('.activity-unavailable').length, 1);
    const host = state.currentAgentDiv;
    dispatch({ event: 'agent_done', traceRunId: run, text: 'CAPACITY FINAL', runtimeFinality: 'present' });
    assert.equal(host?.querySelector('.msg-content')?.getAttribute('data-raw'), 'CAPACITY FINAL');
    assert.equal(state.currentAgentDiv, null); assert.equal(unreadNotifications, 1);
});

test('snapshot-owned mid-run Activity without a start remains explicitly incomplete', async () => {
    const run = `midrun-${++serial}`;
    activeRun = { running: true, traceRunId: run, cli: 'cursor', text: '', toolLog: [] };
    await ws.syncOrchestrateSnapshot('mid-run', { hydrateRun: true });
    runtime(run, 8, { kind: 'tool', itemId: 'partial', name: 'Read', status: 'done', output: 'tail' });
    runtime(run, 10, { kind: 'turn-end', status: 'done', finalText: 'Known final' });
    assert.equal(live.findLiveActivity(run)?.degraded, true);
    assert.match(live.findLiveActivity(run)!.message.querySelector('.activity-degraded')!.textContent!, /incomplete/);
    assert.equal(document.querySelector('.msg-content')?.getAttribute('data-raw'), 'Known final');
});

for (const mode of ['native-input', 'cancel-reprompt']) test(`${mode} receipt is not a terminal or a busy reset`, () => {
    const run = start(); const host = state.currentAgentDiv;
    runtime(run, 2, { kind: 'tool', itemId: 'tool', name: 'Read', status: 'running' });
    dispatch({ event: 'steer_started', mode });
    assert.equal(state.currentAgentDiv, host); assert.equal(state.agentBusy, true);
    assert.equal(ui.isRecentSteer(), false);
    runtime(run, 3, { kind: 'tool', itemId: 'tool', name: 'Read', status: 'done', output: 'after steer' });
    runtime(run, 4, { kind: 'turn-end', status: 'done', finalText: 'Steered final' });
    assert.equal(host?.querySelector('.msg-content')?.getAttribute('data-raw'), 'Steered final');
});

test('new canonical run cannot inherit the previous run legacy ProcessBlock', () => {
    const a = start();
    dispatch({ event: 'agent_tool', traceRunId: a, traceSeq: 2, label: 'A ONLY TOOL',
        toolType: 'tool', status: 'running', detail: 'A ONLY DETAIL' });
    assert.ok(state.currentProcessBlock);
    const b = start(); const bHost = state.currentAgentDiv;
    assert.equal(state.currentProcessBlock, null, 'B must not serialize A tools into its cached final');
    runtime(b, 3, { kind: 'turn-end', status: 'done', finalText: 'B CLEAN FINAL' });
    assert.doesNotMatch(bHost!.textContent!, /A ONLY TOOL|A ONLY DETAIL/);
    assert.equal(bHost?.querySelector('.msg-content')?.getAttribute('data-raw'), 'B CLEAN FINAL');
});

test('64 explicit turn disclosures are not silently evicted to admit another run', () => {
    let retained: ReturnType<typeof live.findLiveActivity>;
    for (let i = 0; i < 64; i++) {
        const run = start(); retained = live.findLiveActivity(run)!;
        retained.message.querySelector<HTMLDetailsElement>('.activity-disclosure')!.open = true;
        runtime(run, 2, { kind: 'turn-end', status: 'done', finalText: `Answer ${i}` });
    }
    const overflow = start();
    assert.equal(live.findLiveActivity(overflow), undefined);
    assert.equal(document.querySelectorAll('.activity-unavailable').length, 1);
    assert.equal(retained!.choices.open, true);
    dispatch({ event: 'agent_done', traceRunId: overflow, text: 'STILL DELIVERED' });
    const group = retained!.message.querySelector<HTMLDetailsElement>('.activity-disclosure')!;
    group.open = false; group.dispatchEvent(new window.Event('toggle'));
    const recovered = start();
    assert.ok(live.findLiveActivity(recovered), 'explicitly closing one remembered turn frees admission');
});

for (const budget of ['entries', 'bytes', 'empty-tail']) test(`pre-admission ${budget} overflow stays bounded and visibly incomplete`, async () => {
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const run = `buffer-overflow-${++serial}`;
    activeRun = { running: true, traceRunId: run, cli: 'cursor', text: '', toolLog: [] };
    holdSnapshot = async () => { started.resolve(); await release.promise; };
    ws.connect(); opened(); await started.promise;
    runtime(run, 1, { kind: 'turn-start', provider: 'cursor' });
    // Each byte fixture fits the actual32KiB journal event budget. Keep frames
    // after the overflow as well, so this asserts an admitted incomplete tail.
    const count = budget === 'entries' ? 258 : budget === 'empty-tail' ? 257 : 42;
    for (let i = 2; i <= count; i++) runtime(run, i, { kind: 'message', itemId: 'm', phase: 'commentary',
        operation: 'replace', text: budget === 'bytes' ? 'x'.repeat(30000) : String(i) });
    release.resolve();
    await bootstrapDone.promise;
    await Promise.all(sidebarDone.map(done => done.promise));
    const turn = live.findLiveActivity(run);
    if (budget === 'empty-tail') {
        assert.equal(turn, undefined);
        assert.match(document.querySelector('.activity-unavailable')?.textContent ?? '', /incomplete/);
        const host = state.currentAgentDiv;
        dispatch({ event: 'agent_done', traceRunId: run, text: 'EMPTY TAIL FINAL', runtimeFinality: 'present' });
        assert.equal(host?.querySelector('.msg-content')?.getAttribute('data-raw'), 'EMPTY TAIL FINAL');
        return;
    }
    assert.ok(turn);
    assert.equal(turn.degraded, true); assert.equal(turn.model.end, null);
    assert.ok(turn.model.entries.size <= 128);
    assert.equal(turn.message.querySelector<HTMLElement>('.activity-degraded')?.hidden, false);
    dispatch({ event: 'agent_done', traceRunId: run, text: 'OVERFLOW FINAL', runtimeFinality: 'present' });
    assert.equal(turn.message.querySelector('.msg-content')?.getAttribute('data-raw'), 'OVERFLOW FINAL');
});
