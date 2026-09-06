import '../setup/isolated-home.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ClaudeSessionOptions } from '../../src/agent/runtime/claude-sdk-session.js';
import express from 'express';
import type { AddressInfo } from 'node:net';

const fetchLoopback = globalThis.fetch;

const root = fs.mkdtempSync(join(tmpdir(), 'native-claude-spawn-'));
const printBinary = join(root, 'claude-print-fixture.mjs');
fs.writeFileSync(printBinary, `#!/usr/bin/env node
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'PRINT_FIXTURE_READY'}]}}));
process.on('SIGTERM',()=>process.exit(0));
setTimeout(()=>process.exit(99),10000);
`);
fs.chmodSync(printBinary, 0o755);
let detectedBinary = process.execPath;
const childCode = String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
let turns=0, waiting;
const finish=(message,text)=> {
 const result={type:'result',subtype:'success',is_error:false,session_id:'private-claude-session',
  uuid:'result-'+turns,user_message_uuid:message.uuid,num_turns:turns,duration_ms:25,total_cost_usd:turns*0.125,
  usage:{input_tokens:11,output_tokens:7,cache_read_input_tokens:3}};
 if(!text.includes('ABSENT_FINAL')) result.result=text.includes('EMPTY_FINAL')?'':'CLAUDE_FINAL';
 send({type:'assistant',parent_tool_use_id:null,message:{id:'final-'+turns,content:[{type:'text',text:'CLAUDE_FINAL'}]}});
 send(result);
};
readline.createInterface({input:process.stdin}).on('line',line=> {
 const message=JSON.parse(line);
 if(message.fixtureDecision) {
  const value=waiting; waiting=null;
  if(value.id) send({type:'user',parent_tool_use_id:null,message:{content:[{type:'tool_result',tool_use_id:value.id,content:'late fixture tool output'}]}});
  finish(value.message,value.text); return;
 }
 turns++;
 const content=message.message.content;
 const text=typeof content==='string'?content:content.filter(x=>x.type==='text').map(x=>x.text).join('');
 process.stderr.write('fixture progress\n');
 send({type:'system',subtype:'init',session_id:'private-claude-session',permissionMode:'default'});
 send({type:'assistant',parent_tool_use_id:null,message:{id:'partial-'+turns,content:[{type:'text',text:'PRE-TOOL COMMENTARY'}]}});
 if(text.includes('HOLD_NATIVE_FIXTURE')) return;
 const question=text.includes('ASK_QUESTION'), approval=text.includes('ASK_APPROVAL');
 const tool=question?'AskUserQuestion':approval?'Bash':'Read', id='private-tool-'+turns;
 const input=question?{questions:[{question:'Choose color?',header:'Color',multiSelect:false,options:[{label:'Blue'},{label:'Green'}]}]}
  :approval?{command:'pwd'}:{file_path:'fixture.txt'};
 send({type:'assistant',parent_tool_use_id:null,message:{id:'tool-'+turns,content:[{type:'tool_use',id,name:tool,input}]}});
 if(text.includes('HOLD_TOOL_PROGRESS')) { waiting={message,text,id}; send({fixturePause:true}); return; }
 if(question||approval) { waiting={message,text}; send({fixturePermission:true,tool,id,input}); return; }
 send({type:'user',parent_tool_use_id:null,message:{content:[{type:'tool_result',tool_use_id:id,content:'fixture tool output'}]}});
 finish(message,text);
});
setTimeout(()=>process.exit(99),10000);
`;
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: () => ({ available: true, path: detectedBinary }) } });
type QueryInput = Parameters<NonNullable<ClaudeSessionOptions['queryFactory']>>[0];
const queries: Array<{ options: QueryInput['options']; child: ChildProcessWithoutNullStreams; messages: any[]; decisions: any[]; done: Promise<void> }> = [];
let beforeFixtureResume: (() => Promise<void>) | undefined;
test.mock.module('../../src/agent/runtime/claude-sdk-loader.js', { namedExports: { loadClaudeSdk: async () => ({ query: ({ prompt, options }: QueryInput) => {
    const controller = new AbortController();
    const child = options.spawnClaudeCodeProcess!({ command: process.execPath, args: ['-e', childCode],
        cwd: options.cwd, env: process.env, signal: controller.signal }) as ChildProcessWithoutNullStreams;
    const messages: any[] = [], decisions: any[] = [];
    const done = (async () => { for await (const message of prompt) { messages.push(message); child.stdin.write(JSON.stringify(message) + '\n'); } })();
    void done.catch(() => {});
    queries.push({ options, child, messages, decisions, done });
    return {
        close() { controller.abort(); child.stdin.end(); },
        async *[Symbol.asyncIterator]() {
            for await (const line of createInterface({ input: child.stdout })) {
                const frame = JSON.parse(line);
                if (frame.fixturePause) {
                    await beforeFixtureResume?.(); child.stdin.write(JSON.stringify({ fixtureDecision: true }) + '\n');
                } else if (frame.fixturePermission) {
                    const decision = await options.canUseTool!(frame.tool, frame.input, { toolUseID: frame.id, requestId: 'sdk-control-' + frame.id, signal: controller.signal });
                    decisions.push(decision); child.stdin.write(JSON.stringify({ fixtureDecision: decision }) + '\n');
                } else yield frame;
            }
        },
    };
} }) } });
const factory = await import('../../src/agent/runtime/claude-sdk-session.ts');
const sessions: InstanceType<typeof factory.ClaudeSdkSession>[] = [];
const inputs: ClaudeSessionOptions[] = [];
const factoryDone: Promise<void>[] = [];
let beforeFactory: ((input: ClaudeSessionOptions) => Promise<void>) | undefined;
test.mock.module('../../src/agent/runtime/claude-sdk-session.js', { namedExports: { ...factory,
    createClaudeSdkSession: (input: ClaudeSessionOptions) => {
        const result = (async () => {
            inputs.push(input); await beforeFactory?.(input);
            const session = await factory.createClaudeSdkSession({ ...input }); sessions.push(session); return session;
        })();
        factoryDone.push(result.then(() => {}, () => {})); return result;
    } } });
const lifecycle = await import('../../src/agent/lifecycle-handler.ts');
let beforeLifecycle: ((input: Parameters<typeof lifecycle.handleAgentExit>[0]) => Promise<void>) | undefined;
test.mock.module('../../src/agent/lifecycle-handler.js', { namedExports: { ...lifecycle,
    handleAgentExit: async (input: Parameters<typeof lifecycle.handleAgentExit>[0]) => {
        await beforeLifecycle?.(input); return lifecycle.handleAgentExit(input);
    } } });
const { spawnAgent, killActiveAgent, killAgentById, killAllAgents, waitForExitSettled, waitForProcessEnd,
    waitForAllProcessesEnd, activeMainProcesses, activeProcesses } = await import('../../src/agent/spawn.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { poolStats } = await import('../../src/agent/runtime-pool.ts');
const { runtimeRequests } = await import('../../src/agent/runtime/requests.ts');
const { hasClaudeRuns, hasClaudeWorker, reserveClaudeRun } = await import('../../src/agent/runtime/claude-run-controls.ts');
const { bumpScopeSessionGeneration } = await import('../../src/agent/session-persistence.ts');
const { claimWorker, getWorkerSlot, getWorkerProgressSnapshot, clearWorkersForScope } = await import('../../src/orchestrator/worker-registry.ts');
const { createChatSession, setActiveChatSession } = await import('../../src/core/chat-sessions.ts');
const { registerRuntimeRequestRoutes } = await import('../../src/routes/runtime-requests.ts');
const { runSingleAgent } = await import('../../src/orchestrator/distribute.ts');
const { addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');
let serial = 0;
const gates: Array<() => void> = [];
function deferred() {
    const value = Promise.withResolvers<void>(); gates.push(value.resolve); return value;
}
function options() {
    const id = ++serial;
    const chatSessionId = createChatSession('Native journal fixture ' + id).id;
    setActiveChatSession('default');
    return { cli: 'claude', model: 'default', effort: 'low', origin: 'web', scopeKey: 'claude-scope-' + id,
        chatSessionId, requestId: 'claude-request-' + id,
        sysPrompt: '', _skipHistory: true, _isSmokeContinuation: true };
}
const runTest = (name: string, fn: (t: TestContext) => Promise<void>) => test(name, { concurrency: false, timeout: 6000 }, fn);

test.beforeEach(t => {
    inputs.length = 0; queries.length = 0; factoryDone.length = 0; beforeFactory = undefined; beforeLifecycle = undefined;
    beforeFixtureResume = undefined; detectedBinary = process.execPath;
    config.settings.cli = 'claude'; config.settings.workingDir = root; config.settings.projectDirs = [root];
    config.settings.permissions = 'auto'; config.settings.fallbackOrder = []; config.settings.activeOverrides = {};
    config.settings.perCli = { ...config.settings.perCli, claude: { model: 'default', effort: 'low', transport: 'native' } };
    config.settings.memory = { ...config.settings.memory, enabled: false };
    config.settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
    fs.mkdirSync(join(config.JAW_HOME, 'prompts'), { recursive: true });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network in native Claude fixture'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
});
test.afterEach(async () => {
    beforeFactory = undefined; beforeLifecycle = undefined; gates.splice(0).forEach(resolve => resolve());
    killAllAgents('user'); await waitForAllProcessesEnd(2000); lifecycle.clearGoalTimers();
    await Promise.all(factoryDone);
    for (const session of sessions.splice(0)) await session.close();
    for (const query of queries) {
        await query.done;
        assert.ok(query.child.exitCode !== null || query.child.signalCode !== null);
    }
    assert.equal(hasClaudeRuns(), false); assert.equal(poolStats().busy, 0);
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));


runTest('worker closes its child before removing its isolated instruction directory', async () => {
    const opts = { ...options(), agentId: 'worker-' + serial, sysPrompt: 'Worker-only instructions' };
    let cwd = '', existedDuringClose = false;
    beforeFactory = async input => { cwd = input.prepared.cwd; assert.match(fs.readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), /Worker-only/); };
    beforeLifecycle = async () => {
        existedDuringClose = fs.existsSync(cwd);
        assert.ok(queries[0]!.child.exitCode !== null || queries[0]!.child.signalCode !== null);
    };
    const result = await spawnAgent('worker fixture', opts).promise;
    assert.equal(result.code, 0); assert.equal(result.text, 'CLAUDE_FINAL'); assert.notEqual(cwd, root);
    assert.equal(existedDuringClose, true); assert.equal(fs.existsSync(cwd), false);
    assert.equal(activeProcesses.has(opts.agentId), false); assert.equal(hasClaudeWorker(opts.agentId), false);
});


runTest('pending worker cancellation settles logically but retains ID, cwd and shutdown wait until factory cleanup', async () => {
    const entered = deferred(), gate = deferred(); let cwd = '';
    beforeFactory = async input => { cwd = input.prepared.cwd; entered.resolve(); await gate.promise; };
    const opts = { ...options(), agentId: 'pending-worker-' + serial, sysPrompt: 'Worker instructions' };
    const run = spawnAgent('pending worker', opts); await entered.promise;
    assert.equal(hasClaudeWorker(opts.agentId), true); assert.equal(activeProcesses.has(opts.agentId), false);
    const duplicate = await spawnAgent('duplicate worker', opts).promise;
    assert.equal(duplicate.code, 78); assert.equal(inputs.length, 1);
    let factorySettled = false;
    void Promise.all(factoryDone).then(() => { factorySettled = true; });
    assert.equal(killAgentById(opts.agentId), true);
    const result = await run.promise;
    assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(queries.length, 0);
    assert.equal(factorySettled, false, 'logical settlement must not require the blocked factory');
    assert.equal(hasClaudeWorker(opts.agentId), true); assert.equal(hasClaudeRuns(opts.scopeKey), true);
    assert.equal(fs.existsSync(cwd), true, 'unknown factory cleanup must retain the worker directory');
    assert.equal((await spawnAgent('replacement before cleanup', opts).promise).code, 78);
    assert.equal(inputs.length, 1);
    assert.equal(killAllAgents('user'), true);
    let shutdownDone = false, scopedDone = false;
    const shutdown = waitForAllProcessesEnd(2000).then(() => { shutdownDone = true; });
    const scoped = waitForProcessEnd(opts.scopeKey, 2000).then(() => { scopedDone = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shutdownDone, false, 'shutdown must include unleased physical cleanup');
    assert.equal(scopedDone, false); assert.equal(fs.existsSync(cwd), true);
    assert.equal(hasClaudeWorker(opts.agentId), true); assert.equal(queries.length, 0);
    gate.resolve();
    await Promise.all(factoryDone); await Promise.all([shutdown, scoped]);
    assert.equal(factorySettled, true); assert.equal(shutdownDone, true); assert.equal(scopedDone, true);
    assert.equal(hasClaudeRuns(opts.scopeKey), false); assert.equal(queries.length, 0);
    assert.equal(hasClaudeWorker(opts.agentId), false);
    assert.equal(fs.existsSync(cwd), false, 'cancelled worker directory remains after factory rejection and logical finalization');
});


runTest('worker in the same scope completes independently while the main query remains leased', async () => {
    const ready = deferred(), opts = options();
    const main = spawnAgent('HOLD_NATIVE_FIXTURE', { ...opts, lifecycle: { onActivity: () => { ready.resolve(); } } });
    await ready.promise;
    const mainChild = activeMainProcesses.get(opts.scopeKey)?.process;
    const worker = await spawnAgent('parallel worker', { ...opts, agentId: 'parallel-worker-' + serial,
        sysPrompt: 'Worker instructions' }).promise;
    assert.equal(worker.text, 'CLAUDE_FINAL'); assert.equal(queries.length, 2);
    assert.equal(activeMainProcesses.get(opts.scopeKey)?.process, mainChild);
    assert.equal(poolStats().busy, 1); assert.equal(hasClaudeRuns(opts.scopeKey), true);
    assert.equal(killActiveAgent(opts.scopeKey, 'steer'), true);
    assert.equal((await main.promise).runtimeOutcome?.status, 'stopped');
});


runTest('shutdown and scoped wait include Claude worker logical settlement after process maps clear', async () => {
    const ready = deferred(), lifecycleEntered = deferred(), settle = deferred();
    const opts = { ...options(), agentId: 'shutdown-worker-' + serial, sysPrompt: 'Worker instructions',
        lifecycle: { onActivity: () => { ready.resolve(); } } };
    beforeLifecycle = async () => { lifecycleEntered.resolve(); await settle.promise; };
    try {
        const run = spawnAgent('HOLD_NATIVE_FIXTURE', opts); await ready.promise;
        assert.equal(killAllAgents('user'), true); await lifecycleEntered.promise;
        assert.equal(activeProcesses.size, 0); assert.equal(hasClaudeRuns(opts.scopeKey), true);
        let globalDone = false, scopedDone = false;
        const globalWait = waitForAllProcessesEnd(2000).then(() => { globalDone = true; });
        const scopedWait = waitForProcessEnd(opts.scopeKey, 2000).then(() => { scopedDone = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(globalDone, false); assert.equal(scopedDone, false);
        settle.resolve(); assert.equal((await run.promise).runtimeOutcome?.status, 'stopped');
        await Promise.all([globalWait, scopedWait]); assert.equal(hasClaudeRuns(), false);
    } finally { settle.resolve(); }
});


runTest('retained native worker rejects a new print assignment until logical settlement ends', async () => {
    const entered = deferred(), settle = deferred(), printed = deferred();
    const opts = { ...options(), agentId: 'native-to-print-' + serial, sysPrompt: 'Worker instructions' };
    beforeLifecycle = async () => { entered.resolve(); await settle.promise; };
    const native = spawnAgent('native worker', opts); await entered.promise;
    killAllAgents('user');
    assert.equal(activeProcesses.has(opts.agentId), false); assert.equal(hasClaudeWorker(opts.agentId), true);
    config.settings.perCli.claude.transport = 'print'; detectedBinary = printBinary;
    const blocked = await spawnAgent('must not replace native', opts).promise;
    assert.equal(blocked.code, 78); assert.equal(inputs.length, 1); assert.equal(activeProcesses.has(opts.agentId), false);
    settle.resolve(); await native.promise;
    assert.equal(hasClaudeWorker(opts.agentId), false);
    const allowed = spawnAgent('print after native settles', { ...opts, lifecycle: { onActivity: () => { printed.resolve(); } } });
    await printed.promise; assert.ok(allowed.child?.pid);
    assert.equal(killAgentById(opts.agentId), true); await allowed.promise;
});


runTest('a new native Claude worker cannot replace an existing print worker child', async () => {
    config.settings.perCli.claude.transport = 'print'; detectedBinary = printBinary;
    const printed = deferred(), opts = { ...options(), agentId: 'print-to-native-' + serial, sysPrompt: 'Worker instructions' };
    const existing = spawnAgent('existing print worker', { ...opts, lifecycle: { onActivity: () => { printed.resolve(); } } });
    await printed.promise; const child = activeProcesses.get(opts.agentId);
    assert.ok(child?.pid);
    config.settings.perCli.claude.transport = 'native'; detectedBinary = process.execPath;
    const blocked = await spawnAgent('must not replace print', opts).promise;
    assert.equal(blocked.code, 78); assert.equal(inputs.length, 0);
    assert.equal(activeProcesses.get(opts.agentId), child); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    assert.equal(killAgentById(opts.agentId), true); await existing.promise;
});


runTest('tool progress updates the captured worker slot before final and cannot overwrite a replacement slot', async () => {
    const entered = deferred(), gate = deferred(), opts = { ...options(), agentId: 'progress-worker-' + serial, sysPrompt: 'Worker instructions' };
    const slot = claimWorker({ id: opts.agentId }, 'Inspect fixture', { scopeId: opts.scopeKey, chatSessionId: opts.chatSessionId });
    beforeFixtureResume = async () => { entered.resolve(); await gate.promise; };
    let completed = false;
    const run = spawnAgent('HOLD_TOOL_PROGRESS', opts); void run.promise.then(() => { completed = true; });
    await entered.promise;
    assert.equal(completed, false); assert.equal(getWorkerSlot(opts.agentId), slot);
    assert.equal(slot.state, 'running'); assert.equal(slot.result, null); assert.ok(slot.progressUpdatedAt);
    assert.ok(slot.tools.some(tool => tool.label === 'Read'));
    assert.ok(getWorkerProgressSnapshot(opts.agentId)?.current?.tools.some(tool => tool.label === 'Read'));
    clearWorkersForScope(opts.scopeKey);
    const replacement = claimWorker({ id: opts.agentId }, 'Replacement task', { scopeId: opts.scopeKey });
    gate.resolve(); assert.equal((await run.promise).text, 'CLAUDE_FINAL');
    assert.equal(getWorkerSlot(opts.agentId), replacement); assert.deepEqual(replacement.tools, []);
});

for (const kind of ['ASK_APPROVAL', 'ASK_QUESTION']) runTest(`${kind}: real distribute placement maps notice while HTTP retains worker execution IDs`, async t => {
    config.settings.permissions = 'safe';
    const chat = createChatSession('Native worker response'); setActiveChatSession(chat.id);
    const app = express(); app.use(express.json());
    registerRuntimeRequestRoutes(app, (_req, _res, next) => next());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const events: Array<{ event: string; data: Record<string, unknown> }> = [], broadcasts: string[] = [];
    const ready = Promise.withResolvers<void>();
    const timer = setTimeout(() => ready.reject(new Error('worker request did not become visible')), 4000);
    t.after(() => clearTimeout(timer));
    const off = subscribe(event => {
        events.push(event);
        if (event.event === 'agent_runtime_requests_changed' && event.data.sessionId === chat.id) ready.resolve();
    });
    const listener = (name: string) => { broadcasts.push(name); };
    addBroadcastListener(listener); t.after(() => { off(); removeBroadcastListener(listener); });
    const employee = { id: 'request-worker-' + ++serial, name: 'Request worker', role: 'developer', cli: 'claude', model: 'default' };
    claimWorker(employee, kind); // Same unqualified claim as API dispatch without a current Boss run.
    const work = runSingleAgent({ task: kind, role: 'developer', currentPhase: 3, currentPhaseIdx: 0,
        phaseProfile: [3], parallel: false }, employee, {}, 1, { origin: 'api', projectDirs: [root] }, []);
    await ready.promise; clearTimeout(timer);
    const listed = await fetchLoopback(`${base}/api/runtime/requests?sessionId=${chat.id}`);
    assert.equal(listed.status, 200);
    const pending = (await listed.json()).data.requests[0]; assert.ok(pending);
    assert.equal(pending.sessionId, chat.id); assert.equal(pending.scope, 'default');
    const notice = events.find(event => event.event === 'agent_runtime_requests_changed')!.data;
    assert.equal(notice.scope, 'local:' + chat.id); assert.notEqual(notice.scope, pending.scope);
    assert.deepEqual(Object.keys(notice).sort(), ['scope', 'sessionId', 'version']);
    const response = kind === 'ASK_APPROVAL' ? { optionId: 'allow' } : { answers: { q0: { selected: ['o1'] } } };
    const body = { runId: pending.runId, sessionId: pending.sessionId, scope: pending.scope, turnId: pending.turnId, response };
    const wrong = await fetchLoopback(`${base}/api/runtime/requests/${pending.requestId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, scope: notice.scope }) });
    assert.equal(wrong.status, 409); assert.equal(runtimeRequests.list(chat.id).length, 1);
    const accepted = await fetchLoopback(`${base}/api/runtime/requests/${pending.requestId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(accepted.status, 200); assert.equal((await accepted.json()).data.accepted, true);
    const result = await work; assert.equal(result.text, 'CLAUDE_FINAL'); assert.equal(queries.length, 1);
    const { db } = await import('../../src/core/db.ts');
    const { getTraceRun } = await import('../../src/trace/store.ts');
    const { readActivityPage } = await import('../../src/trace/activity-journal.ts');
    const trace = getTraceRun(pending.runId)!;
    assert.equal(trace.session_id, chat.id); assert.equal(trace.scope_key, pending.scope);
    assert.equal(trace.audience, 'internal'); assert.equal(trace.status, 'done');
    const rows = db.prepare("SELECT event_type FROM trace_events WHERE run_id=? AND source='runtime' ORDER BY seq")
        .all(pending.runId) as { event_type: string }[];
    assert.equal(rows[0]?.event_type, 'turn-start'); assert.equal(rows.at(-1)?.event_type, 'turn-end');
    assert.ok(rows.some(row => row.event_type === 'request'));
    assert.equal(readActivityPage({ runId: pending.runId, sessionId: chat.id, after: 0, limit: 40 }), null);
    assert.equal(queries[0]!.decisions.length, 1);
    assert.equal(queries[0]!.decisions[0].behavior, 'allow');
    if (kind === 'ASK_QUESTION') assert.deepEqual(queries[0]!.decisions[0].updatedInput.answers, { 'Choose color?': 'Green' });
    assert.equal(events.filter(event => event.event === 'agent_runtime_requests_changed').length, 2);
    assert.equal(events.filter(event => event.event === 'agent_runtime').length, 0, 'internal worker canonical frames stay private');
    assert.equal(broadcasts.includes('agent_runtime_requests_changed'), false);
    assert.equal(runtimeRequests.list(chat.id).length, 0); assert.equal(hasClaudeWorker(employee.id), false);
    assert.ok(queries[0]!.child.exitCode !== null || queries[0]!.child.signalCode !== null);
});

runTest('native deny profile refuses before employee directory or SDK creation', async t => {
    const mkdir = t.mock.method(fs, 'mkdtempSync', () => { throw new Error('forbidden worker directory creation'); });
    const result = await spawnAgent('memory extractor fixture', { ...options(), agentId: 'memory-flush',
        internal: true, permissions: 'deny', sysPrompt: 'Extract only; no tool access.' }).promise;
    assert.equal(result.code, 78); assert.match(result.text, /auto or safe permissions/);
    assert.equal(mkdir.mock.callCount(), 0); assert.equal(inputs.length, 0); assert.equal(queries.length, 0);
});
