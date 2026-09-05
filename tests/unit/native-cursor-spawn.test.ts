import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, get } from 'node:http';
import express from 'express';
import type { AcpSession } from '../../src/agent/runtime/acp/session.ts';
import type { ActivityPage, ActivityRunSummary } from '../../src/trace/activity-journal.ts';

const root = fs.mkdtempSync(join(tmpdir(), 'native-cursor-spawn-'));
const binary = join(root, 'cursor-agent.mjs');
fs.writeFileSync(binary, `#!/usr/bin/env node
import readline from 'node:readline';
const send = value => console.log(JSON.stringify(value));
let nativeId='private-native-session',model='m1',effort='low',promptId;
const configs=()=>[{id:'model',type:'select',name:'Model',category:'model',currentValue:model,options:[{value:'m1',name:'M1'},{value:'m2',name:'M2'}]},
 {id:'effort',type:'select',name:'Effort',category:'thought_level',currentValue:effort,options:[{value:'low',name:'Low'},{value:'high',name:'High'}]}];
const update=u=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:nativeId,update:u}});
const text=value=>update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:value}});
for await(const line of readline.createInterface({input:process.stdin})) {
 const r=JSON.parse(line),reply=result=>send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='initialize') reply({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'cursor_login'}]});
 if(r.method==='authenticate') reply({});
 if(r.method==='session/new'||r.method==='session/load') {nativeId=r.params.sessionId||nativeId;reply({sessionId:nativeId,configOptions:configs()});}
 if(r.method==='session/set_config_option'){if(r.params.configId==='model')model=r.params.value;else effort=r.params.value;reply({configOptions:configs()});}
 if(r.method==='session/prompt') {
  promptId=r.id; text('PRE-TOOL COMMENTARY');
  if(r.params.prompt[0].text.includes('HOLD_NATIVE_FIXTURE')) continue;
  update({sessionUpdate:'tool_call',toolCallId:'private-tool',title:'read',rawInput:{path:'fixture.txt'}});
  update({sessionUpdate:'tool_call_update',toolCallId:'private-tool',status:'completed',content:[{type:'content',content:{type:'text',text:'tool output'}}]});
  text('NATIVE_MAIN_FINAL');reply({stopReason:'end_turn'});
 }
 if(r.method==='session/cancel') send({jsonrpc:'2.0',id:promptId,result:{stopReason:'cancelled'}});
}
`);
fs.chmodSync(binary, 0o755);
const config = await import('../../src/core/config.ts');
config.settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: () => ({ available: true, path: binary }) } });
const factory = await import('../../src/agent/runtime/acp/cursor-session.ts');
const sessions: AcpSession[] = [];
const inputs: Parameters<typeof factory.createCursorSession>[0][] = [];
let beforeFactory: (() => Promise<void>) | undefined;
test.mock.module('../../src/agent/runtime/acp/cursor-session.js', { namedExports: { ...factory,
    createCursorSession: async (input: Parameters<typeof factory.createCursorSession>[0]) => {
        inputs.push(input); await beforeFactory?.();
        const session = await factory.createCursorSession(input); sessions.push(session); return session;
    } } });
const trace = await import('../../src/trace/store.ts');
const { spawnAgent, killActiveAgent, waitForExitSettled, activeMainProcesses, enqueueMessage, messageQueue, removeQueuedMessage } = await import('../../src/agent/spawn.ts');
const { db, getMaxMessageId, getSteerSalvageAfter } = await import('../../src/core/db.ts');
const database = await import('../../src/core/db.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
const { beginLiveRun, setLiveRunTraceId, getLiveRun, appendLiveRunTool } = await import('../../src/agent/live-run-state.ts');
const { clearGoalTimers } = await import('../../src/agent/lifecycle-handler.ts');
const { poolStats } = await import('../../src/agent/runtime-pool.ts');
const { beginRuntimeSettingsMutation } = await import('../../src/core/runtime-settings-gate.ts');
const { createChatSession, forkChatSession, setActiveChatSession } = await import('../../src/core/chat-sessions.ts');
const { readActivityPage } = await import('../../src/trace/activity-journal.ts');
const { registerTraceRoutes } = await import('../../src/routes/traces.ts');
let serial = 0;
test.beforeEach(t => {
    inputs.length = 0; beforeFactory = undefined;
    config.settings.cli = 'cursor'; config.settings.workingDir = root; config.settings.projectDirs = [root];
    config.settings.permissions = 'auto'; config.settings.fallbackOrder = []; config.settings.activeOverrides = {};
    config.settings.perCli = { ...config.settings.perCli, cursor: { model: 'm1', effort: 'low', transport: 'native' } };
    config.settings.memory = { ...config.settings.memory, enabled: false };
    config.settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
    fs.mkdirSync(join(config.JAW_HOME, 'prompts'), { recursive: true });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network in native fixture'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
});
test.afterEach(async () => {
    clearGoalTimers();
    for (const session of sessions.splice(0)) await session.close();
    assert.equal(poolStats().busy, 0);
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function options() {
    const id = ++serial;
    return { cli: 'cursor', model: 'm1', effort: 'low', origin: 'web', scopeKey: 'native-scope-' + id,
        chatSessionId: createChatSession('native-chat-' + id).id, requestId: 'native-request-' + id,
        sysPrompt: '', _skipHistory: true, _isSmokeContinuation: true };
}

for (const multiSession of [true, false]) test(`native main journal HTTP preserves exact owner, fork denial and replay (multiSession=${multiSession})`, { timeout: 15_000 }, async () => {
    config.settings.multiSession.enabled = multiSession;
    const opts = options();
    const other = createChatSession('unrelated-active-chat');
    const app = express();
    registerTraceRoutes(app, (_req, _res, next) => next());
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/traces`;
    const read = <T = ActivityPage>(path: string, status = 200) => new Promise<{ data: T }>((resolve, reject) => {
        const req = get(base + path, { signal: AbortSignal.timeout(3_000) }, res => {
            let body = '';
            res.setEncoding('utf8'); res.on('data', value => { body += value; });
            res.on('end', () => {
                try {
                    assert.equal(res.statusCode, status, path);
                    assert.equal(res.headers['cache-control'], 'no-store');
                    resolve(JSON.parse(body));
                } catch (error) { reject(error); }
            });
        });
        req.on('error', reject);
    });
    const ready = Promise.withResolvers<string>();
    const off = subscribe(event => {
        if (event.event === 'agent_runtime' && event.data['kind'] === 'message'
            && event.data['sessionId'] === opts.chatSessionId) ready.resolve(String(event.data['runId']));
    });
    let pending: ReturnType<typeof spawnAgent> | undefined;
    const timeout = setTimeout(() => ready.reject(new Error('native message not journaled')), 3_000);
    try {
        pending = spawnAgent('HOLD_NATIVE_FIXTURE', opts);
        const heldId = await ready.promise;
        clearTimeout(timeout);
        const path = `/${heldId}/activity?session=${opts.chatSessionId}`;
        const live = (await read(path)).data;
        assert.equal(live.status, 'running'); assert.equal(live.scope, opts.scopeKey);
        assert.equal(live.sessionId, opts.chatSessionId); assert.ok(live.events.length >= 2);
        assert.equal(live.incomplete, false);
        assert.ok(live.events.every((event: { sessionId: string; scope: string }) =>
            event.sessionId === opts.chatSessionId && event.scope === opts.scopeKey));
        await read(`/${heldId}/activity?session=${other.id}`, 404);
        await read(`/${heldId}?session=${other.id}`, 404);
        await read(`/${heldId}`, 404);
        await read(`/${heldId}?session=${opts.chatSessionId}`);
        assert.equal(killActiveAgent(opts.scopeKey, 'user'), true);
        await pending.promise; pending = undefined;
        const frozen = (await read(path + `&through=${live.through}`)).data;
        assert.deepEqual(frozen.events, live.events);
        assert.equal(frozen.through, live.through);
        const stopped = (await read(path + `&after=${live.through}`)).data;
        assert.equal(stopped.events.at(-1)?.kind, 'turn-end');
        assert.equal(stopped.events.at(-1)?.status, 'stopped');

        const result = await spawnAgent('complete journal fixture', opts).promise;
        assert.equal(result.text, 'NATIVE_MAIN_FINAL'); assert.ok(result.traceRunId);
        const runId = result.traceRunId;
        const row = trace.getTraceRun(runId)!;
        assert.equal(row.session_id, opts.chatSessionId); assert.equal(row.scope_key, opts.scopeKey);
        const message = db.prepare('SELECT content,trace_run_id FROM messages WHERE id=? AND session_id=?').get(row.message_id, opts.chatSessionId);
        assert.deepEqual(message, { content: 'NATIVE_MAIN_FINAL', trace_run_id: runId });
        const replayPath = `/${runId}/activity?session=${opts.chatSessionId}`;
        const first = (await read(replayPath + '&limit=1')).data;
        let page = first; const replay = [...first.events];
        while (page.hasMore) {
            const previous = page.nextAfter;
            page = (await read(replayPath + `&limit=1&after=${page.nextAfter}&through=${first.through}`)).data;
            assert.ok(page.nextAfter > previous, 'fixed-through replay must advance');
            assert.equal(page.through, first.through); replay.push(...page.events);
        }
        assert.equal(page.incomplete, false);
        assert.equal(replay.filter(event => event.kind === 'turn-end').length, 1);
        const end = replay.at(-1); assert.ok(end?.kind === 'turn-end');
        assert.equal(end.finalText, 'NATIVE_MAIN_FINAL');
        assert.ok(replay.some(event => event.kind === 'tool'));
        assert.doesNotMatch(JSON.stringify(replay), /private-native-session|private-tool/);
        const listed = (await read<{ runs: ActivityRunSummary[] }>(`/activity-runs?session=${opts.chatSessionId}`)).data.runs;
        assert.ok(listed.some((run: { id: string }) => run.id === runId));
        const fork = forkChatSession(opts.chatSessionId);
        assert.ok(fork.copiedCount > 0);
        assert.ok(db.prepare('SELECT id FROM messages WHERE session_id=? AND trace_run_id=?').get(fork.id, runId));
        await read(`/${runId}/activity?session=${fork.id}`, 404);
        await read(`/${runId}?session=${fork.id}`, 404);
        assert.deepEqual((await read<{ runs: ActivityRunSummary[] }>(`/activity-runs?session=${fork.id}`)).data.runs, []);
        await read(replayPath);
    } finally {
        clearTimeout(timeout); off();
        if (pending) { killActiveAgent(opts.scopeKey, 'user'); await pending.promise; }
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        setActiveChatSession('default');
    }
});

test('main actual factory/protocol/pool/lifecycle produces final-only MESSAGE and correlated native events', async () => {
    const opts = options(), events: Array<{ type: string; data: Record<string, any> }> = [];
    const off = subscribe(event => events.push({ type: event.event, data: event.data }));
    try {
        const result = await spawnAgent('fixture', opts).promise;
        assert.equal(result.code, 0); assert.equal(result.text, 'NATIVE_MAIN_FINAL');
        assert.equal(result.runtimeOutcome?.partialText, 'PRE-TOOL COMMENTARYNATIVE_MAIN_FINAL');
        assert.equal(inputs.length, 1); assert.equal(inputs[0]!.model, 'm1'); assert.equal(inputs[0]!.effort, 'low');
        assert.equal(events.some(event => event.type === 'agent_output'), false);
        const native = events.filter(event => event.type === 'agent_runtime').map(event => event.data);
        assert.equal(native.filter(event => event.kind === 'turn-end').length, 1);
        assert.ok(native.some(event => event.kind === 'tool'));
        assert.ok(native.every(event => event.scope === opts.scopeKey && event.sessionId === opts.chatSessionId));
        assert.doesNotMatch(JSON.stringify(native), /private-native-session|private-tool/);
        assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId, 'assistant'), [{ content: 'NATIVE_MAIN_FINAL' }]);
        assert.equal(activeMainProcesses.has(opts.scopeKey), false); assert.equal(poolStats().busy, 0);
        const again = await spawnAgent('second fixture', opts).promise;
        assert.equal(again.code, 0); assert.equal(inputs.length, 1, 'same scoped native process is reused');
    } finally { off(); }
});
test('journal failure cannot suppress full final, scoped non-text I/O liveness or completion', async () => {
    const opts = options(); const liveness: Record<string, any>[] = [];
    db.exec("CREATE TRIGGER cursor_journal_fault BEFORE INSERT ON trace_events WHEN new.source='runtime' BEGIN SELECT RAISE(ABORT,'fixture journal failure'); END");
    try {
    const result = await spawnAgent('fixture', { ...opts, lifecycle: {
        onActivity: (source, identity) => { assert.equal(source, 'native-runtime'); liveness.push(identity!); },
        onExit: () => { throw new Error('observer-only failure'); },
    } }).promise;
    assert.equal(result.text, 'NATIVE_MAIN_FINAL'); assert.equal(result.code, 0);
    assert.ok(liveness.length > 0);
    assert.ok(liveness.every(value => value.scope === opts.scopeKey && value.sessionId === opts.chatSessionId && value.requestId === opts.requestId));
    assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId, 'assistant'), [{ content: 'NATIVE_MAIN_FINAL' }]);
    const run = db.prepare('SELECT id FROM trace_runs WHERE session_id=?').get(opts.chatSessionId) as { id: string };
    const page = readActivityPage({ runId: run.id, sessionId: opts.chatSessionId, after: 0, limit: 40 });
    assert.ok(page?.incomplete, 'real runtime insert failure reached durable loss reporting');
    assert.deepEqual(page.events, []);
    } finally { db.exec('DROP TRIGGER cursor_journal_fault'); }
});
test('native kill-steer preserves partial MESSAGE before the exact exit barrier', async () => {
    const opts = options(), watermark = getMaxMessageId(opts.chatSessionId);
    let barrier: Promise<void> | undefined, salvage: string | null | undefined;
    const off = subscribe(event => {
        if (event.event !== 'agent_runtime' || event.data['kind'] !== 'message' || barrier) return;
        assert.equal(killActiveAgent(opts.scopeKey, 'steer'), true);
        barrier = waitForExitSettled(opts.scopeKey).then(() => { salvage = getSteerSalvageAfter(opts.chatSessionId, watermark); });
    });
    try {
        const result = await spawnAgent('HOLD_NATIVE_FIXTURE', opts).promise;
        assert.ok(barrier); await barrier;
        assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(result.runtimeOutcome.finalText, null);
        assert.equal(salvage, '⏹️ [interrupted]\n\nPRE-TOOL COMMENTARY');
        assert.equal(activeMainProcesses.has(opts.scopeKey), false);
    } finally { off(); }
});
test('explicit mention-watch binding survives multi-session off and a different active chat', async () => {
    config.settings.multiSession.enabled = false;
    const opts = { ...options(), origin: 'heartbeat', scopeKey: 'mention-watch:fixture-thread' };
    const result = await spawnAgent('fixture', opts).promise;
    assert.equal(result.text, 'NATIVE_MAIN_FINAL'); assert.equal(inputs[0]!.cwd, fs.realpathSync(root));
    assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId, 'assistant'), [{ content: 'NATIVE_MAIN_FINAL' }]);
});
test('restrictive native rejection occurs before actual prompt-file writes and factory admission', async t => {
    config.settings.permissions = 'safe'; const opts = options();
    const write = t.mock.method(fs, 'writeFileSync', () => { assert.fail('rejected native request wrote a prompt file'); });
    const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
    const result = await spawnAgent('not admitted', opts).promise;
    assert.equal(result.code, 78); assert.match(result.text, /restrictive/);
    assert.equal(inputs.length, 0); assert.equal(write.mock.callCount(), 0);
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM messages').get(), before);
});
test('old native finalization cannot clear or merge a replacement live run after early release', async () => {
    const opts = options(); let replaced = false;
    const listener = (type: string, data: Record<string, unknown>) => {
        if (type !== 'agent_status' || data['running'] !== false || data['scope'] !== opts.scopeKey || replaced) return;
        replaced = true; beginLiveRun(opts.scopeKey, 'cursor'); setLiveRunTraceId(opts.scopeKey, 'replacement-trace');
        appendLiveRunTool(opts.scopeKey, { icon: 'x', label: 'foreign replacement', toolType: 'tool' });
    };
    addBroadcastListener(listener);
    try {
        const result = await spawnAgent('fixture', opts).promise;
        assert.equal(result.text, 'NATIVE_MAIN_FINAL'); assert.equal(replaced, true);
        assert.equal(getLiveRun(opts.scopeKey).traceRunId, 'replacement-trace');
        const row = db.prepare('SELECT tool_log FROM messages WHERE session_id=? AND role=?').get(opts.chatSessionId, 'assistant') as { tool_log: string };
        assert.doesNotMatch(row.tool_log, /foreign replacement/);
    } finally { removeBroadcastListener(listener); }
});
test('failed user insert releases a lease acquired before ready attachment completed', async t => {
    const opts = options();
    t.mock.method(database.insertMessage, 'run', () => { throw new Error('fixture user insert failed'); });
    try {
        const result = await spawnAgent('fixture', opts).promise;
        assert.notEqual(result.code, 0);
        assert.equal(activeMainProcesses.has(opts.scopeKey), false);
        assert.equal(poolStats().busy, 0);
    } finally { activeMainProcesses.delete(opts.scopeKey); }
});
for (const stage of ['acquire', 'ready', 'settle'] as const) test(`native ${stage} failure wakes an already queued follow-up exactly once`, async t => {
    const opts = { ...options(), _isSmokeContinuation: false };
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    beforeFactory = async () => {
        if (inputs.length !== 1) return;
        entered.resolve(); await gate.promise;
        if (stage === 'acquire') throw new Error('fixture acquire failed');
    };
    if (stage !== 'acquire') {
        const statement = stage === 'ready' ? database.insertMessage : database.insertMessageWithTraceRun;
        const original = statement.run; let first = true;
        t.mock.method(statement, 'run', function (...args: any[]) {
            if (first) { first = false; throw new Error('fixture insert failed'); }
            return Reflect.apply(original, statement, args);
        });
    }
    const requestId = 'queued-' + opts.requestId;
    const terminals: Record<string, any>[] = [];
    const completed = Promise.withResolvers<void>();
    const off = subscribe(event => {
        if (event.event === 'orchestrate_done' && event.data['requestId'] === requestId) {
            terminals.push(event.data); completed.resolve();
        }
    });
    let queueId: string | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        const first = spawnAgent('first native run', opts);
        await entered.promise;
        queueId = enqueueMessage('queued native follow-up', 'web', { scope: opts.scopeKey, chatSessionId: opts.chatSessionId, requestId });
        assert.ok(messageQueue.some(item => item.id === queueId));
        gate.resolve();
        assert.notEqual((await first.promise).code, 0);
        await Promise.race([completed.promise, new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('queued follow-up was not woken after native failure')), 2_000);
        })]);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(terminals.length, 1); assert.equal(terminals[0]!['text'], 'NATIVE_MAIN_FINAL');
        assert.equal(messageQueue.some(item => item.id === queueId), false);
        assert.equal(inputs.length, 2); assert.equal(activeMainProcesses.has(opts.scopeKey), false);
    } finally {
        gate.resolve(); if (deadline) clearTimeout(deadline); off();
        if (queueId && messageQueue.some(item => item.id === queueId)) removeQueuedMessage(queueId);
    }
});
test('throwing failure-terminal listener cannot skip canonical finalization or trigger another terminal', async t => {
    const opts = options(); const events: Array<{ type: string; data: Record<string, any> }> = [];
    t.mock.method(database.insertMessageWithTraceRun, 'run', () => { throw new Error('fixture assistant insert failed'); });
    const off = subscribe(event => events.push({ type: event.event, data: event.data }));
    const fail = (type: string, data: Record<string, unknown>) => {
        if (type === 'agent_done' && data['sessionId'] === opts.chatSessionId) throw new Error('fixture terminal listener failed');
    };
    addBroadcastListener(fail);
    try {
        const result = await spawnAgent('fixture', opts).promise;
        assert.notEqual(result.code, 0); assert.equal(activeMainProcesses.has(opts.scopeKey), false);
        assert.equal(events.filter(event => event.type === 'agent_done').length, 1);
        const ends = events.filter(event => event.type === 'agent_runtime' && event.data['kind'] === 'turn-end');
        assert.equal(ends.length, 1); assert.equal(ends[0]!.data['status'], 'error');
        assert.equal(ends[0]!.data['finalText'], null);
        assert.equal(poolStats().busy, 0);
    } finally { off(); removeBroadcastListener(fail); }
});
test('actual settings wait preserves captured placement and cannot clear a replacement starting flag', async () => {
    const opts = { ...options(), _isSmokeContinuation: false };
    const endMutation = beginRuntimeSettingsMutation();
    const replacement = { process: null, starting: true, steering: false, ownerGeneration: 0,
        meta: { origin: 'web', scopeId: opts.scopeKey, chatSessionId: 'replacement-chat' } };
    const listener = (type: string, data: Record<string, unknown>) => {
        if (type === 'agent_done' && data['sessionId'] === opts.chatSessionId) activeMainProcesses.set(opts.scopeKey, replacement);
    };
    addBroadcastListener(listener);
    try {
        const run = spawnAgent('fixture', opts);
        assert.equal(inputs.length, 0); assert.equal(activeMainProcesses.get(opts.scopeKey)?.starting, true);
        config.settings.multiSession.enabled = false; endMutation();
        const result = await run.promise;
        assert.equal(result.text, 'NATIVE_MAIN_FINAL');
        assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId, 'assistant'), [{ content: 'NATIVE_MAIN_FINAL' }]);
        assert.equal(activeMainProcesses.get(opts.scopeKey), replacement);
        assert.equal(replacement.starting, true);
    } finally {
        endMutation(); removeBroadcastListener(listener);
        if (activeMainProcesses.get(opts.scopeKey) === replacement) activeMainProcesses.delete(opts.scopeKey);
    }
});
