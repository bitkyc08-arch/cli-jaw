import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process';
import { ownProcess, type OwnedProcessOptions } from '../../src/agent/spawn/process-kill.js';
import { searchNotes } from '../../src/notes/search.js';
import * as bgtask from '../../src/bgtask/runner.js';
import { createTask } from '../../src/bgtask/registry.js';
import { AcpClient } from '../../src/cli/acp-client.js';
import { detectNotesCapabilities } from '../../src/manager/notes/capabilities.js';

type TreeCall = { pid: number; signal: NodeJS.Signals };
type FakeTimer = { fn: () => void; ms: number; cleared: boolean; unref(): FakeTimer };

class FakeChild extends EventEmitter {
    readonly pid: number;
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin: Writable;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killed = false;
    onInput: ((text: string) => void) | null = null;

    constructor(pid: number) {
        super();
        this.pid = pid;
        this.stdin = new Writable({
            write: (chunk, _encoding, callback) => {
                this.onInput?.(String(chunk));
                callback();
            },
        });
    }

    kill(): never {
        throw new Error('direct ChildProcess.kill() was restored');
    }

    exit(code = 0): void {
        if (this.exitCode !== null || this.signalCode !== null) return;
        this.exitCode = code;
        this.emit('exit', code, null);
    }
}

type SpawnBehavior = (child: FakeChild, command: string, args: readonly string[]) => void;
const spawnBehaviors: SpawnBehavior[] = [];
let nextPid = 41_000;

function fakeSpawn(command: string, args: readonly string[] = [], _options?: SpawnOptions): ChildProcess {
    const child = new FakeChild(nextPid++);
    activeHarness?.children.push(child);
    const behavior = spawnBehaviors.shift();
    if (!behavior) throw new Error(`unexpected spawn: ${command}`);
    behavior(child, command, args);
    return child as unknown as ChildProcess;
}

type OwnerHarness = {
    calls: TreeCall[];
    children: FakeChild[];
    timers: FakeTimer[];
};

let activeHarness: OwnerHarness | null = null;

function beginHarness(): OwnerHarness {
    const harness: OwnerHarness = { calls: [], children: [], timers: [] };
    activeHarness = harness;
    return harness;
}

function ownerOptions(harness: OwnerHarness): OwnedProcessOptions {
    return {
        terminateTree: (pid, signal = 'SIGTERM') => { harness.calls.push({ pid, signal }); },
        setTimer: ((fn: () => void, ms: number) => {
            const timer: FakeTimer = {
                fn,
                ms,
                cleared: false,
                unref() { return this; },
            };
            harness.timers.push(timer);
            return timer as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
        clearTimer: ((timer: FakeTimer) => { timer.cleared = true; }) as unknown as typeof clearTimeout,
    };
}

function assertExitDisarmsEscalation(harness: OwnerHarness): void {
    const callsBeforeExit = harness.calls.length;
    for (const child of harness.children) child.exit();
    for (const timer of harness.timers) timer.fn();
    assert.equal(harness.calls.length, callsBeforeExit, 'exit must suppress delayed tree escalation');
    assert.ok(harness.timers.every(timer => timer.cleared), 'exit must clear every pending escalation timer');
}

function firstPid(harness: OwnerHarness): number {
    const pid = harness.children[0]?.pid;
    assert.ok(pid, 'expected one spawned child');
    return pid;
}

function uniqueCommand(label: string): string[] {
    return [`fake-owned-${label}-${randomUUID()}`];
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('timed out waiting for routed termination');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

test('notes search result cap terminates the owned rg tree', async () => {
    const harness = beginHarness();
    const root = mkdtempSync(join(tmpdir(), 'jaw-owned-search-'));
    spawnBehaviors.push(child => {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({
            type: 'match',
            data: { path: { text: join(root, 'one.md') }, line_number: 1, lines: { text: 'alpha\n' } },
        })}\n`));
    });
    try {
        const result = await searchNotes(root, 'alpha', {
            limit: 1,
            spawnImpl: fakeSpawn as typeof spawn,
            ownedProcessOptions: ownerOptions(harness),
        });
        assert.equal(result.length, 1);
        assert.deepEqual(harness.calls, [{ pid: firstPid(harness), signal: 'SIGTERM' }]);
        assert.equal(ownProcess(harness.children[0] as unknown as ChildProcess).reason, 'completion');
        assertExitDisarmsEscalation(harness);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('notes search timeout terminates the owned rg tree', async () => {
    const harness = beginHarness();
    const root = mkdtempSync(join(tmpdir(), 'jaw-owned-search-timeout-'));
    spawnBehaviors.push(() => { /* intentionally silent */ });
    try {
        await assert.rejects(searchNotes(root, 'alpha', {
            timeoutMs: 1,
            spawnImpl: fakeSpawn as typeof spawn,
            ownedProcessOptions: ownerOptions(harness),
        }), { code: 'notes_search_timeout' });
        assert.deepEqual(harness.calls, [{ pid: firstPid(harness), signal: 'SIGTERM' }]);
        assert.equal(ownProcess(harness.children[0] as unknown as ChildProcess).reason, 'timeout');
        assertExitDisarmsEscalation(harness);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

for (const stream of ['stdout', 'stderr'] as const) {
    test(`notes search ${stream} cap terminates the owned rg tree`, async () => {
        const harness = beginHarness();
        const root = mkdtempSync(join(tmpdir(), `jaw-owned-search-${stream}-`));
        spawnBehaviors.push(child => {
            queueMicrotask(() => child[stream].write(Buffer.alloc(2 * 1024 * 1024 + 1, 'x')));
        });
        try {
            await assert.rejects(searchNotes(root, 'alpha', {
                spawnImpl: fakeSpawn as typeof spawn,
                ownedProcessOptions: ownerOptions(harness),
            }), { code: 'notes_search_output_too_large' });
            assert.deepEqual(harness.calls, [{ pid: firstPid(harness), signal: 'SIGTERM' }]);
            assert.equal(ownProcess(harness.children[0] as unknown as ChildProcess).reason, 'output-limit');
            assertExitDisarmsEscalation(harness);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
}

test('bgtask stall preserves immediate SIGKILL tree policy', async () => {
    const harness = beginHarness();
    spawnBehaviors.push(() => { /* intentionally silent */ });
    const row = createTask({
        kind: 'shell',
        spec: {
            command: uniqueCommand('bgtask'),
            completion: { type: 'exit' },
            promptTemplate: 'owned {{taskId}} {{status}} {{result}}',
            stallAfterMs: 20,
        },
    });
    bgtask.startTask(row, () => {}, {
        spawnImpl: fakeSpawn as typeof spawn,
        ownedProcessOptions: ownerOptions(harness),
    });
    await waitFor(() => harness.calls.length > 0);
    assert.deepEqual(harness.calls, [{ pid: firstPid(harness), signal: 'SIGKILL' }]);
    assert.equal(ownProcess(harness.children[0] as unknown as ChildProcess).reason, 'stall');
    assert.equal(harness.timers.length, 0, 'immediate SIGKILL policy must not schedule escalation');
    assertExitDisarmsEscalation(harness);
});

test('bgtask stalled respawn terminates the first tree before owning the replacement', async () => {
    const harness = beginHarness();
    spawnBehaviors.push(() => { /* first child stalls */ }, () => { /* replacement remains live */ });
    const row = createTask({
        kind: 'shell',
        spec: {
            command: uniqueCommand('respawn'),
            completion: { type: 'exit' },
            promptTemplate: 'respawn {{taskId}} {{status}} {{result}}',
            stallAfterMs: 20,
            respawn: true,
        },
    });
    bgtask.startTask(row, () => {}, {
        spawnImpl: fakeSpawn as typeof spawn,
        ownedProcessOptions: ownerOptions(harness),
    });
    await waitFor(() => harness.children.length === 2);
    assert.deepEqual(harness.calls, [{ pid: harness.children[0]!.pid, signal: 'SIGKILL' }]);
    assert.equal(ownProcess(harness.children[0] as unknown as ChildProcess).reason, 'stall');
    bgtask.stopAllBgTasks();
    assert.deepEqual(harness.calls[1], { pid: harness.children[1]!.pid, signal: 'SIGTERM' });
    assert.equal(ownProcess(harness.children[1] as unknown as ChildProcess).reason, 'shutdown');
    assertExitDisarmsEscalation(harness);
});

test('bgtask completion line terminates once with completion reason', async () => {
    const harness = beginHarness();
    spawnBehaviors.push(child => {
        queueMicrotask(() => child.stdout.write('DONE\n'));
    });
    const row = createTask({
        kind: 'shell',
        spec: {
            command: uniqueCommand('completion'),
            completion: { type: 'line-pattern', regex: '^DONE$' },
            promptTemplate: 'completion {{taskId}} {{status}} {{result}}',
        },
    });
    bgtask.startTask(row, () => {}, {
        spawnImpl: fakeSpawn as typeof spawn,
        ownedProcessOptions: ownerOptions(harness),
    });
    await waitFor(() => harness.calls.length > 0);
    assert.deepEqual(harness.calls, [{ pid: firstPid(harness), signal: 'SIGTERM' }]);
    assert.equal(ownProcess(harness.children[0] as unknown as ChildProcess).reason, 'completion');
    assertExitDisarmsEscalation(harness);
});

test('bgtask deadline terminates once with timeout reason', async () => {
    const harness = beginHarness();
    spawnBehaviors.push(() => { /* intentionally silent */ });
    const row = createTask({
        kind: 'shell',
        spec: {
            command: uniqueCommand('deadline'),
            completion: { type: 'exit' },
            promptTemplate: 'deadline {{taskId}} {{status}} {{result}}',
            deadlineAt: new Date(Date.now() + 20).toISOString(),
        },
    });
    bgtask.startTask(row, () => {}, {
        spawnImpl: fakeSpawn as typeof spawn,
        ownedProcessOptions: ownerOptions(harness),
    });
    await waitFor(() => harness.calls.length > 0);
    assert.deepEqual(harness.calls, [{ pid: firstPid(harness), signal: 'SIGTERM' }]);
    assert.equal(ownProcess(harness.children[0] as unknown as ChildProcess).reason, 'timeout');
    assertExitDisarmsEscalation(harness);
});

test('bgtask cancel terminates once with cancel reason', () => {
    const harness = beginHarness();
    spawnBehaviors.push(() => { /* intentionally silent */ });
    const row = createTask({
        kind: 'shell',
        spec: {
            command: uniqueCommand('cancel'),
            completion: { type: 'exit' },
            promptTemplate: 'cancel {{taskId}} {{status}} {{result}}',
        },
    });
    bgtask.startTask(row, () => {}, {
        spawnImpl: fakeSpawn as typeof spawn,
        ownedProcessOptions: ownerOptions(harness),
    });
    bgtask.cancelTask(row.id);
    assert.deepEqual(harness.calls, [{ pid: firstPid(harness), signal: 'SIGTERM' }]);
    assert.equal(ownProcess(harness.children[0] as unknown as ChildProcess).reason, 'cancel');
    assertExitDisarmsEscalation(harness);
});

test('bgtask server stop terminates once with shutdown reason', () => {
    const harness = beginHarness();
    spawnBehaviors.push(() => { /* intentionally silent */ });
    const row = createTask({
        kind: 'shell',
        spec: {
            command: uniqueCommand('shutdown'),
            completion: { type: 'exit' },
            promptTemplate: 'shutdown {{taskId}} {{status}} {{result}}',
        },
    });
    bgtask.startTask(row, () => {}, {
        spawnImpl: fakeSpawn as typeof spawn,
        ownedProcessOptions: ownerOptions(harness),
    });
    bgtask.stopAllBgTasks();
    assert.deepEqual(harness.calls, [{ pid: firstPid(harness), signal: 'SIGTERM' }]);
    assert.equal(ownProcess(harness.children[0] as unknown as ChildProcess).reason, 'shutdown');
    assertExitDisarmsEscalation(harness);
});

test('AcpClient kill terminates the owned Copilot ACP tree', () => {
    const harness = beginHarness();
    spawnBehaviors.push(() => { /* protocol is not needed for public kill() */ });
    const client = new AcpClient({
        spawnImpl: fakeSpawn as typeof spawn,
        ownedProcessOptions: ownerOptions(harness),
    }).spawn();
    client.kill();
    assert.deepEqual(harness.calls, [{ pid: firstPid(harness), signal: 'SIGTERM' }]);
    assert.equal(ownProcess(harness.children[0] as unknown as ChildProcess).reason, 'cancel');
    assertExitDisarmsEscalation(harness);
});

test('notes capability timeouts terminate all owned probe trees', async () => {
    const harness = beginHarness();
    spawnBehaviors.push(() => {}, () => {}, () => {});
    const result = await detectNotesCapabilities({
        spawnImpl: fakeSpawn as typeof spawn,
        ownedProcessOptions: ownerOptions(harness),
    });
    assert.equal(result.ripgrep.reason, 'timeout');
    assert.deepEqual(harness.calls, harness.children.map(child => ({ pid: child.pid, signal: 'SIGTERM' })));
    assert.ok(harness.children.every(child => ownProcess(child as unknown as ChildProcess).reason === 'timeout'));
    assertExitDisarmsEscalation(harness);
});
