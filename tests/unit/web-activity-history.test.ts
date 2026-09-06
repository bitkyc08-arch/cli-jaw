import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {setupWebUiDom,resetWebUiDom} from './web-ui-test-dom.ts';
import type {RuntimeEvent} from '../../src/shared/runtime-contract.ts';

const identity={sessionId:'chat',scope:'local:chat'};
const base={...identity,version:1 as const,runId:'tr_history0123456789',turnId:'turn'};
const events:RuntimeEvent[]=[
    {...base,seq:1,kind:'turn-start',provider:'pi'},
    {...base,seq:3,kind:'message',itemId:'comment',phase:'commentary',operation:'append',text:'checking'},
    {...base,seq:8,kind:'tool',itemId:'tool',name:'Read',status:'done',output:'retained output'},
    {...base,seq:12,kind:'turn-end',status:'done',finalText:'journal answer'},
];
const response=(data:unknown,status=200)=>new Response(JSON.stringify({ok:status===200,data}),{status,headers:{'content-type':'application/json'}});
let history:typeof import('../../public/js/features/activity-history.ts');
let live:typeof import('../../public/js/features/activity-live.ts');
let state:typeof import('../../public/js/state.ts')['state'];
let serve:(url:URL)=>Promise<Response>;
let ends: Array<import('../../public/js/features/activity-history.ts').RecoveredActivityTerminal> = [];
const loadedRuns = new Set<string>();
const savedAnswers = new Map<string, string>();
let messageSerial = 0;
function page(after=0,items=events,overrides={}) {
    return {...identity,runId:base.runId,status:'done',events:items.filter(e=>e.seq>after),through:12,nextAfter:12,hasMore:false,incomplete:false,loss:null,...overrides};
}
function message(answer='SAVED ANSWER', runId=base.runId, saved=true) {
    if (saved) { savedAnswers.set(runId, answer); loadedRuns.add(runId); history.setActivityTranscript(identity.sessionId, loadedRuns); }
    const node=document.createElement('div');node.className='msg msg-agent';node.dataset['traceRunId']=runId;
    node.dataset['messageSessionId']=identity.sessionId; node.dataset['messageId']='message-'+(++messageSerial);
    if (saved) { node.dataset['serverMessageId']='1'; node.dataset['activitySaved']='true'; }
    const body=document.createElement('div');body.className='agent-body';
    const content=document.createElement('div');content.className='msg-content';content.dataset['raw']=answer;content.textContent=answer;
    const trace=document.createElement('button');trace.className='process-step-trace';trace.textContent='Trace';
    body.append(content,trace);node.append(body);document.getElementById('chatMessages')!.append(node);return node;
}
test.before(async()=>{
    setupWebUiDom();
    mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
        const url=new URL(String(input),'http://fixture');
        if(url.pathname==='/api/auth/token')return response({token:''});
        if(url.pathname.startsWith('/api/messages/by-trace/')) {
            const runId=decodeURIComponent(url.pathname.split('/').at(-1)!);
            return response({message:savedAnswers.has(runId)?{id:1,role:'assistant',content:savedAnswers.get(runId),trace_run_id:runId,session_id:identity.sessionId}:null});
        }
        return serve(url);
    });
    history=await import('../../public/js/features/activity-history.ts');
    live=await import('../../public/js/features/activity-live.ts');
    ({state}=await import('../../public/js/state.ts'));
    live.configureLiveActivityHost({currentMessage:()=>state.currentAgentDiv,useMessage:node=>{state.currentAgentDiv=node;},
        createMessage:()=>message('',base.runId,false),reconcileMessage:()=>false,
        replaceAnswer:(node,text)=>{const body=node.querySelector<HTMLElement>('.msg-content')!;body.textContent=text;body.dataset['raw']=text;},
        inspectTrace(){},closeTrace(){},evicted:node=>history.markActivityHistoryUnavailable(node)});
    const warn=console.warn.bind(console);mock.method(console,'warn',(...args:unknown[])=>{
        if(String(args[0]).startsWith('[idb-cache]'))return;warn(...args);
    });
});
test.beforeEach(()=>{
    history.disposeActivityHistory();live.clearLiveActivity();state.currentAgentDiv=null;
    loadedRuns.clear();savedAnswers.clear();
    document.getElementById('chatMessages')!.replaceChildren();ends=[];
    live.setLiveActivityIdentity(identity);history.setActivityHistoryIdentity(identity,{terminal:e=>ends.push(e),refreshIdentity:async()=>{}});
    history.setActivityTranscript(identity.sessionId,loadedRuns);history.setActivityHistoryReadReady(true);
    serve=async url=>response(page(Number(url.searchParams.get('after')??0)));
});
test.after(()=>{history.disposeActivityHistory();live.clearLiveActivity();resetWebUiDom();mock.restoreAll();});

test('journal hydration retains one full persisted answer and renders Activity only',{timeout:10000},async()=>{
    const full='a'.repeat(33000)+'PERSISTED_TAIL';const host=message(full);
    await history.hydrateActivityHost(host,base.runId);
    assert.equal(host.querySelectorAll('.activity-turn').length,1);
    assert.equal(host.querySelector('.activity-final'),null);
    assert.equal(host.querySelector('.msg-content')?.getAttribute('data-raw'),full);
    assert.match(host.querySelector('.activity-turn')!.textContent!,/Read/);
    assert.equal(host.querySelector<HTMLButtonElement>('.process-step-trace')!.disabled,false);
    assert.equal(ends.length,1);
});

test('same-chat stored scope may differ from current live selection without rewriting either',{timeout:10000},async()=>{
    serve=async url=>response(page(Number(url.searchParams.get('after')??0),events.map(e=>({...e,scope:'custom:historical'})),{scope:'custom:historical'}));
    const host=message();await history.hydrateActivityHost(host,base.runId);
    assert.ok(host.querySelector('.activity-turn'));
    assert.equal(host.querySelector('.msg-content')?.textContent,'SAVED ANSWER');
    assert.equal(live.findLiveActivity(base.runId)?.model.identity.scope,'custom:historical');
    assert.equal(live.ingestLiveActivity({...events[2]!,seq:99,scope:'custom:historical'}),null);
});

test('a recycled same-session host ignores its late response',{timeout:10000},async()=>{
    const started=Promise.withResolvers<void>();const release=Promise.withResolvers<Response>();
    serve=async()=>{started.resolve();return release.promise;};
    const old=message();const pending=history.hydrateActivityHost(old,base.runId);await started.promise;
    history.recycleActivityHistory(old);old.remove();
    const replacement=message('NEW SAVED ANSWER');
    release.resolve(response(page()));await pending;
    assert.equal(old.querySelector('.activity-turn'),null);
    serve=async url=>response(page(Number(url.searchParams.get('after')??0)));
    await history.hydrateActivityHost(replacement,base.runId);
    assert.equal(replacement.querySelectorAll('.activity-turn').length,1);
    assert.equal(replacement.querySelector('.msg-content')?.textContent,'NEW SAVED ANSWER');
});

test('failed read retains answer and retry restores the same host',{timeout:10000},async()=>{
    serve=async()=>response({},503);const host=message();
    await history.hydrateActivityHost(host,base.runId);
    assert.equal(host.querySelector('.msg-content')?.textContent,'SAVED ANSWER');
    serve=async url=>response(page(Number(url.searchParams.get('after')??0)));
    await history.hydrateActivityHost(host,base.runId,true);
    assert.equal(host.querySelectorAll('.activity-turn').length,1);
    assert.equal(host.querySelector<HTMLButtonElement>('.activity-read-control button')!.hidden,true);
});

test('copied foreign trace controls stay disabled; owned raw-only legacy trace remains inspectable',{timeout:10000},async()=>{
    serve=async()=>response({},404);const foreign=message();
    await history.hydrateActivityHost(foreign,base.runId);
    assert.equal(foreign.querySelector<HTMLButtonElement>('.process-step-trace')!.disabled,true);
    const own=message();serve=async url=>url.pathname.endsWith('/activity')?response({},404):response({id:base.runId});
    await history.hydrateActivityHost(own,base.runId);
    assert.equal(own.querySelector<HTMLButtonElement>('.process-step-trace')!.disabled,false);
    assert.match(own.querySelector('.activity-read-control')!.textContent!,/was not recorded/);
    assert.equal(own.querySelector<HTMLButtonElement>('.activity-read-control button')!.hidden,true);
});

test('live events during fixed-through restore are reduced once and tail catch-up settles',{timeout:10000},async()=>{
    live.ingestLiveActivity(events[0]!);const host=state.currentAgentDiv!;
    const started=Promise.withResolvers<void>();const release=Promise.withResolvers<Response>();
    serve=async url=>{
        if(url.searchParams.get('after')==='0'){started.resolve();return release.promise;}
        return response(page(3));
    };
    const pending=history.hydrateActivityHost(host,base.runId,true);await started.promise;
    live.ingestLiveActivity(events[2]!);
    release.resolve(response(page(0,events.slice(0,2),{through:3,nextAfter:3})));await pending;
    const turn=live.findLiveActivity(base.runId)!;
    assert.equal(turn.model.entries.size,2);
    assert.equal(turn.model.seq,12);
    assert.equal(host.querySelectorAll('.activity-turn').length,1);
    assert.equal(ends.length,1);
});

test('session change invalidates an outstanding read before any callback or mount',{timeout:10000},async()=>{
    const started=Promise.withResolvers<void>();const release=Promise.withResolvers<Response>();
    serve=async()=>{started.resolve();return release.promise;};
    const host=message();const pending=history.hydrateActivityHost(host,base.runId);await started.promise;
    history.setActivityHistoryIdentity({sessionId:'other',scope:'other'},{terminal:e=>ends.push(e),refreshIdentity:async()=>{}});
    live.setLiveActivityIdentity({sessionId:'other',scope:'other'});
    release.resolve(response(page()));await pending;
    assert.equal(host.querySelector('.activity-turn'),null);assert.equal(ends.length,0);
});

test('suffix catch-up remains buffered so later live sequence cannot hide an earlier missed event',{timeout:10000},async()=>{
    live.ingestLiveActivity(events[0]!);const host=state.currentAgentDiv!;
    const waiting=Promise.withResolvers<void>();const release=Promise.withResolvers<Response>();
    const later:RuntimeEvent={...base,seq:10,kind:'reasoning',itemId:'later',operation:'append',text:'later live'};
    serve=async url=>{
        if(url.searchParams.get('after')==='0')return response(page(0,events.slice(0,2),{through:3,nextAfter:3,status:'running'}));
        waiting.resolve();return release.promise;
    };
    const pending=history.hydrateActivityHost(host,base.runId,true);await waiting.promise;
    live.ingestLiveActivity(later);
    release.resolve(response(page(3,[events[2]!,later],{through:10,nextAfter:10,status:'running'})));await pending;
    const model=live.findLiveActivity(base.runId)!.model;
    assert.equal(model.entries.size,3);assert.equal(model.entries.get('tool')?.kind,'tool');
    assert.equal(model.entries.get('later')?.kind,'reasoning');
});

test('live host attachment preserves a replay-owned seed before history mounting',{timeout:10000},async()=>{
    await live.restoreLiveActivity(async()=>events.slice(0,2));
    const turn=live.ingestLiveActivity(events[2]!);
    assert.ok(turn);assert.equal(turn.model.seq,8);assert.equal(turn.model.entries.size,2);
    assert.equal(turn.model.entries.get('comment')?.kind,'message');
});

test('interrupted histories release capacity through metadata without fabricated end events',{timeout:10000},async()=>{
    serve=async url=>{
        const runId=url.pathname.split('/')[3]!;
        const after=Number(url.searchParams.get('after')??0);
        return response(page(after,[{...events[0]!,runId}],{runId,through:1,nextAfter:1,status:'interrupted',incomplete:true,loss:'unavailable'}));
    };
    for(let i=0;i<16;i++){
        const runId=`tr_interrupted_${String(i).padStart(16,'0')}`;const host=message('SAVED ANSWER',runId);
        await history.hydrateActivityHost(host,runId);
        assert.equal(live.findLiveActivity(runId)?.model.end,null);
        assert.equal(live.findLiveActivity(runId)?.terminalStatus,'stopped');
    }
    const next=live.ingestLiveActivity({...events[0]!,runId:'tr_next_live_0123456789'});
    assert.ok(next);assert.equal(next.model.end,null);
});

test('repeated orphan discovery is bounded and exposes paging and discovery truncation',{timeout:10000},async()=>{
    let count=40;
    serve=async url=>{
        const after=url.searchParams.get('after')??'';
        const offset=after?Number(after.slice(3))+1:0;
        const rows=Array.from({length:Math.min(40,Math.max(0,count-offset))},(_,i)=>({id:`tr_${String(offset+i).padStart(16,'0')}`,messageId:null,status:'done',startedAt:offset+i}));
        return response({runs:rows,pageSize:40});
    };
    for(let i=0;i<4;i++)await history.discoverActivityHistory();
    assert.ok(document.querySelectorAll('[data-activity-discovered]').length<=16);
    document.querySelector<HTMLButtonElement>('#activityDiscovery [data-discovery-action="next"]')!.click();
    assert.equal(document.querySelectorAll('[data-activity-discovered]').length,16);
    assert.match(document.getElementById('activityDiscovery')!.textContent!,/Page 2 \/ 3/);
    count=300;await history.discoverActivityHistory();
    assert.ok(document.querySelectorAll('[data-activity-discovered]').length<=16);
    assert.match(document.getElementById('activityDiscovery')!.textContent!,/Discovery is limited/);
});
