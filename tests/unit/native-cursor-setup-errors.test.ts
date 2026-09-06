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
fs.writeFileSync(script, `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
for await (const line of readline.createInterface({input:process.stdin})) {
 const r=JSON.parse(line); appendFileSync(process.argv[2], JSON.stringify({method:r.method})+'\\n');
 const reply=result=>send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='initialize') reply({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'cursor_login'}]});
 if(r.method==='authenticate') reply({});
 if(r.method==='session/new') send({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'PRIVATE_SETUP_ERROR_SENTINEL'}});
}
`);
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: () => ({ available: true, path: process.execPath }) } });
const factory = await import('../../src/agent/runtime/acp/cursor-session.ts');
const children: ChildProcess[] = [];
test.mock.module('../../src/agent/runtime/acp/cursor-session.js', { namedExports: { ...factory,
    createCursorSession: (input: Parameters<typeof factory.createCursorSession>[0]) => factory.createCursorSession({
        ...input, requestTimeoutMs: 1000,
        spawnImpl: ((_command, _args, options) => {
            const child = spawn(process.execPath, [script, wirePath], options);
            children.push(child); return child;
        }) as typeof spawn,
    }),
} });
const { spawnAgent, activeMainProcesses, killActiveAgent } = await import('../../src/agent/spawn.ts');
const { db } = await import('../../src/core/db.ts');
const { createChatSession } = await import('../../src/core/chat-sessions.ts');
const { getTraceRun } = await import('../../src/trace/store.ts');
const { readActivityPage } = await import('../../src/trace/activity-journal.ts');
const { clearGoalTimers } = await import('../../src/agent/lifecycle-handler.ts');
const { poolStats } = await import('../../src/agent/runtime-pool.ts');
const { registerEventsRoutes } = await import('../../src/routes/events.ts');

test.beforeEach(t => {
    fs.writeFileSync(wirePath, '');
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

test('session/new RPC error closes the owned trace once and retains a diagnostic on real SSE without inventing a final', { timeout: 10_000 }, async () => {
    const owner = createChatSession('setup failure owner');
    const scope = `local:${owner.id}`;
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
        while (!packets.some(p => p.event === 'agent_runtime' && p.kind === 'turn-end') && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.deepEqual(fs.readFileSync(wirePath, 'utf8').trim().split('\n').map(line => JSON.parse(line).method),
            ['initialize', 'authenticate', 'session/new']);
        assert.equal(result.code, 1); assert.equal(result.text, ''); assert.equal(result.runtimeOutcome?.finalText, null);
        const ends = packets.filter(p => p.event === 'agent_runtime' && p.kind === 'turn-end');
        assert.equal(ends.length, 1); assert.equal(ends[0]!.status, 'error'); assert.equal(ends[0]!.finalText, null);
        const runId = String(ends[0]!.runId);
        const row = getTraceRun(runId)!;
        assert.equal(row.session_id, owner.id); assert.equal(row.scope_key, scope);
        const compat = packets.filter(p => p.event === 'agent_done' && p.traceRunId === runId);
        assert.equal(compat.length, 1); assert.equal(compat[0]!.runtimeFinality, 'absent');
        assert.equal(compat[0]!.runtimeStatus, 'error'); assert.match(String(compat[0]!.text), /Cursor native runtime failed/);
        assert.doesNotMatch(JSON.stringify(packets), /PRIVATE_SETUP_ERROR_SENTINEL/);
        assert.deepEqual(db.prepare("SELECT content FROM messages WHERE role='assistant' AND session_id=?").all(owner.id), []);
        assert.equal(activeMainProcesses.has(scope), false);
        const page = readActivityPage({ runId, sessionId: owner.id, after: 0, limit: 40 })!;
        assert.equal(page.events.at(-1)?.kind, 'turn-end');
        assert.equal(row.status, 'error', 'setup failure must settle the durable trace header');
        assert.match(row.error || '', /Cursor native runtime failed/);
        assert.ok(row.finished_at);
        assert.deepEqual(db.prepare('SELECT status FROM setup_closures WHERE run_id=?').all(runId), [{ status: 'error' }]);
        assert.equal(page.status, 'error'); assert.equal(page.incomplete, false);
    } finally {
        killActiveAgent(scope, 'user'); request.destroy(); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.exec('DROP TRIGGER setup_close_count; DROP TABLE setup_closures');
    }
});
