import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { RuntimeEventBody } from '../../src/shared/runtime-contract.ts';

let dispatch: (event: Record<string, unknown>) => void;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) { if (topic === '*') dispatch = callback; return () => {}; },
    onChannelOpen() {}, onChannelDisconnect() {}, onChannelUnavailable() {},
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
test.before(async () => {
    setupWebUiDom();
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const path = String(input);
        if(path.includes('/api/runtime/requests?')){
            requestReads++;
            return new Response(JSON.stringify({ok:true,data:{requests:pendingRequests}}),{headers:{'Content-Type':'application/json'}});
        }
        if(path.includes('/api/traces/activity-runs'))return new Response(JSON.stringify({ok:true,data:{runs:[],pageSize:40}}),{headers:{'Content-Type':'application/json'}});
        if (path.includes('/orchestrate/snapshot') && holdSnapshot) await holdSnapshot();
        const data = path.includes('/orchestrate/snapshot') ? {
            activityIdentity: { sessionId: 'chat', scope: 'local:chat' },
            orc: { state: 'IDLE', scope: 'local:chat', ctx: null },
            heartbeat: { pending: 0, deferredPending: 0 }, workers: [],
            runtime: { queuePending: 0, busy: !!activeRun }, queued: [], activeRun,
        } : { count: 0 };
        return new Response(JSON.stringify({ ok: true, data }), { headers: { 'Content-Type': 'application/json' } });
    });
    ui = await import('../../public/js/ui.ts');
    live = await import('../../public/js/features/activity-live.ts');
    ({state} = await import('../../public/js/state.ts'));
    ws = await import('../../public/js/ws.ts');
    ws.connect();
});
test.beforeEach(async () => {
    activeRun = null; holdSnapshot = null;
    pendingRequests=[];
    ui.cleanupToolActivity(); live.clearLiveActivity();
    document.getElementById('chatMessages')!.replaceChildren();
    await ws.syncOrchestrateSnapshot('activity-test', { hydrateRun: true });
});
test.after(() => { live.clearLiveActivity(); ui.cleanupToolActivity(); resetWebUiDom(); mock.restoreAll(); });

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
