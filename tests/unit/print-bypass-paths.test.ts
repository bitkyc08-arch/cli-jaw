import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';

const home = process.env['CLI_JAW_HOME']!;
process.env['TMPDIR'] = join(home, 'tmp');
mkdirSync(process.env['TMPDIR'], { recursive: true });
mkdirSync(join(home, 'prompts'), { recursive: true });
mkdirSync(join(home, '.copilot'), { recursive: true });
writeFileSync(join(home, '.copilot/config.json'), '{"model":"fixture"}');
const isolatedOs = { ...os, homedir: () => home };
test.mock.module('node:os', { namedExports: isolatedOs, defaultExport: isolatedOs });
assert.equal((await import('os')).default.homedir(), home, 'Copilot config writes must be isolated before importing spawn');

class ErrorAcp extends EventEmitter {
    proc = Object.assign(new EventEmitter(), { pid: undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    spawn() { queueMicrotask(() => this.emit('error', new Error('fixture ACP failure'))); }
    initialize() { return new Promise(() => {}); }
    kill() {}
}
test.mock.module('../../src/cli/acp-client.js', { namedExports: { AcpClient: ErrorAcp } });
let launches = 0;
test.mock.module('node:child_process', { namedExports: { ...childProcess,
    spawn: (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
        assert.equal(command, process.execPath, 'no provider process may launch');
        assert.deepEqual(args, []); launches++;
        const output = launches === 1 ? 'Warning: conversation "stale" not found\n' : 'Fresh answer\n';
        return childProcess.spawn(command, ['--input-type=module', '-e',
            `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(output)}));`], options);
    },
} });
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js', { namedExports: { ...config,
    detectCli: () => ({ available: true, path: process.execPath }),
} });
const argsModule = await import('../../src/agent/args.ts');
test.mock.module('../../src/agent/args.js', { namedExports: { ...argsModule, buildArgs: () => [], buildResumeArgs: () => [] } });
const capabilities = await import('../../src/agent/agy-capabilities.ts');
test.mock.module('../../src/agent/agy-capabilities.js', { namedExports: { ...capabilities,
    detectAgyCapabilities: () => ({ ...capabilities.DEFAULT_AGY_CAPABILITIES, usedFallback: false }),
} });
const resume = await import('../../src/agent/spawn/resume.ts');
test.mock.module('../../src/agent/spawn/resume.js', { namedExports: { ...resume,
    canGuardedAgyResume: (input: { freshBootstrap: boolean }) => ({ ok: !input.freshBootstrap, reason: 'fixture' }),
    shouldResumeBucketSession: () => true,
} });
const watcher = await import('../../src/agent/agy-transcript-watcher.ts');
test.mock.module('../../src/agent/agy-transcript-watcher.js', { namedExports: { ...watcher,
    startAgyTranscriptWatcher: () => ({ stop() {} }),
} });
const { spawnAgent, activeMainProcesses, activeProcesses } = await import('../../src/agent/spawn.ts');
const { subscribe } = await import('../../src/core/event-bus.ts');
const { db, upsertSessionBucket } = await import('../../src/core/db.ts');
const { readActivityPage } = await import('../../src/trace/activity-journal.ts');

test.beforeEach(t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    config.settings.workingDir = home; config.settings.memory.enabled = false;
    config.settings.multiSession.enabled = false; config.settings.activeOverrides = {}; config.settings.fallbackOrder = [];
});

test('Copilot ACP error bypass closes the admitted journal and preserves one existing error completion', { timeout: 10_000 }, async () => {
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribe(e => seen.push(e));
    try {
        const result = await spawnAgent('ACP fixture', { cli: 'copilot', model: 'fixture', effort: '', sysPrompt: 'fixture system', origin: 'web',
            _skipInsert: true, _skipHistory: true, _skipResume: true, _skipSessionPersist: true, _isSmokeContinuation: true }).promise;
        assert.equal(result.code, 1); assert.equal(launches, 0);
        const start = seen.find(e => e.event === 'agent_runtime' && e.data['kind'] === 'turn-start')!;
        const p = readActivityPage({ runId: String(start.data['runId']), sessionId: 'default', after: 0, limit: 40 })!;
        assert.equal(p.status, 'error'); assert.equal(p.events.at(-1)?.kind, 'turn-end');
        assert.equal(seen.filter(e => e.event === 'agent_done').length, 1);
        assert.equal(activeMainProcesses.size, 0); assert.equal(activeProcesses.size, 0);
        assert.deepEqual(JSON.parse(readFileSync(join(home, '.copilot/config.json'), 'utf8')), { model: 'fixture' });
    } finally { unsubscribe(); }
});

test('AGY guarded stale retry closes the old journal before the one existing fresh attempt', { timeout: 15_000 }, async () => {
    config.settings.perCli.agy = { model: 'fixture', effort: '', nativeResume: 'guarded' };
    upsertSessionBucket.run('agy', 'stale-conversation', 'fixture', null, 0);
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribe(e => seen.push(e));
    try {
        const result = await spawnAgent('AGY fixture', { cli: 'agy', model: 'fixture', effort: '', sysPrompt: 'fixture system', origin: 'web',
            _skipInsert: true, _skipHistory: true, _skipSessionPersist: true, _isSmokeContinuation: true }).promise;
        assert.equal(result.code, 0); assert.equal(launches, 2, 'only the existing stale-resume retry');
        const starts = seen.filter(e => e.event === 'agent_runtime' && e.data['kind'] === 'turn-start');
        assert.equal(starts.length, 2);
        const old = readActivityPage({ runId: String(starts[0]!.data['runId']), sessionId: 'default', after: 0, limit: 40 })!;
        const fresh = readActivityPage({ runId: String(starts[1]!.data['runId']), sessionId: 'default', after: 0, limit: 40 })!;
        assert.equal(old.status, 'interrupted'); assert.equal(old.events.at(-1)?.kind, 'turn-end');
        const end = fresh.events.at(-1); assert.ok(end?.kind === 'turn-end'); assert.equal(end.finalText, 'Fresh answer');
        assert.equal(seen.filter(e => e.event === 'agent_done').length, 1);
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'").get() as { n: number }).n, 1);
        assert.equal(activeMainProcesses.size, 0);
    } finally { unsubscribe(); }
});
