import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { win32 } from 'node:path';
import type { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { readProcessPath } from '../../src/core/cli-detect.ts';
const lookups: Array<{ name: string; seed: string }> = [];
mock.module('../../src/core/cli-detect.js', { namedExports: { readProcessPath,
    detectCliBinary: (name: string, seed: string) => { lookups.push({ name, seed }); return { available: true, path: 'C:/sdk-selected/node.exe' }; } } });
const { createClaudeProcessOwner } = await import('../../src/agent/runtime/claude-sdk-process.ts');
const { ClaudeSdkRoots } = await import('../../src/agent/runtime/claude-sdk-roots.ts');

function fixture(defaultLookup = false) {
    const calls: unknown[][] = [];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        pid: undefined, exitCode: null, signalCode: null, killed: false }) as unknown as ChildProcessWithoutNullStreams;
    const spawnImpl = ((...args: unknown[]) => { calls.push(args); return child; }) as typeof spawn;
    const owner = createClaudeProcessOwner({ platform: 'win32', spawnImpl, launchDeps: {
        exists: () => true,
        readFile: path => path.endsWith('.cmd') ? '@"%~dp0\\node.exe" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*'
            : path.endsWith('.js') ? '#!/usr/bin/env node\n' : 'not a supported executable',
        ...(!defaultLookup ? { which: (name: string) => name === 'node' ? 'C:/runtime/node.exe' : null } : {}),
    } });
    const finish = async () => { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); await owner.wait(); };
    return { owner, calls, finish };
}
test('SDK-provided npm cmd shim uses the existing native Windows resolver without a shell', async () => {
    const f = fixture(); const args = ['--settings', '{"fastMode":true}', '& echo %PATH%'];
    f.owner.spawn({ command: 'C:/tools/claude.cmd', args, env: { Path: 'original' }, signal: new AbortController().signal });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]![0], 'C:/runtime/node.exe');
    const argv = f.calls[0]![1] as string[], options = f.calls[0]![2] as { shell: boolean; env: object };
    assert.equal(win32.normalize(argv[0]!), win32.normalize('C:/tools/node_modules/@anthropic-ai/claude-code/cli.js'));
    assert.deepEqual(argv.slice(1), args); assert.equal(options.shell, false); assert.deepEqual(options.env, { PATH: 'original' });
    await f.finish(); assert.equal(f.owner.activeCount, 0);
});
test('native exe keeps SDK argv unchanged', async () => {
    const f = fixture(), args = ['--output-format', 'stream-json'];
    f.owner.spawn({ command: 'C:/tools/claude.exe', args, env: {}, signal: new AbortController().signal });
    assert.equal(f.calls[0]![0], 'C:/tools/claude.exe'); assert.deepEqual(f.calls[0]![1], args);
    await f.finish();
});
test('unsupported Windows wrapper fails before any child is created', async () => {
    const f = fixture();
    assert.throws(() => f.owner.spawn({ command: 'C:/tools/claude.ps1', args: [], env: {}, signal: new AbortController().signal }), /windows_launch_unsupported/);
    assert.equal(f.calls.length, 0); assert.equal(f.owner.activeCount, 0); await f.owner.wait();
});
test('interpreter discovery and spawn share the normalized SDK PATH, not the parent PATH', async () => {
    const f = fixture(true); lookups.length = 0;
    f.owner.spawn({ command: 'node', args: ['sdk.js'], env: { Path: 'C:/sdk-selected' }, signal: new AbortController().signal });
    assert.deepEqual(lookups, [{ name: 'node', seed: 'C:/sdk-selected' }]);
    assert.equal(f.calls[0]![0], 'C:/sdk-selected/node.exe');
    assert.deepEqual((f.calls[0]![2] as { env: object }).env, { PATH: 'C:/sdk-selected' });
    await f.finish();
});
test('root readiness never creates a child and is bounded by timeout, abort and close', async () => {
    const f = fixture(); assert.equal(f.owner.primaryChild, null); assert.equal(f.owner.rootProcessState.kind, 'pending');
    await assert.rejects(f.owner.waitForPrimaryChild({ timeoutMs: 5 }), /root_wait_timeout/);
    const abort = new AbortController(), waiting = f.owner.waitForPrimaryChild({ signal: abort.signal });
    abort.abort(); await assert.rejects(waiting, /root_wait_aborted/);
    f.owner.terminate(); await assert.rejects(f.owner.waitForPrimaryChild(), /root_closed/);
    assert.equal(f.calls.length, 0);
});
test('multiple captured root objects never select a primary, including the readiness race', async () => {
    const roots = new ClaudeSdkRoots();
    const fake = (pid: number) => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }) as unknown as ChildProcessWithoutNullStreams;
    const first = fake(101), second = fake(102);
    roots.track(first); assert.equal(roots.primary, first);
    const waiting = roots.wait(); roots.track(second);
    await assert.rejects(waiting, /multiple_root_processes/);
    assert.deepEqual(roots.state, { kind: 'multiple', count: 2 }); assert.equal(roots.primary, null); roots.close();
});
test('captured failed or exited root is diagnostic only, never ready', async () => {
    for (const error of [false, true]) {
        const roots = new ClaudeSdkRoots();
        const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, signalCode: null }) as unknown as ChildProcessWithoutNullStreams;
        roots.track(child);
        if (error) child.emit('error', new Error('fixture'));
        else { child.exitCode = 1; child.emit('exit', 1, null); }
        assert.equal(roots.primary, child);
        await assert.rejects(roots.wait(), /root_(spawn_failed|exited)/); roots.close();
    }
});
