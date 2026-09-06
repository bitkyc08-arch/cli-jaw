import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get } from 'node:http';
import fs from 'node:fs';
import { join } from 'node:path';
import express from 'express';

const home = process.env.CLI_JAW_HOME!;
const script = join(home, 'setup-error-peer.mjs');
const wirePath = join(home, 'peer-wire.jsonl');
let peerMode = 'setup';
let onSetupFailure: (() => void) | undefined;
const setupErrors: string[] = [];
fs.writeFileSync(script, `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const mode=process.argv[3];
for await (const line of readline.createInterface({input:process.stdin})) {
 const r=JSON.parse(line); appendFileSync(process.argv[2], JSON.stringify({method:r.method})+'\\n');
 const reply=result=>send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='initialize') reply({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'cursor_login'}]});
 if(r.method==='authenticate') reply({});
 if(r.method==='session/new') {
  if(mode==='ready'||mode==='settle'||mode==='complete') reply({sessionId:'private-peer-session',configOptions:[]});
  else {
   const error={jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'PRIVATE_SETUP_ERROR_SENTINEL'}};
   send(error);if(mode==='duplicate')send(error);
  }
 }
 if(r.method==='session/prompt') {
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'private-peer-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'MODEL_FINAL'}}}});
  reply({stopReason:'end_turn'});
 }
}
`);
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: () => ({ available: true, path: process.execPath }) } });
const factory = await import('../../src/agent/runtime/acp/cursor-session.ts');
const children: ChildProcess[] = [];
let failRelease = false;
let releaseFaults = 0;
test.mock.module('../../src/agent/runtime/acp/cursor-session.js', { namedExports: { ...factory,
    createCursorSession: async (input: Parameters<typeof factory.createCursorSession>[0]) => {
        try { return await factory.createCursorSession({
        ...input, requestTimeoutMs: 1000,
        spawnImpl: ((_command, _args, options) => {
            const child = spawn(process.execPath, [script, wirePath, peerMode], options);
            children.push(child); return child;
        }) as typeof spawn,
        }); } catch (error) {
            setupErrors.push(error instanceof Error ? error.message : String(error));
            onSetupFailure?.(); throw error;
        }
    },
} });
const pool = await import('../../src/agent/runtime-pool.ts');
test.mock.module('../../src/agent/runtime-pool.js', { namedExports: { ...pool,
    acquireCursorRuntime: async (input: Parameters<typeof pool.acquireCursorRuntime>[0]) => {
        const lease = await pool.acquireCursorRuntime(input);
        return { ...lease, release: () => {
            lease.release();
            if (failRelease) { releaseFaults++; throw new Error('fixture late release failed'); }
        } };
    },
} });
const { spawnAgent, activeMainProcesses, killActiveAgent, waitForExitSettled } = await import('../../src/agent/spawn.ts');
const { db, insertMessage, insertMessageWithTraceRun } = await import('../../src/core/db.ts');
const { createChatSession } = await import('../../src/core/chat-sessions.ts');
const { getTraceRun, startTraceRun, finalizeTraceRun } = await import('../../src/trace/store.ts');
const { clearGoalTimers } = await import('../../src/agent/lifecycle-handler.ts');
const { poolStats } = await import('../../src/agent/runtime-pool.ts');
const { registerEventsRoutes } = await import('../../src/routes/events.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { AcpRuntimeSession } = await import('../../src/agent/runtime/acp/runtime-session.ts');
const { addBroadcastListener, removeBroadcastListener } = await import('../../src/core/bus.ts');

test.beforeEach(t => {
    fs.writeFileSync(wirePath, '');
    peerMode = 'setup'; onSetupFailure = undefined;
    setupErrors.length = 0;
    failRelease = false; releaseFaults = 0;
    config.settings.cli = 'cursor'; config.settings.workingDir = home; config.settings.projectDirs = [home];
    config.settings.permissions = 'auto'; config.settings.fallbackOrder = []; config.settings.activeOverrides = {};
    config.settings.perCli = { ...config.settings.perCli, cursor: { model: 'default', effort: '', transport: 'native' } };
    config.settings.memory = { ...config.settings.memory, enabled: false };
    config.settings.multiSession = { enabled: true, maxConcurrent: 4, midRunPolicy: 'steer' };
    fs.mkdirSync(join(home, 'prompts'), { recursive: true });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected provider or messaging network'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
});
test.afterEach(async () => {
    clearGoalTimers();
    for (const child of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }
    assert.equal(poolStats().busy, 0);
});

test('immediate Stop before acquisition admits one stopped turn and closes its header before exit settlement', async () => {
    const owner = createChatSession('immediate Stop owner'); const scope = `local:${owner.id}`;
    const packets: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = subscribe(value => packets.push(value));
    try {
        const operation = spawnAgent('do not acquire', { cli: 'cursor', model: 'default', effort: '', origin: 'web',
            scopeKey: scope, chatSessionId: owner.id, sysPrompt: '', _skipHistory: true, _isSmokeContinuation: true });
        assert.equal(killActiveAgent(scope, 'steer'), true);
        const settled = waitForExitSettled(scope);
        const result = await operation.promise; await settled;
        assert.equal(result.code, 130); assert.equal(result.runtimeOutcome?.finalText, null);
        assert.equal(fs.readFileSync(wirePath, 'utf8'), '');
        const owned = packets.filter(p => p.data.sessionId === owner.id);
        const start = owned.findIndex(p => p.event === 'agent_runtime' && p.data.kind === 'turn-start');
        const done = owned.findIndex(p => p.event === 'agent_done');
        const end = owned.findIndex(p => p.event === 'agent_runtime' && p.data.kind === 'turn-end');
        assert.ok(start >= 0 && start < done && done < end);
        assert.equal(owned.filter(p => p.event === 'agent_done').length, 1);
        const run = String(owned[done]!.data.traceRunId);
        assert.equal(getTraceRun(run)?.status, 'interrupted');
        assert.equal(activeMainProcesses.has(scope), false);
    } finally { off(); killActiveAgent(scope, 'user'); }
});

for (const scenario of ['setup', 'duplicate', 'ready', 'settle', 'journal', 'listener', 'stale', 'cancelled'] as const)
test(`native ${scenario} failure closes its trace once and retains real SSE diagnostics without inventing a final`, { timeout: 10_000 }, async t => {
    peerMode = scenario;
    const owner = createChatSession('setup failure owner');
    const scope = `local:${owner.id}`;
    const terminalStatus = scenario === 'cancelled' ? 'stopped' : 'error';
    const traceStatus = scenario === 'cancelled' ? 'interrupted' : 'error';
    let successor: ReturnType<typeof activeMainProcesses.get>;
    let successorTrace: string | undefined;
    let faultCalls = 0;
    if (scenario === 'ready' || scenario === 'settle') {
        t.mock.method(scenario === 'ready' ? insertMessage : insertMessageWithTraceRun, 'run', () => {
            faultCalls++; throw new Error('fixture repository failure');
        });
    }
    if (scenario === 'stale') onSetupFailure = () => {
        successorTrace = startTraceRun({ cli: 'cursor', sessionId: owner.id, scopeKey: scope });
        successor = { process: null, starting: true, steering: false, ownerGeneration: 0,
            meta: { origin: 'web', scopeId: scope, chatSessionId: owner.id } };
        activeMainProcesses.set(scope, successor);
    };
    if (scenario === 'cancelled') onSetupFailure = () => { assert.equal(killActiveAgent(scope, 'user'), true); };
    const failListener = (type: string) => {
        if (scenario === 'listener' && type === 'agent_done') { faultCalls++; throw new Error('fixture listener failure'); }
    };
    addBroadcastListener(failListener);
    if (scenario === 'journal') db.exec("CREATE TEMP TRIGGER setup_journal_fault BEFORE INSERT ON trace_events WHEN new.source='runtime' BEGIN SELECT RAISE(ABORT,'fixture journal failure'); END");
    const app = express(); registerEventsRoutes(app, (_req, _res, next) => next());
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const packets: Array<Record<string, unknown>> = [];
    const connected = Promise.withResolvers<void>();
    const request = get(`http://127.0.0.1:${address.port}/api/events?scope=${encodeURIComponent(scope)}`, response => {
        response.setEncoding('utf8'); let pending = '';
        response.on('data', (chunk: string) => {
            pending += chunk;
            for (let at; (at = pending.indexOf('\n\n')) >= 0;) {
                const frame = pending.slice(0, at); pending = pending.slice(at + 2);
                if (frame.includes(': connected')) connected.resolve();
                const data = frame.split('\n').find(line => line.startsWith('data: '));
                if (data) packets.push(JSON.parse(data.slice(6)));
            }
        });
    });
    request.on('error', connected.reject);
    db.exec('CREATE TEMP TABLE setup_closures (run_id TEXT, status TEXT)');
    db.exec("CREATE TEMP TRIGGER setup_close_count AFTER UPDATE OF status ON trace_runs BEGIN INSERT INTO setup_closures VALUES(new.id,new.status); END");
    try {
        await connected.promise;
        const result = await spawnAgent('fixture setup failure', { cli: 'cursor', model: 'default', effort: '', origin: 'web',
            scopeKey: scope, chatSessionId: owner.id, requestId: `setup-${owner.id}`, sysPrompt: '',
            _skipHistory: true, _isSmokeContinuation: true }).promise;
        const deadline = Date.now() + 1000;
        const delivered = () => {
            const done = packets.find(p => p.event === 'agent_done' && p.sessionId === owner.id);
            return done && packets.some(p => p.runId === done.traceRunId && (scenario === 'journal'
                ? p.event === 'agent_runtime_gap' : p.event === 'agent_runtime' && p.kind === 'turn-end'));
        };
        while (!delivered() && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.ok(delivered(), 'receive the matching canonical terminal or journal gap as well as compatibility');
        assert.deepEqual(setupErrors, scenario === 'ready' || scenario === 'settle' ? [] : ['acp_rpc_error:-32603']);
        assert.deepEqual(fs.readFileSync(wirePath, 'utf8').trim().split('\n').map(line => JSON.parse(line).method),
            ['initialize', 'authenticate', 'session/new', ...(scenario === 'settle' ? ['session/prompt'] : [])]);
        assert.equal(result.code, scenario === 'cancelled' ? 130 : 1); assert.equal(result.text, ''); assert.equal(result.runtimeOutcome?.finalText, null);
        const ends = packets.filter(p => p.event === 'agent_runtime' && p.kind === 'turn-end');
        const compat = packets.filter(p => p.event === 'agent_done');
        assert.equal(compat.length, 1);
        const runId = String(compat[0]!.traceRunId);
        const row = getTraceRun(runId)!;
        // This pre-journal prefix has no durable chat/scope columns. The exact
        // captured identity is asserted on real SSE envelopes below instead.
        assert.equal(compat.length, 1); assert.equal(compat[0]!.runtimeFinality, 'absent');
        assert.equal(compat[0]!.runtimeStatus, terminalStatus);
        if (scenario === 'cancelled') assert.equal(compat[0]!.text, '');
        else assert.match(String(compat[0]!.text), /Cursor native runtime failed/);
        assert.doesNotMatch(JSON.stringify(packets), /PRIVATE_SETUP_ERROR_SENTINEL/);
        assert.deepEqual(db.prepare("SELECT content FROM messages WHERE role='assistant' AND session_id=?").all(owner.id), []);
        if (scenario === 'ready' || scenario === 'settle' || scenario === 'listener') assert.equal(faultCalls, 1);
        if (scenario === 'stale') {
            assert.equal(activeMainProcesses.get(scope), successor);
            assert.equal(getTraceRun(successorTrace!)?.status, 'running');
            assert.equal(getTraceRun(successorTrace!)?.finished_at, null);
        } else assert.equal(activeMainProcesses.has(scope), false);
        const recorded = db.prepare("SELECT event_type FROM trace_events WHERE run_id=? AND source='runtime' ORDER BY seq").all(runId) as Array<{event_type: string}>;
        if (scenario === 'journal') {
            assert.equal(ends.length, 0); assert.equal(recorded.length, 0);
            assert.equal(packets.filter(p => p.event === 'agent_runtime_gap').length, 1);
        } else {
            assert.equal(ends.length, 1); assert.equal(ends[0]!.status, terminalStatus); assert.equal(ends[0]!.finalText, null);
            assert.equal(ends[0]!.runId, runId); assert.equal(ends[0]!.sessionId, owner.id); assert.equal(ends[0]!.scope, scope);
            assert.equal(recorded.at(-1)?.event_type, 'turn-end');
            const startIndex = packets.findIndex(p => p.event === 'agent_runtime' && p.kind === 'turn-start');
            const compatIndex = packets.findIndex(p => p.event === 'agent_done' && p.traceRunId === runId);
            const endIndex = packets.findIndex(p => p.event === 'agent_runtime' && p.kind === 'turn-end');
            assert.equal(packets.filter(p => p.event === 'agent_runtime' && p.kind === 'turn-start').length, 1);
            assert.ok(startIndex >= 0 && startIndex < compatIndex && compatIndex < endIndex,
                'admit the captured run before compatibility retirement, then close canonically');
        }
        assert.equal(row.status, traceStatus, 'setup failure must settle the durable trace header');
        if (scenario === 'cancelled') assert.equal(row.error, null);
        else assert.match(row.error || '', /Cursor native runtime failed/);
        assert.ok(row.finished_at);
        assert.deepEqual(db.prepare('SELECT status FROM setup_closures WHERE run_id=?').all(runId), [{ status: traceStatus }]);
    } finally {
        removeBroadcastListener(failListener);
        if (scenario === 'journal') db.exec('DROP TRIGGER setup_journal_fault');
        if (successor && activeMainProcesses.get(scope) === successor) activeMainProcesses.delete(scope);
        if (successorTrace) finalizeTraceRun(successorTrace, 'interrupted');
        killActiveAgent(scope, 'user'); request.destroy(); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.exec('DROP TRIGGER setup_close_count; DROP TABLE setup_closures');
    }
});

for (const scenario of ['before-finalize', 'after-finalize', 'late-release'] as const)
test(`native ${scenario} exception cannot rewrite an already selected final or duplicate header settlement`, async t => {
    peerMode = 'complete'; failRelease = scenario === 'late-release';
    const owner = createChatSession('finalizer fault owner'); const scope = `local:${owner.id}`;
    let faults = 0;
    if (!failRelease) {
        const original = AcpRuntimeSession.prototype.finalizeTurn;
        t.mock.method(AcpRuntimeSession.prototype, 'finalizeTurn', function (turnId, end) {
            faults++;
            if (scenario === 'after-finalize') original.call(this, turnId, end);
            throw new Error('fixture finalizer failed');
        });
    }
    const packets: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = subscribe(event => packets.push(event));
    db.exec('CREATE TEMP TABLE setup_closures (run_id TEXT, status TEXT)');
    db.exec("CREATE TEMP TRIGGER setup_close_count AFTER UPDATE OF status ON trace_runs BEGIN INSERT INTO setup_closures VALUES(new.id,new.status); END");
    try {
        const result = await spawnAgent('complete fixture', { cli: 'cursor', model: 'default', effort: '', origin: 'web',
            scopeKey: scope, chatSessionId: owner.id, sysPrompt: '', _skipHistory: true, _isSmokeContinuation: true }).promise;
        assert.equal(result.code, 0); assert.equal(result.runtimeOutcome?.finalText, 'MODEL_FINAL');
        assert.equal(scenario === 'late-release' ? releaseFaults : faults, 1);
        const compat = packets.filter(p => p.event === 'agent_done'); assert.equal(compat.length, 1);
        assert.equal(compat[0]!.data.text, 'MODEL_FINAL'); assert.equal(compat[0]!.data.runtimeStatus, 'done');
        const runId = String(compat[0]!.data.traceRunId);
        assert.equal(getTraceRun(runId)?.status, 'done'); assert.equal(getTraceRun(runId)?.error, null);
        assert.deepEqual(db.prepare('SELECT status FROM setup_closures WHERE run_id=?').all(runId), [{ status: 'done' }]);
        assert.deepEqual(db.prepare("SELECT content FROM messages WHERE role='assistant' AND session_id=?").all(owner.id), [{ content: 'MODEL_FINAL' }]);
        const recorded = db.prepare("SELECT event_type FROM trace_events WHERE run_id=? AND source='runtime' ORDER BY seq").all(runId) as Array<{event_type: string}>;
        assert.equal(recorded.filter(event => event.event_type === 'turn-end').length, scenario === 'before-finalize' ? 0 : 1);
        assert.equal(activeMainProcesses.has(scope), false);
    } finally {
        off(); killActiveAgent(scope, 'user'); db.exec('DROP TRIGGER setup_close_count; DROP TABLE setup_closures');
    }
});
