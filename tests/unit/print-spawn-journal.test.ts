import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import childProcess from 'node:child_process';

const home = process.env['CLI_JAW_HOME']!;
const script = join(home, 'print-provider.mjs');
writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>{
 const frames=[
  {type:'thread.started',thread_id:'provider-private-id'},
  {type:'item.completed',item:{type:'agent_message',text:'kept commentary',channel:'commentary'}},
  {type:'item.completed',item:{id:'tool-1',type:'command_execution',command:'echo fixture',status:'completed',exit_code:0,aggregated_output:'fixture'}},
  {type:'item.completed',item:{type:'agent_message',text:'print fixture final'}}
 ];process.stderr.write('stderr-not-an-assistant-message\\n');
 for(const frame of frames)process.stdout.write(JSON.stringify(frame)+'\\n');
});`);
let launches = 0;
let launchError = false;
test.mock.module('node:child_process', { namedExports: { ...childProcess,
    spawn: (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
        assert.equal(command, process.execPath, 'no provider process may launch');
        assert.deepEqual(args, [script]); launches++;
        if (launchError) return childProcess.spawn(join(home, 'missing-fixture-runtime'), [], options);
        return childProcess.spawn(command, [...args], options);
    },
} });
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: () => ({ available: true, path: process.execPath }),
} });
const argsModule = await import('../../src/agent/args.ts');
test.mock.module('../../src/agent/args.js', { namedExports: { ...argsModule,
    buildArgs: () => [script], buildResumeArgs: () => [script],
} });
const { spawnAgent, activeMainProcesses, activeProcesses } = await import('../../src/agent/spawn.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { readActivityPage } = await import('../../src/trace/activity-journal.ts');
const { db } = await import('../../src/core/db.ts');
const { createChatSession, setActiveChatSession } = await import('../../src/core/chat-sessions.ts');

test('real print child traverses spawn, accepted parser, lifecycle and durable journal with captured identity', { timeout: 15_000 }, async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    config.settings.workingDir = home;
    config.settings.cli = 'codex'; config.settings.memory.enabled = false;
    config.settings.multiSession.enabled = false; config.settings.activeOverrides = {}; config.settings.fallbackOrder = [];
    config.settings.perCli.codex = { model: 'fixture', effort: '' };
    mkdirSync(join(home, 'prompts'), { recursive: true });
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribe(event => seen.push(event));
    const owner = createChatSession('captured-print-owner');
    const scope = 'captured-print-scope';
    setActiveChatSession('default');
    try {
        const run = spawnAgent('fixture input', { cli: 'codex', model: 'fixture', sysPrompt: 'fixture system',
            scopeKey: scope, chatSessionId: owner.id, origin: 'web',
            _skipInsert: true, _skipHistory: true, _skipResume: true, _skipSessionPersist: true, _isSmokeContinuation: true });
        const result = await run.promise;
        assert.equal(result.code, 0); assert.equal(launches, 1);
        const start = seen.find(e => e.event === 'agent_runtime' && e.data['kind'] === 'turn-start')!;
        assert.ok(start);
        const runId = String(start.data['runId']);
        const replay = readActivityPage({ runId, sessionId: owner.id, after: 0, limit: 40 })!;
        assert.equal(replay.incomplete, false);
        const end = replay.events.at(-1); assert.ok(end?.kind === 'turn-end'); assert.equal(end.finalText, 'print fixture final');
        assert.ok(replay.events.some(e => e.kind === 'message' && e.phase === 'commentary' && e.text === 'kept commentary'));
        assert.ok(!JSON.stringify(replay).includes('provider-private-id'));
        assert.ok(!JSON.stringify(replay).includes('stderr-not-an-assistant-message'));
        for (const packet of seen.filter(e => e.event === 'agent_output' || e.event === 'agent_tool')) {
            assert.equal(packet.data['traceRunId'], runId);
            assert.equal(packet.data['sessionId'], owner.id); assert.equal(packet.data['scope'], scope);
        }
        assert.ok(seen.some(e => e.event === 'agent_output'));
        assert.ok(seen.some(e => e.event === 'agent_tool'));
        assert.equal(seen.filter(e => e.event === 'agent_done').length, 1);
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='assistant' AND trace_run_id=?").get(runId) as { n: number }).n, 1);
        assert.equal(activeMainProcesses.size, 0); assert.equal(activeProcesses.size, 0);
    } finally { unsubscribe(); }
});

test('EG-007a: real print error reentry and close settle only once and close the journal', { timeout: 15_000 }, async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    launchError = true;
    const before = launches;
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribe(event => seen.push(event));
    try {
        let child: childProcess.ChildProcess | null = null;
        let exits = 0;
        const run = spawnAgent('fixture error', { cli: 'codex', model: 'fixture', sysPrompt: 'fixture system', origin: 'web',
            _skipInsert: true, _skipHistory: true, _skipResume: true, _skipSessionPersist: true, _isSmokeContinuation: true,
            lifecycle: { onExit: () => { exits++; assert.ok(child); child.emit('error', new Error('reentrant fixture')); } },
        });
        child = run.child;
        const result = await run.promise;
        assert.equal(result.code, 127); assert.equal(launches, before + 1);
        assert.equal(exits, 1, 'settled guard precedes any reentrant lifecycle callback');
        const start = seen.find(e => e.event === 'agent_runtime' && e.data['kind'] === 'turn-start')!;
        assert.ok(start);
        const p = readActivityPage({ runId: String(start.data['runId']), sessionId: 'default', after: 0, limit: 40 })!;
        assert.equal(p.status, 'error');
        assert.equal(p.events.at(-1)?.kind, 'turn-end');
        assert.equal(seen.filter(e => e.event === 'agent_done').length, 1);
        assert.equal(activeMainProcesses.size, 0);
    } finally { launchError = false; unsubscribe(); }
});
