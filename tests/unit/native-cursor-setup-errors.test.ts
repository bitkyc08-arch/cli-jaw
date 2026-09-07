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
 if(r.method==='initialize') reply({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'cursor_login'},{id:'cached_token'}]});
 if(r.method==='authenticate') reply({});
 if(r.method==='session/new') {
  if(mode==='ready'||mode==='settle'||mode==='complete') reply({sessionId:'private-peer-session',configOptions:[],
   models:{currentModelId:'grok-4.6',availableModels:[{modelId:'grok-4.6',name:'Grok fixture'}]}});
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
// Install before either factory/pool can import the production runtime recorder.
const journal = await import('../../src/trace/activity-journal.ts');
let journalFaults = 0;
let failJournal = false;
test.mock.module('../../src/trace/activity-journal.js', { namedExports: { ...journal,
    appendActivityBody: (input: Parameters<typeof journal.appendActivityBody>[0]) => {
        if (failJournal) { journalFaults++; throw new Error('fixture Activity journal failure'); }
        return journal.appendActivityBody(input);
    },
} });
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
const grokFactory = await import('../../src/agent/runtime/acp/grok-session.ts');
test.mock.module('../../src/agent/runtime/acp/grok-session.js', { namedExports: { ...grokFactory,
    createGrokSession: async (input: Parameters<typeof grokFactory.createGrokSession>[0]) => {
        try { return await grokFactory.createGrokSession({
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
let acquisitions = 0;
let releases = 0;
test.mock.module('../../src/agent/runtime-pool.js', { namedExports: { ...pool,
    acquireCursorRuntime: async (input: Parameters<typeof pool.acquireCursorRuntime>[0]) => {
        acquisitions++;
        const lease = await pool.acquireCursorRuntime(input);
        return { ...lease, release: () => {
            releases++; lease.release();
            if (failRelease) { releaseFaults++; throw new Error('fixture late release failed'); }
        } };
    },
    acquireGrokRuntime: async (input: Parameters<typeof pool.acquireGrokRuntime>[0]) => {
        acquisitions++;
        const lease = await pool.acquireGrokRuntime(input);
        return { ...lease, release: () => {
            releases++; lease.release();
            if (failRelease) { releaseFaults++; throw new Error('fixture late release failed'); }
        } };
    },
} });
const { spawnAgent, activeMainProcesses, killActiveAgent, waitForExitSettled, settleExit } = await import('../../src/agent/spawn.ts');
const { db, insertMessage, insertMessageWithTraceRun } = await import('../../src/core/db.ts');
const { createChatSession } = await import('../../src/core/chat-sessions.ts');
const { getTraceRun, startTraceRun, finalizeTraceRun } = await import('../../src/trace/store.ts');
const { readActivityPage } = await import('../../src/trace/activity-journal.ts');
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
    failRelease = false; releaseFaults = 0; failJournal = false; journalFaults = 0;
    acquisitions = 0; releases = 0;
    config.settings.cli = 'cursor'; config.settings.workingDir = home; config.settings.projectDirs = [home];
    config.settings.permissions = 'auto'; config.settings.fallbackOrder = []; config.settings.activeOverrides = {};
    config.settings.perCli = { ...config.settings.perCli,
        cursor: { model: 'default', effort: '', transport: 'native' },
        grok: { model: 'default', effort: '', transport: 'native' } };
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

for (const cli of ['cursor', 'grok'] as const)
for (const scenario of ['setup', 'duplicate', 'ready', 'settle', 'journal', 'listener', 'stale', 'cancelled'] as const)
test(`native ${cli} ${scenario} failure closes its trace once and retains real SSE diagnostics without inventing a final`, { timeout: 10_000 }, async t => {
    peerMode = scenario; config.settings.cli = cli;
    const diagnostic = cli === 'grok' ? /Grok native runtime failed/ : /Cursor native runtime failed/;
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
        successorTrace = startTraceRun({ cli, sessionId: owner.id, scopeKey: scope });
        successor = { process: null, starting: true, steering: false, ownerGeneration: 0,
            meta: { origin: 'web', scopeId: scope, chatSessionId: owner.id } };
        activeMainProcesses.set(scope, successor);
    };
    if (scenario === 'cancelled') onSetupFailure = () => { assert.equal(killActiveAgent(scope, 'user'), true); };
    const failListener = (type: string) => {
        if (scenario === 'listener' && type === 'agent_done') { faultCalls++; throw new Error('fixture listener failure'); }
    };
    addBroadcastListener(failListener);
    failJournal = scenario === 'journal';
    const app = express(); registerEventsRoutes(app, (_req, _res, next) => next());
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const packets: Array<Record<string, unknown>> = [];
    const connected = Promise.withResolvers<void>();
    const terminalDelivery = Promise.withResolvers<void>();
    const delivered = () => {
        const done = packets.find(p => p.event === 'agent_done' && p.sessionId === owner.id);
        return done && packets.some(p => p.runId === done.traceRunId && (scenario === 'journal'
            ? p.event === 'agent_runtime_gap' : p.event === 'agent_runtime' && p.kind === 'turn-end'));
    };
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
            if (delivered()) terminalDelivery.resolve();
        });
    });
    request.on('error', connected.reject);
    db.exec('CREATE TEMP TABLE setup_closures (run_id TEXT, status TEXT)');
    db.exec("CREATE TEMP TRIGGER setup_close_count AFTER UPDATE OF status ON trace_runs BEGIN INSERT INTO setup_closures VALUES(new.id,new.status); END");
    try {
        await connected.promise;
        const result = await spawnAgent('fixture setup failure', { cli, model: 'default', effort: '', origin: 'web',
            scopeKey: scope, chatSessionId: owner.id, requestId: `setup-${owner.id}`, sysPrompt: '',
            _skipHistory: true, _isSmokeContinuation: true }).promise;
        if (scenario === 'journal') assert.equal(journalFaults, 1, 'the current appendActivityBody fault seam was reached once');
        let deliveryTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([terminalDelivery.promise, new Promise<never>((_, reject) => {
                deliveryTimeout = setTimeout(() => reject(new Error('matching SSE terminal/gap not delivered')), 1000);
            })]);
        } finally { if (deliveryTimeout) clearTimeout(deliveryTimeout); }
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
        assert.equal(row.session_id, owner.id); assert.equal(row.scope_key, scope);
        assert.equal(compat.length, 1); assert.equal(compat[0]!.runtimeFinality, 'absent');
        assert.equal(compat[0]!.runtimeStatus, terminalStatus);
        if (scenario === 'cancelled') assert.equal(compat[0]!.text, '');
        else assert.match(String(compat[0]!.text), diagnostic);
        assert.equal(compat[0]!.cli, cli);
        assert.equal(acquisitions, 1);
        assert.equal(releases, scenario === 'ready' || scenario === 'settle' ? 1 : 0);
        assert.doesNotMatch(JSON.stringify(packets), /PRIVATE_SETUP_ERROR_SENTINEL/);
        assert.deepEqual(db.prepare("SELECT content FROM messages WHERE role='assistant' AND session_id=?").all(owner.id), []);
        if (scenario === 'ready' || scenario === 'settle' || scenario === 'listener') assert.equal(faultCalls, 1);
        if (scenario === 'stale') {
            assert.equal(activeMainProcesses.get(scope), successor);
            assert.equal(getTraceRun(successorTrace!)?.status, 'running');
            assert.equal(getTraceRun(successorTrace!)?.finished_at, null);
        } else assert.equal(activeMainProcesses.has(scope), false);
        const page = readActivityPage({ runId, sessionId: owner.id, after: 0, limit: 40 })!;
        if (scenario === 'journal') {
            assert.ok(journalFaults > 0, 'the current appendActivityBody fault seam was reached');
            assert.equal(ends.length, 0); assert.equal(page.incomplete, true);
            assert.equal(packets.filter(p => p.event === 'agent_runtime_gap').length, 1);
        } else {
            assert.equal(ends.length, 1); assert.equal(ends[0]!.status, terminalStatus); assert.equal(ends[0]!.finalText, null);
            assert.equal(ends[0]!.runId, runId); assert.equal(ends[0]!.sessionId, owner.id); assert.equal(ends[0]!.scope, scope);
            assert.equal(page.events.at(-1)?.kind, 'turn-end');
            const startIndex = packets.findIndex(p => p.event === 'agent_runtime' && p.kind === 'turn-start');
            const compatIndex = packets.findIndex(p => p.event === 'agent_done' && p.traceRunId === runId);
            const endIndex = packets.findIndex(p => p.event === 'agent_runtime' && p.kind === 'turn-end');
            assert.equal(packets.filter(p => p.event === 'agent_runtime' && p.kind === 'turn-start').length, 1);
            assert.ok(startIndex >= 0 && startIndex < compatIndex && compatIndex < endIndex,
                'admit the captured run before compatibility retirement, then close canonically');
        }
        assert.equal(row.status, traceStatus, 'setup failure must settle the durable trace header');
        if (scenario === 'cancelled') assert.equal(row.error, null);
        else assert.match(row.error || '', diagnostic);
        assert.ok(row.finished_at);
        assert.deepEqual(db.prepare('SELECT status FROM setup_closures WHERE run_id=?').all(runId), [{ status: traceStatus }]);
        assert.equal(page.status, traceStatus); assert.equal(page.incomplete, scenario === 'journal');
    } finally {
        removeBroadcastListener(failListener);
        failJournal = false;
        if (successor && activeMainProcesses.get(scope) === successor) activeMainProcesses.delete(scope);
        if (successorTrace) finalizeTraceRun(successorTrace, 'interrupted');
        killActiveAgent(scope, 'user'); request.destroy(); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.exec('DROP TRIGGER setup_close_count; DROP TABLE setup_closures');
    }
});

for (const cli of ['cursor', 'grok'] as const)
for (const scenario of ['before-finalize', 'after-finalize', 'late-release'] as const)
test(`native ${cli} ${scenario} exception cannot rewrite an already selected final or duplicate header settlement`, { timeout: 10_000 }, async t => {
    peerMode = 'complete'; failRelease = scenario === 'late-release'; config.settings.cli = cli;
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
        const result = await spawnAgent('complete fixture', { cli, model: 'default', effort: '', origin: 'web',
            scopeKey: scope, chatSessionId: owner.id, sysPrompt: '', _skipHistory: true, _isSmokeContinuation: true }).promise;
        assert.equal(result.code, 0); assert.equal(result.runtimeOutcome?.finalText, 'MODEL_FINAL');
        assert.equal(scenario === 'late-release' ? releaseFaults : faults, 1);
        assert.equal(acquisitions, 1); assert.equal(releases, 1);
        const compat = packets.filter(p => p.event === 'agent_done'); assert.equal(compat.length, 1);
        assert.equal(compat[0]!.data.text, 'MODEL_FINAL'); assert.equal(compat[0]!.data.runtimeStatus, 'done');
        const runId = String(compat[0]!.data.traceRunId);
        assert.equal(getTraceRun(runId)?.status, 'done'); assert.equal(getTraceRun(runId)?.error, null);
        assert.deepEqual(db.prepare('SELECT status FROM setup_closures WHERE run_id=?').all(runId), [{ status: 'done' }]);
        assert.deepEqual(db.prepare("SELECT content FROM messages WHERE role='assistant' AND session_id=?").all(owner.id), [{ content: 'MODEL_FINAL' }]);
        const page = readActivityPage({ runId, sessionId: owner.id, after: 0, limit: 40 })!;
        assert.equal(page.incomplete, scenario === 'before-finalize');
        assert.equal(page.events.filter(event => event.kind === 'turn-end').length, scenario === 'before-finalize' ? 0 : 1);
        assert.equal(activeMainProcesses.has(scope), false);
    } finally {
        off(); killActiveAgent(scope, 'user'); db.exec('DROP TRIGGER setup_close_count; DROP TABLE setup_closures');
    }
});

for (const cli of ['cursor', 'grok'] as const)
for (const reason of ['user', 'interrupt', 'steer'] as const)
test(`native ${cli} immediate ${reason} Stop admits and closes before any acquire, settling its exit barrier`, { timeout: 10_000 }, async () => {
    config.settings.cli = cli;
    const owner = createChatSession('immediate Stop owner'); const scope = `local:${owner.id}`;
    const packets: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = subscribe(event => packets.push(event));
    let exitBarrier: Promise<void> | undefined;
    let barrierSettled = false;
    let headerAtBarrier: string | undefined;
    db.exec('CREATE TEMP TABLE setup_closures (run_id TEXT, status TEXT)');
    db.exec("CREATE TEMP TRIGGER setup_close_count AFTER UPDATE OF status ON trace_runs BEGIN INSERT INTO setup_closures VALUES(new.id,new.status); END");
    try {
        const run = spawnAgent('must never reach provider', { cli, model: 'default', effort: '', origin: 'web',
            scopeKey: scope, chatSessionId: owner.id, sysPrompt: '', _skipHistory: true, _isSmokeContinuation: true });
        assert.equal(acquisitions, 0, 'native runner has not entered its acquire microtask');
        assert.equal(killActiveAgent(scope, reason), true);
        // interrupt/steer arm a real barrier synchronously in the host's cancel hook.
        // Its timeout is deliberately longer than this test: timeout cannot prove settlement.
        exitBarrier = waitForExitSettled(scope, 30_000).then(() => {
            barrierSettled = true;
            const terminal = packets.find(packet => packet.event === 'agent_done'
                && packet.data.sessionId === owner.id);
            headerAtBarrier = getTraceRun(String(terminal?.data.traceRunId))?.status;
        });
        const result = await run.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(barrierSettled, true, 'the captured exit barrier resolves without its timeout');
        if (reason !== 'user') {
            assert.equal(headerAtBarrier, 'interrupted', 'the trace is closed when the real exit waiter resolves');
        }
        assert.equal(acquisitions, 0); assert.equal(releases, 0); assert.equal(children.length, 0);
        assert.equal(fs.readFileSync(wirePath, 'utf8'), '', 'no initialize, acquire or prompt traffic');
        assert.equal(result.code, 130); assert.equal(result.text, '');
        assert.equal(result.runtimeOutcome?.status, 'stopped'); assert.equal(result.runtimeOutcome?.finalText, null);
        const compat = packets.filter(p => p.event === 'agent_done');
        assert.equal(compat.length, 1);
        const runId = String(compat[0]!.data.traceRunId);
        assert.equal(compat[0]!.data.runtimeStatus, 'stopped'); assert.equal(compat[0]!.data.runtimeFinality, 'absent');
        assert.equal(compat[0]!.data.text, '');
        const starts = packets.filter(p => p.event === 'agent_runtime' && p.data.kind === 'turn-start');
        const ends = packets.filter(p => p.event === 'agent_runtime' && p.data.kind === 'turn-end');
        assert.equal(starts.length, 1); assert.equal(ends.length, 1);
        assert.ok(packets.indexOf(starts[0]!) < packets.indexOf(compat[0]!)
            && packets.indexOf(compat[0]!) < packets.indexOf(ends[0]!),
        'admit the captured run before compatibility retirement, then close canonically');
        for (const packet of [...starts, ...ends]) {
            assert.equal(packet.data.runId, runId); assert.equal(packet.data.sessionId, owner.id);
            assert.equal(packet.data.scope, scope);
        }
        assert.equal(ends[0]!.data.status, 'stopped'); assert.equal(ends[0]!.data.finalText, null);
        const row = getTraceRun(runId)!;
        assert.equal(row.session_id, owner.id); assert.equal(row.scope_key, scope);
        assert.equal(row.status, 'interrupted'); assert.equal(row.error, null); assert.ok(row.finished_at);
        assert.deepEqual(db.prepare('SELECT status FROM setup_closures WHERE run_id=?').all(runId), [{ status: 'interrupted' }]);
        assert.deepEqual(db.prepare("SELECT content FROM messages WHERE role='assistant' AND session_id=?").all(owner.id), []);
        const page = readActivityPage({ runId, sessionId: owner.id, after: 0, limit: 40 })!;
        assert.equal(page.status, 'interrupted'); assert.equal(page.incomplete, false);
        assert.deepEqual(page.events.map(event => event.kind), ['turn-start', 'turn-end']);
        assert.equal(activeMainProcesses.has(scope), false);
    } finally {
        off(); killActiveAgent(scope, 'user'); settleExit(scope); await exitBarrier;
        db.exec('DROP TRIGGER setup_close_count; DROP TABLE setup_closures');
    }
});
