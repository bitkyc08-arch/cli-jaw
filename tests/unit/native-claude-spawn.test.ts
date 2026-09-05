import '../setup/isolated-home.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ClaudeSessionOptions } from '../../src/agent/runtime/claude-sdk-session.js';

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
 const text=message.message.content.filter(x=>x.type==='text').map(x=>x.text).join('');
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
                    const decision = await options.canUseTool!(frame.tool, frame.input, { toolUseID: frame.id, signal: controller.signal });
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
const trace = await import('../../src/trace/store.ts');
let failJournal = false;
test.mock.module('../../src/trace/store.js', { namedExports: { ...trace,
    appendTraceEvent: (...args: Parameters<typeof trace.appendTraceEvent>) => {
        if (failJournal) throw new Error('fixture journal failure'); return trace.appendTraceEvent(...args);
    } } });
const { spawnAgent, killActiveAgent, killAgentById, killAllAgents, waitForExitSettled, waitForProcessEnd,
    waitForAllProcessesEnd, activeMainProcesses, activeProcesses, enqueueMessage, messageQueue, removeQueuedMessage } = await import('../../src/agent/spawn.ts');
const database = await import('../../src/core/db.ts');
const { db, getMaxMessageId, getSteerSalvageAfter } = database;
const { subscribe } = await import('../../src/core/event-bus.ts');
const { poolStats } = await import('../../src/agent/runtime-pool.ts');
const { runtimeRequests } = await import('../../src/agent/runtime/requests.ts');
const { hasClaudeRuns, hasClaudeWorker } = await import('../../src/agent/runtime/claude-run-controls.ts');
const { bumpScopeSessionGeneration } = await import('../../src/agent/session-persistence.ts');
const { getLiveRun, beginLiveRun, setLiveRunTraceId, replaceLiveRunTools, clearLiveRun } = await import('../../src/agent/live-run-state.ts');
const { claimWorker, getWorkerSlot, getWorkerProgressSnapshot, clearWorkersForScope } = await import('../../src/orchestrator/worker-registry.ts');
let serial = 0;
const gates: Array<() => void> = [];
function deferred() {
    const value = Promise.withResolvers<void>(); gates.push(value.resolve); return value;
}
function options() {
    const id = ++serial;
    return { cli: 'claude', model: 'default', effort: 'low', origin: 'web', scopeKey: 'claude-scope-' + id,
        chatSessionId: 'claude-chat-' + id, requestId: 'claude-request-' + id,
        sysPrompt: '', _skipHistory: true, _isSmokeContinuation: true };
}
const runTest = (name: string, fn: (t: TestContext) => Promise<void>) => test(name, { concurrency: false, timeout: 6000 }, fn);
function assistantRows(session: string) {
    return db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(session, 'assistant');
}
test.beforeEach(t => {
    inputs.length = 0; queries.length = 0; factoryDone.length = 0; beforeFactory = undefined; beforeLifecycle = undefined; failJournal = false;
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

runTest('main two turns use the public factory once and deliver full lifecycle results with final-only messages', async () => {
    const opts = options(), events: Array<{ type: string; data: Record<string, any> }> = [];
    const off = subscribe(event => events.push({ type: event.event, data: event.data }));
    try {
        const first = await spawnAgent('first fixture', opts).promise;
        const second = await spawnAgent('second fixture', opts).promise;
        for (const result of [first, second]) {
            assert.equal(result.code, 0); assert.equal(result.text, 'CLAUDE_FINAL');
            assert.equal(result.runtimeOutcome?.partialText, 'CLAUDE_FINAL');
            assert.equal(result.sessionId, 'private-claude-session');
            assert.equal(result.cost, 0.125); assert.ok(result.tools?.length); assert.ok(result.smoke); assert.equal(result.diagnostic, '');
        }
        assert.notEqual(first.traceRunId, second.traceRunId);
        assert.equal(inputs.length, 1); assert.equal(queries.length, 1); assert.equal(queries[0]!.messages.length, 2);
        assert.equal(inputs[0]!.deferTurnEnd, true);
        assert.equal(events.some(event => event.type === 'agent_output'), false);
        const native = events.filter(event => event.type === 'agent_runtime').map(event => event.data);
        assert.equal(native.filter(event => event.kind === 'turn-end').length, 2);
        assert.ok(native.some(event => event.kind === 'tool'));
        assert.ok(native.some(event => event.kind === 'message' && event.text === 'PRE-TOOL COMMENTARY'));
        assert.ok(native.every(event => event.scope === opts.scopeKey && event.sessionId === opts.chatSessionId));
        assert.doesNotMatch(JSON.stringify(native), /private-claude-session|private-tool-/);
        assert.deepEqual(assistantRows(opts.chatSessionId), [{ content: 'CLAUDE_FINAL' }, { content: 'CLAUDE_FINAL' }]);
        assert.equal(activeMainProcesses.has(opts.scopeKey), false);
    } finally { off(); }
});

runTest('journal failure preserves direct final and scoped child I/O liveness', async () => {
    failJournal = true; const opts = options(), identities: any[] = [];
    const result = await spawnAgent('fixture', { ...opts, lifecycle: {
        onActivity: (source, identity) => { assert.equal(source, 'native-runtime'); identities.push(identity); },
        onExit: () => { throw new Error('fixture observer failure'); },
    } }).promise;
    assert.equal(result.text, 'CLAUDE_FINAL'); assert.equal(result.code, 0);
    assert.ok(identities.length > 0);
    assert.ok(identities.every(value => value.scope === opts.scopeKey && value.sessionId === opts.chatSessionId && value.requestId === opts.requestId));
    assert.deepEqual(assistantRows(opts.chatSessionId), [{ content: 'CLAUDE_FINAL' }]);
});

for (const kind of ['EMPTY_FINAL', 'ABSENT_FINAL']) runTest(`${kind} never promotes commentary or partial final into MESSAGE`, async () => {
    const opts = options(), result = await spawnAgent(kind, opts).promise;
    assert.equal(result.code, 0); assert.equal(result.text, '');
    assert.equal(result.runtimeOutcome?.finalText, kind === 'EMPTY_FINAL' ? '' : null);
    assert.ok(assistantRows(opts.chatSessionId).every((row: any) => !row.content.includes('COMMENTARY') && !row.content.includes('CLAUDE_FINAL')));
});

runTest('Stop steer writes interrupted salvage before the captured exit-settle barrier resolves', async () => {
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
        assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(result.runtimeOutcome?.finalText, null);
        assert.equal(salvage, '⏹️ [interrupted]\n\nPRE-TOOL COMMENTARY');
        assert.equal(activeMainProcesses.has(opts.scopeKey), false); assert.equal(hasClaudeRuns(opts.scopeKey), false);
    } finally { off(); }
});

runTest('explicit scope/chat binding survives multi-session off', async () => {
    config.settings.multiSession.enabled = false;
    const opts = { ...options(), origin: 'heartbeat', scopeKey: 'mention-watch:claude-fixture' };
    assert.equal((await spawnAgent('fixture', opts).promise).text, 'CLAUDE_FINAL');
    assert.deepEqual(assistantRows(opts.chatSessionId), [{ content: 'CLAUDE_FINAL' }]);
});

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

for (const kind of ['ASK_APPROVAL', 'ASK_QUESTION']) runTest(`${kind} uses captured real registry ownership and SDK permission response`, async () => {
    config.settings.permissions = 'safe'; const opts = options(), seen: any[] = [];
    const off = subscribe(event => {
        if (event.event !== 'agent_runtime' || event.data['kind'] !== 'request') return;
        const request = event.data; seen.push(request);
        assert.equal(request['sessionId'], opts.chatSessionId); assert.equal(request['scope'], opts.scopeKey);
        const response = kind === 'ASK_APPROVAL' ? { optionId: 'allow' } : { answers: { q0: { selected: ['o1'] } } };
        runtimeRequests.respond(request['requestId'] as string, request as any, response);
    });
    try {
        assert.equal((await spawnAgent(kind, opts).promise).text, 'CLAUDE_FINAL'); assert.equal(seen.length, 1);
        assert.equal(seen[0].requestType, kind === 'ASK_APPROVAL' ? 'approval' : 'question');
        assert.equal(queries[0]!.decisions[0].behavior, 'allow');
        if (kind === 'ASK_QUESTION') assert.deepEqual(queries[0]!.decisions[0].updatedInput.answers, { 'Choose color?': 'Green' });
    } finally { off(); }
});

runTest('image input reaches the actual SDK user-message envelope', async () => {
    const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };
    const result = await spawnAgent('image fixture', { ...options(), images: [image] }).promise;
    assert.equal(result.code, 0);
    assert.deepEqual(queries[0]!.messages[0].message.content.find((value: any) => value.type === 'image'), {
        type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data },
    });
});

runTest('generation invalidated during pending factory cannot attach or write a user message', async () => {
    const entered = deferred(), gate = deferred(), opts = options();
    beforeFactory = async () => { entered.resolve(); await gate.promise; };
    const run = spawnAgent('stale owner', opts); await entered.promise;
    bumpScopeSessionGeneration(opts.scopeKey); gate.resolve();
    assert.notEqual((await run.promise).code, 0);
    assert.deepEqual(db.prepare('SELECT role FROM messages WHERE session_id=?').all(opts.chatSessionId), []);
    assert.equal(activeMainProcesses.has(opts.scopeKey), false);
});

for (const stage of ['acquire', 'ready', 'settle'] as const) runTest(`${stage} failure wakes one queued follow-up through actual spawn and lifecycle`, async t => {
    const opts = { ...options(), _isSmokeContinuation: false }, entered = deferred(), gate = deferred(), completed = deferred();
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
    const requestId = 'queued-' + opts.requestId, terminals: any[] = [];
    const off = subscribe(event => {
        if (event.event === 'orchestrate_done' && event.data['requestId'] === requestId) { terminals.push(event.data); completed.resolve(); }
    });
    let queueId: string | undefined;
    try {
        const first = spawnAgent('first native run', opts); await entered.promise;
        queueId = enqueueMessage('queued fixture', 'web', { scope: opts.scopeKey, chatSessionId: opts.chatSessionId, requestId });
        gate.resolve(); assert.notEqual((await first.promise).code, 0);
        await completed.promise; await waitForProcessEnd(opts.scopeKey, 2000);
        assert.equal(terminals.length, 1); assert.equal(terminals[0].text, 'CLAUDE_FINAL');
        assert.equal(messageQueue.some(item => item.id === queueId), false); assert.equal(inputs.length, 2);
    } finally { gate.resolve(); off(); if (queueId && messageQueue.some(item => item.id === queueId)) removeQueuedMessage(queueId); }
});

for (const failure of ['malformed image', 'lifecycle throw']) runTest(`${failure} leaves neither a running trace nor live run`, async () => {
    const opts = options(), statuses: any[] = [];
    if (failure === 'lifecycle throw') beforeLifecycle = async () => { throw new Error('fixture lifecycle failure'); };
    const off = subscribe(event => {
        if (event.event === 'agent_status' && event.data['scope'] === opts.scopeKey) statuses.push(event.data);
    });
    try {
        const run = spawnAgent('failure fixture', { ...opts,
            ...(failure === 'malformed image' ? { images: [{ mimeType: 'image/invalid', data: 'broken' }] } : {}) });
        const result = await run.promise;
        assert.notEqual(result.code, 0); assert.ok(result.traceRunId);
        const recorded = trace.getTraceRun(result.traceRunId!);
        assert.equal(recorded?.status, 'error'); assert.ok(recorded?.finished_at);
        assert.equal(getLiveRun(opts.scopeKey).running, false); assert.equal(activeMainProcesses.has(opts.scopeKey), false);
        assert.equal(hasClaudeRuns(opts.scopeKey), false);
        assert.ok(statuses.some(value => value.running === true)); assert.ok(statuses.some(value => value.running === false));
        if (failure === 'malformed image') assert.equal(queries[0]!.messages.length, 0);
    } finally { off(); }
});

runTest('old failed terminalization closes its trace without replacing a foreign live tool list', async () => {
    const opts = options(), replacementTrace = 'replacement-' + opts.requestId;
    let oldTrace: string | undefined, replacement: ReturnType<typeof getLiveRun> | undefined;
    beforeLifecycle = async input => {
        oldTrace = input.ctx.traceRunId;
        assert.ok(oldTrace); assert.equal(getLiveRun(opts.scopeKey).traceRunId, oldTrace);
        assert.ok(input.ctx.toolLog.some(tool => tool.label === 'Read'), 'old run must have tools available to overwrite the replacement');
        beginLiveRun(opts.scopeKey, 'claude'); setLiveRunTraceId(opts.scopeKey, replacementTrace);
        replaceLiveRunTools(opts.scopeKey, [{ icon: 'x', label: 'replacement-only tool', toolType: 'tool',
            status: 'running', detail: 'owned by the replacement trace' }]);
        replacement = getLiveRun(opts.scopeKey);
        throw new Error('fixture lifecycle failed after live ownership changed');
    };
    try {
        const result = await spawnAgent('old run with tool output', opts).promise;
        assert.notEqual(result.code, 0); assert.equal(result.traceRunId, oldTrace);
        assert.ok(oldTrace); assert.ok(replacement);
        const closed = trace.getTraceRun(oldTrace);
        assert.equal(closed?.status, 'error'); assert.ok(closed?.finished_at);
        assert.deepEqual(getLiveRun(opts.scopeKey), replacement);
        assert.equal(getLiveRun(opts.scopeKey).running, true);
        assert.deepEqual(getLiveRun(opts.scopeKey).toolLog.map(tool => tool.label), ['replacement-only tool']);
        assert.equal(activeMainProcesses.has(opts.scopeKey), false); assert.equal(hasClaudeRuns(opts.scopeKey), false);
    } finally {
        if (getLiveRun(opts.scopeKey).traceRunId === replacementTrace) clearLiveRun(opts.scopeKey);
    }
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
