import type { ActivityIdentity } from '../../../src/shared/presentation.js';
import type { RuntimeEvent } from '../../../src/shared/runtime-contract.js';
import { readActivityRun, readActivityRuns, type ActivityRunReadResult, type ActivityRunSummary } from '../../../src/shared/activity-read.js';
import { readActivityHttp, ActivityReadError } from './activity-http.js';
import { findLiveActivity, mountHistoryActivity, recycleActivityHost, restoreLiveActivity, setActivityReadHealth, settleLiveActivity } from './activity-live.js';
import { renderMarkdown } from '../render.js';

type End = Extract<RuntimeEvent, {kind:'turn-end'}>;
type Host = {runId:string; controller:AbortController; status:HTMLElement; retry:HTMLButtonElement; pending:boolean};
let identity: ActivityIdentity | null = null;
let generation = 0;
let queue: Promise<void> = Promise.resolve();
let discovery: AbortController | null = null;
let observer: IntersectionObserver | null = null;
let recoveredTerminal: ((event: End) => void) | null = null;
const hosts = new Map<HTMLElement, Host>();
const orphanHosts = new Map<string,HTMLElement>();
let orphanRows: ActivityRunSummary[] = [];
let orphanPage: number | null = null;
let discoveryIncomplete = false;

function current(message: HTMLElement, host: Host, captured: ActivityIdentity, epoch: number): boolean {
    return hosts.get(message) === host && !host.controller.signal.aborted && message.isConnected
        && generation === epoch && identity?.sessionId === captured.sessionId && identity.scope === captured.scope;
}

export function recycleActivityHistory(root: ParentNode): void {
    for (const message of root.querySelectorAll<HTMLElement>('.msg-agent[data-activity-key]')) recycleActivityHost(message);
    if (root instanceof HTMLElement && root.matches('.msg-agent[data-activity-key]')) recycleActivityHost(root);
    for (const [message, host] of hosts) {
        if (root !== message && !root.contains(message)) continue;
        host.controller.abort(); observer?.unobserve(message);
        recycleActivityHost(message); hosts.delete(message);
    }
}

export function setActivityHistoryIdentity(next: ActivityIdentity | null, onTerminal: (event: End) => void): void {
    recoveredTerminal = onTerminal;
    if (identity?.sessionId === next?.sessionId && identity?.scope === next?.scope) return;
    ++generation; discovery?.abort(); discovery = null;
    for (const [message, host] of hosts) { host.controller.abort(); recycleActivityHost(message); }
    hosts.clear(); observer?.disconnect(); observer = null;
    for (const message of orphanHosts.values()) message.remove();
    orphanHosts.clear(); orphanRows=[]; orphanPage=null;
    document.getElementById('activityDiscoveryNav')?.remove();
    if (document.getElementById('traceDrawerOverlay')) {
        void import('./trace-drawer.js').then(m=>m.closeTraceDrawer())
            .catch(error=>console.warn('[activity] trace close unavailable',error));
    }
    identity = next ? {...next} : null;
}

function entry(message: HTMLElement, runId: string): Host {
    const previous = hosts.get(message);
    if (previous && previous.runId === runId && !previous.controller.signal.aborted) return previous;
    previous?.controller.abort();
    message.querySelector('.activity-read-control')?.remove();
    const root = document.createElement('div'); root.className = 'activity-read-control';
    const status = document.createElement('p'); status.setAttribute('role','status');
    const retry = document.createElement('button'); retry.type='button'; retry.textContent='Load activity';
    root.append(status,retry);
    const body = message.querySelector('.agent-body'); body?.prepend(root);
    const host = {runId,controller:new AbortController(),status,retry,pending:false};
    retry.onclick = () => { void hydrateActivityHost(message,runId,true); };
    hosts.set(message,host);
    // Trace ownership is not inferred from a copied message's stored run link.
    message.querySelectorAll<HTMLButtonElement>('.process-step-trace').forEach(button => {button.disabled=true;});
    return host;
}

function allowTrace(message: HTMLElement): void {
    message.querySelectorAll<HTMLButtonElement>('.process-step-trace').forEach(button => {button.disabled=false;});
}

export function hydrateActivityHost(message: HTMLElement, runId: string, retry = false): Promise<void> {
    if (!identity || !runId || !message.isConnected) return Promise.resolve();
    if (!retry && message.querySelector('.activity-turn') && findLiveActivity(runId)?.message === message) return Promise.resolve();
    let host = entry(message,runId);
    if (host.pending) return Promise.resolve();
    if (retry) {host.controller.abort(); hosts.delete(message); host=entry(message,runId);}
    const captured = {...identity}; const epoch=generation;
    host.status.parentElement!.hidden=false;
    host.pending=true; host.retry.disabled=true; host.status.textContent='Loading activity…';
    const job = queue.catch(() => {}).then(async () => {
        if (!current(message,host,captured,epoch)) return;
        const result: {seed?:ActivityRunReadResult;tail?:ActivityRunReadResult} = {};
        try {
            await restoreLiveActivity(async replaySignal => {
                const signal=AbortSignal.any([host.controller.signal,replaySignal]);
                result.seed=await readActivityRun({runId,sessionId:captured.sessionId,signal,read:readActivityHttp});
                if (!current(message,host,captured,epoch) || result.seed.scope !== captured.scope) throw new Error('activity_scope_changed');
                // Buffer live ingress through the suffix read too, then atomically fold
                // seed + catch-up + queued live events in sequence order.
                result.tail=await readActivityRun({runId,sessionId:captured.sessionId,after:result.seed.through,signal,read:readActivityHttp});
                if (!current(message,host,captured,epoch) || result.tail.scope !== captured.scope) throw new Error('activity_scope_changed');
                return [...result.seed.events,...result.tail.events];
            });
            if (!current(message,host,captured,epoch) || !result.seed || !result.tail) return;
            const tail=result.tail;
            const turn=mountHistoryActivity(message,runId);
            if (tail.status !== 'running') settleLiveActivity(runId,tail.status==='interrupted'?'stopped':tail.status);
            const incomplete=result.seed.incomplete || tail.incomplete;
            setActivityReadHealth(runId,incomplete);
            allowTrace(message);
            host.status.textContent=incomplete ? 'Some activity is unavailable. The saved answer is unchanged.'
                : turn ? '' : result.seed.events.length || tail.events.length
                    ? 'Activity display limit reached. Close earlier details and retry.'
                    : 'No retained activity is available for this turn.';
            host.retry.hidden=!incomplete && !!turn;
            host.status.parentElement!.hidden=!incomplete && !!turn;
            host.retry.textContent='Retry activity';
            const end=[...result.seed.events,...tail.events].reverse().find((event):event is End=>event.kind==='turn-end');
            if (end) {
                if (message.dataset['activityOrphan']==='true') {
                    const answer=message.querySelector<HTMLElement>('.msg-content');
                    if (answer) {answer.innerHTML=end.finalText ? renderMarkdown(end.finalText) : '';answer.dataset['raw']=end.finalText??'';}
                }
                recoveredTerminal?.(end);
            }
        } catch (error) {
            if (!current(message,host,captured,epoch)) return;
            host.status.textContent=error instanceof ActivityReadError ? error.message : 'Activity could not be restored. Retry to load it again.';
            host.retry.hidden=false; host.retry.textContent='Retry activity';
            // Older owned traces may have raw diagnostics but no semantic journal.
            if (error instanceof ActivityReadError && error.status===404) {
                try {
                    await readActivityHttp(`/api/traces/${encodeURIComponent(runId)}?${new URLSearchParams({session:captured.sessionId})}`,host.controller.signal);
                    if (current(message,host,captured,epoch)) {
                        allowTrace(message);
                        host.status.textContent='Detailed Activity was not recorded for this turn. The saved transcript is shown.';
                        host.retry.hidden=true;
                    }
                } catch {
                    if (current(message,host,captured,epoch)) host.retry.hidden=true;
                    // Keep unavailable/copied foreign trace controls disabled.
                }
            }
        } finally {
            host.pending=false;
            if (current(message,host,captured,epoch)) host.retry.disabled=false;
        }
    });
    queue=job.catch(() => {});
    return job;
}

export function observeActivityHistory(root: ParentNode): void {
    if (!identity) return;
    if (!observer && typeof IntersectionObserver !== 'undefined') observer=new IntersectionObserver(entries=>{
        for (const item of entries) if (item.isIntersecting) {
            const message=item.target as HTMLElement;
            void hydrateActivityHost(message,message.dataset['traceRunId']??'');
        }
    },{root:document.getElementById('chatMessages')});
    for (const message of root.querySelectorAll<HTMLElement>('.msg-agent[data-trace-run-id]')) {
        if (message.querySelector('.activity-turn') && findLiveActivity(message.dataset['traceRunId']!)?.message === message) continue;
        entry(message,message.dataset['traceRunId']!);
        if (observer) observer.observe(message);
        else void hydrateActivityHost(message,message.dataset['traceRunId']!);
    }
}

export async function discoverActivityHistory(): Promise<void> {
    if (!identity) return;
    discovery?.abort(); discovery=new AbortController();
    const captured={...identity}; const epoch=generation; const controller=discovery;
    try {
        const found=await readActivityRuns({sessionId:captured.sessionId,signal:controller.signal,read:readActivityHttp});
        if (controller.signal.aborted || epoch!==generation) return;
        const chat=document.getElementById('chatMessages'); if (!chat) return;
        const linked=new Set([...chat.querySelectorAll<HTMLElement>('[data-trace-run-id]:not([data-activity-orphan])')].map(el=>el.dataset['traceRunId']));
        orphanRows=found.runs.filter(row=>row.messageId===null && !linked.has(row.id));
        discoveryIncomplete=found.incomplete;
        renderOrphans(chat);
        observeActivityHistory(chat);
    } catch (error) {
        if (!controller.signal.aborted) console.warn('[activity] history discovery unavailable',error);
    }
}

function renderOrphans(chat: HTMLElement): void {
    const last=Math.max(0,Math.ceil(orphanRows.length/16)-1);
    const page=Math.min(orphanPage??last,last);
    const shown=orphanRows.slice(page*16,(page+1)*16);
    const wanted=new Set(shown.map(row=>row.id));
    for (const [runId,message] of orphanHosts) {
        if (wanted.has(runId) && message.isConnected) continue;
        recycleActivityHistory(message);message.remove();orphanHosts.delete(runId);
    }
    let nav=document.getElementById('activityDiscoveryNav');
    if (!nav) {
        nav=document.createElement('nav');nav.id='activityDiscoveryNav';nav.className='activity-discovery-nav';
        nav.setAttribute('aria-label','Activity without saved messages');
        const earlier=document.createElement('button');earlier.type='button';earlier.textContent='Earlier activity';earlier.dataset['direction']='earlier';
        const later=document.createElement('button');later.type='button';later.textContent='Later activity';later.dataset['direction']='later';
        const label=document.createElement('p');label.setAttribute('role','status');
        const lastPage=()=>Math.max(0,Math.ceil(orphanRows.length/16)-1);
        earlier.onclick=()=>{orphanPage=Math.max(0,(orphanPage??lastPage())-1);renderOrphans(chat);observeActivityHistory(chat);};
        later.onclick=()=>{orphanPage=Math.min(lastPage(),(orphanPage??lastPage())+1);renderOrphans(chat);observeActivityHistory(chat);};
        nav.append(earlier,label,later);chat.append(nav);
    }
    nav.hidden=orphanRows.length===0 && !discoveryIncomplete;
    nav.querySelector<HTMLButtonElement>('[data-direction="earlier"]')!.disabled=page===0;
    nav.querySelector<HTMLButtonElement>('[data-direction="later"]')!.disabled=page>=last;
    nav.querySelector('p')!.textContent=`Activity without saved messages: ${orphanRows.length? page+1:0} / ${orphanRows.length?last+1:0}.`
        +(discoveryIncomplete?' Discovery is limited; more activity may exist outside this window.':'');
    for (const run of shown) {
        if (orphanHosts.has(run.id)) continue;
        const message=document.createElement('div');message.className='msg msg-agent';
        message.dataset['traceRunId']=run.id;message.dataset['activityOrphan']='true';
        const body=document.createElement('div');body.className='agent-body';
        const answer=document.createElement('div');answer.className='msg-content';
        body.append(answer);message.append(body);chat.append(message);orphanHosts.set(run.id,message);
    }
}
