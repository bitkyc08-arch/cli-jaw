import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiRpcSession } from '../../src/agent/pi-runtime.ts';

const root = mkdtempSync(join(tmpdir(),'pi-spawn-finality-'));
const binary = join(root,'pi.mjs');
writeFileSync(binary, `#!/usr/bin/env node
import readline from 'node:readline';
if(process.argv.includes('--version')) {console.log('0.83.0');process.exit(0);}
const send = row => console.log(JSON.stringify(row));
for await(const line of readline.createInterface({input:process.stdin})) {
 const r = JSON.parse(line);
 if(r.type==='get_state') send({id:r.id,type:'response',command:r.type,success:true,data:{sessionId:'private-session'}});
 if(r.type==='prompt') {
  send({type:'agent_start'});
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'PROVISIONAL /goal done'}});
  if(process.env.PI_SPAWN_HOLD==='1') continue;
  send({type:'agent_end',willRetry:false,messages:[{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'PROVISIONAL /goal done'}]},
   {role:'assistant',stopReason:'stop',content:[{type:'text',text:'FINAL ONLY'}]}]});
  send({type:'agent_settled'});
 }
}
`);
chmodSync(binary,0o755);
const previousBin = process.env.PI_CODING_AGENT_BIN;
process.env.PI_CODING_AGENT_BIN = binary;
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js',{namedExports:{...config,detectCli:() => ({available:true,path:null})}});
const pi = await import('../../src/agent/pi-runtime.ts');
const sessions: PiRpcSession[] = [];
const directDirectories: string[] = [];
let onText: (() => void) | undefined;
test.mock.module('../../src/agent/pi-runtime.js',{namedExports:{...pi,
    spawnPiRpc:(...args: Parameters<typeof pi.spawnPiRpc>) => {
        directDirectories.push(args[2].cwd); return pi.spawnPiRpc(...args);
    },
    spawnPersistentPiRpc:(...args: Parameters<typeof pi.spawnPersistentPiRpc>) => {
        const session = pi.spawnPersistentPiRpc(...args);
        const send = session.sendPrompt.bind(session);
        session.sendPrompt = (message,opts) => send(message,{...opts,onEvent:event => {
            opts?.onEvent?.(event); if(event.kind==='text') onText?.();
        }});
        sessions.push(session); return session;
    },
}});
const trace = await import('../../src/trace/store.ts');
let failRawTrace = false, failActivityJournal = false, rawFailures = 0, journalFailures = 0;
test.mock.module('../../src/trace/store.js',{namedExports:{...trace,
    appendTraceEvent:(...args: Parameters<typeof trace.appendTraceEvent>) => {
        if(failRawTrace && args[0].eventType?.startsWith('pi_rpc:')) {
            rawFailures++; throw new Error('fixture raw trace failed');
        }
        return trace.appendTraceEvent(...args);
    },
}});
const journal = await import('../../src/trace/activity-journal.ts');
test.mock.module('../../src/trace/activity-journal.js',{namedExports:{...journal,
    appendActivityBody:(...args: Parameters<typeof journal.appendActivityBody>) => {
        if(failActivityJournal) { journalFailures++; throw new Error('fixture activity journal failed'); }
        return journal.appendActivityBody(...args);
    },
}});
const { createChatSession, setActiveChatSession } = await import('../../src/core/chat-sessions.ts');
const {spawnAgent,killActiveAgent,waitForExitSettled,activeMainProcesses} = await import('../../src/agent/spawn.ts');
const {db,getMaxMessageId,getSteerSalvageAfter} = await import('../../src/core/db.ts');
const {subscribe} = await import('../../src/core/event-bus.ts');
const {clearGoalTimers} = await import('../../src/agent/lifecycle-handler.ts');
const {poolStats} = await import('../../src/agent/runtime-pool.ts');
let serial = 0;
test.beforeEach(context => {
    failRawTrace=false;failActivityJournal=false;rawFailures=0;journalFailures=0;directDirectories.length=0;onText=undefined;delete process.env.PI_SPAWN_HOLD;
    config.settings.workingDir = root;mkdirSync(join(root,'prompts'),{recursive:true});
    mkdirSync(join(config.JAW_HOME,'prompts'),{recursive:true});
    config.settings.fallbackOrder=[];config.settings.activeOverrides={};
    config.settings.pi=pi.normalizePiSettings(pi.DEFAULT_PI_SETTINGS);
    config.settings.perCli={...config.settings.perCli,pi:{model:'fixture',effort:'high',provider:'progrok'}};
    config.settings.memory={...config.settings.memory,enabled:false};
    config.settings.multiSession={enabled:true,maxConcurrent:4,midRunPolicy:'steer',channels:{telegram:true,discord:true,slack:true}};
    context.mock.method(globalThis,'fetch',async () => {throw new Error('unexpected network');});
    context.mock.method(console,'log',() => {});context.mock.method(console,'warn',() => {});context.mock.method(console,'error',() => {});
});
test.afterEach(async () => {
    onText=undefined;clearGoalTimers();
    for(const session of sessions.splice(0)) {
        if(session.child.exitCode!==null || session.child.signalCode!==null) continue;
        const closed=once(session.child,'close');session.kill();await closed;
    }
    assert.equal(poolStats().busy,0);
});
test.after(() => {
    if(previousBin===undefined) delete process.env.PI_CODING_AGENT_BIN;else process.env.PI_CODING_AGENT_BIN=previousBin;
    delete process.env.PI_SPAWN_HOLD;rmSync(root,{recursive:true,force:true});
});
function options() {
    const id=++serial;
    const chat = createChatSession('Pi typed finality fixture'); setActiveChatSession('default');
    return {cli:'pi',model:'fixture',effort:'high',scopeKey:'pi-final-scope-'+id,chatSessionId:chat.id,
        requestId:'pi-final-request-'+id,origin:'web',sysPrompt:'',_skipInsert:true,_skipHistory:true,_skipResume:true,
        _skipSessionPersist:true,_isSmokeContinuation:true};
}
test('actual pooled Pi-to-lifecycle final uses only typed final and canonical jaw identity',async () => {
    const opts=options();const events: Record<string,unknown>[]=[];
    const unsub=subscribe(event => {if(event.event==='agent_runtime') events.push(event.data as Record<string,unknown>);});
    try {
        const result=await spawnAgent('fixture',opts).promise;
        assert.equal(result.text,'FINAL ONLY');
        assert.deepEqual(result.runtimeOutcome,{status:'done',finalText:'FINAL ONLY',partialText:'PROVISIONAL /goal doneFINAL ONLY'});
        const rows=db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId,'assistant');
        assert.deepEqual(rows,[{content:'FINAL ONLY'}]);
        const ends=events.filter(event => event.kind==='turn-end');
        assert.equal(ends.length,1);assert.equal(ends[0]?.finalText,'FINAL ONLY');
        assert.ok(events.every(event => event.sessionId===opts.chatSessionId && event.scope===opts.scopeKey));
        assert.doesNotMatch(JSON.stringify(events),/private-session/);
        const traceId = String(ends[0]?.runId);
        assert.equal(trace.getTraceRun(traceId)?.session_id, opts.chatSessionId);
        assert.ok(journal.readActivityPage({runId:traceId,sessionId:opts.chatSessionId,after:0,limit:40})?.events.length);
    } finally {unsub();}
});
test('throwing exit observer cannot bypass lifecycle cleanup or final MESSAGE',async () => {
    const opts=options();
    const result=await spawnAgent('fixture',{...opts,lifecycle:{onExit:() => {throw new Error('fixture observer');}}}).promise;
    assert.equal(result.text,'FINAL ONLY');assert.equal(result.code,0);
    assert.equal(result.runtimeOutcome?.status,'done');
    assert.equal(activeMainProcesses.has(opts.scopeKey),false);
    assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId,'assistant'),[{content:'FINAL ONLY'}]);
});
test('kill-steered Pi rejection stores interrupted MESSAGE before the real exit barrier despite raw trace failure',async () => {
    process.env.PI_SPAWN_HOLD='1';failRawTrace=true;
    const opts=options();const watermark=getMaxMessageId(opts.chatSessionId);
    let barrier:Promise<void>|undefined;let observed:string|null|undefined;
    onText=() => {
        onText=undefined;
        assert.equal(killActiveAgent(opts.scopeKey,'steer'),true);
        barrier=waitForExitSettled(opts.scopeKey).then(() => {observed=getSteerSalvageAfter(opts.chatSessionId,watermark);});
    };
    const result=await spawnAgent('hold',opts).promise;
    assert.ok(barrier,'real text callback armed kill-steer and exit barrier');await barrier;
    assert.deepEqual(result.runtimeOutcome,{status:'stopped',finalText:null,partialText:'PROVISIONAL /goal done'});
    assert.equal(observed,'⏹️ [interrupted]\n\nPROVISIONAL /goal done');
    assert.equal(result.text,'');assert.notEqual(result.code,0);
    assert.equal(activeMainProcesses.has(opts.scopeKey),false);
    assert.ok(rawFailures > 0, 'raw failure injection must actually fire');
    assert.equal(journalFailures, 0);
});

test('user stop preserves partial outcome without inventing a final response',async () => {
    process.env.PI_SPAWN_HOLD='1';
    const opts=options();
    onText=() => {onText=undefined;assert.equal(killActiveAgent(opts.scopeKey,'user'),true);};
    const result=await spawnAgent('hold',opts).promise;
    assert.deepEqual(result.runtimeOutcome,{status:'stopped',finalText:null,partialText:'PROVISIONAL /goal done'});
    assert.equal(result.text,'');assert.notEqual(result.code,0);
    assert.equal(activeMainProcesses.has(opts.scopeKey),false);
    assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId,'assistant'),[]);
});

for (const stop of [false, true]) test(`activity journal append failure cannot replace ${stop ? 'steer salvage' : 'the final MESSAGE'} or strand settlement`, {timeout:10_000}, async () => {
    failActivityJournal = true;
    if(stop) process.env.PI_SPAWN_HOLD='1';
    const opts=options(); const watermark=getMaxMessageId(opts.chatSessionId);
    let barrier:Promise<void>|undefined, observed:string|null|undefined;
    if(stop) onText=() => {
        onText=undefined;
        assert.equal(killActiveAgent(opts.scopeKey,'steer'),true);
        barrier=waitForExitSettled(opts.scopeKey).then(() => {observed=getSteerSalvageAfter(opts.chatSessionId,watermark);});
    };
    const result=await spawnAgent(stop?'hold':'fixture',opts).promise;
    assert.ok(journalFailures>0,'canonical journal injection must fire independently');
    assert.equal(rawFailures,0);
    const traceId=result.traceRunId;
    assert.ok(traceId);
    assert.ok(trace.listTraceEvents(traceId,0,200).events.some(row=>row.source==='cli_raw'),'raw storage still succeeds');
    if(stop) {
        assert.ok(barrier);await barrier;
        assert.equal(observed,'⏹️ [interrupted]\n\nPROVISIONAL /goal done');
        assert.equal(result.runtimeOutcome?.status,'stopped');assert.equal(result.runtimeOutcome?.finalText,null);
    } else {
        assert.equal(result.text,'FINAL ONLY');assert.equal(result.runtimeOutcome?.status,'done');
        assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId,'assistant'),[{content:'FINAL ONLY'}]);
    }
    assert.equal(activeMainProcesses.has(opts.scopeKey),false);
});

test('raw trace append failure reports degraded Activity while preserving the exact final MESSAGE', {timeout:10_000}, async () => {
    failRawTrace=true;
    const opts=options();const result=await spawnAgent('fixture',opts).promise;
    assert.equal(result.text,'FINAL ONLY');assert.ok(rawFailures>0);assert.equal(journalFailures,0);
    assert.ok(result.traceRunId);
    const page=journal.readActivityPage({runId:result.traceRunId,sessionId:opts.chatSessionId,after:0,limit:40});
    assert.ok(page?.events.some(row=>row.kind==='turn-start'), JSON.stringify(page));
    assert.equal(page.incomplete, true);
    assert.equal(page.loss, 'storage_error', 'raw failure deliberately reports persistence degradation through the existing projection');
    assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId,'assistant'),[{content:'FINAL ONLY'}]);
});

test('throwing activity hook cannot corrupt accepted partial or final selection', {timeout:10_000}, async () => {
    const opts=options();let calls=0;
    const result=await spawnAgent('fixture',{...opts,lifecycle:{onActivity:()=>{calls++;throw Error('observer fixture');}}}).promise;
    assert.ok(calls>0);assert.equal(result.text,'FINAL ONLY');
    assert.equal(result.runtimeOutcome?.partialText,'PROVISIONAL /goal doneFINAL ONLY');
});

test('real employee direct Pi uses typed final and cleans its owned temporary directory', {timeout:10_000}, async () => {
    const opts=options();
    const run=spawnAgent('fixture',{...opts,agentId:'pi-typed-worker',sysPrompt:'fixture worker instructions'});
    assert.ok(run.child);
    const closed=once(run.child,'close');
    const result=await run.promise;await closed;
    assert.equal(result.text,'FINAL ONLY');assert.equal(result.runtimeOutcome?.status,'done');
    assert.equal(result.runtimeOutcome?.finalText,'FINAL ONLY');
    assert.equal(result.runtimeOutcome?.partialText,'PROVISIONAL /goal doneFINAL ONLY');
    assert.ok(result.traceRunId);
    const traceRow=trace.getTraceRun(result.traceRunId)!;
    assert.equal(traceRow.audience,'internal');
    assert.equal(journal.readActivityPage({runId:result.traceRunId,sessionId:opts.chatSessionId,after:0,limit:40}),null);
    assert.equal(directDirectories.length,1);
    assert.notEqual(directDirectories[0],root);
    assert.equal(existsSync(directDirectories[0]!),false);
});
