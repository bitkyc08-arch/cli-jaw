import '../setup/isolated-home.ts';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { SessionLanes } from '../../src/orchestrator/session-lanes.ts';
import { activeMainProcesses, killActiveAgent, killAllAgents } from '../../src/agent/spawn.ts';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}

function fakeChild(onKill: () => void): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    child.kill = (() => { onKill(); return true; }) as ChildProcess['kill'];
    Object.defineProperties(child, {
        killed: { value: false, writable: true },
        exitCode: { value: null, writable: true },
        signalCode: { value: null, writable: true },
    });
    return child;
}

afterEach(() => {
    activeMainProcesses.clear();
});

describe('multi-session concurrency activation', () => {
    it('starts B before A completes while serializing A2 behind A1', async () => {
        const lanes = new SessionLanes(() => 2);
        const a1Gate = deferred<void>();
        const b1Gate = deferred<void>();
        const starts: string[] = [];
        const a1 = lanes.run('A', async () => { starts.push('A1'); await a1Gate.promise; });
        const a2 = lanes.run('A', async () => { starts.push('A2'); });
        const b1 = lanes.run('B', async () => { starts.push('B1'); await b1Gate.promise; });
        await Promise.resolve();
        assert.deepEqual(starts, ['A1', 'B1']);
        assert.equal(lanes.stats().active, 2);
        a1Gate.resolve();
        b1Gate.resolve();
        await Promise.all([a1, a2, b1]);
        assert.deepEqual(starts, ['A1', 'B1', 'A2']);
    });

    it('scoped stop kills A only and global stop kills all remaining scopes', () => {
        const killed: string[] = [];
        activeMainProcesses.set('A', {
            process: fakeChild(() => killed.push('A')), starting: false,
            steering: false, ownerGeneration: 1, meta: { origin: 'slack', scopeId: 'A' },
        });
        activeMainProcesses.set('B', {
            process: fakeChild(() => killed.push('B')), starting: false,
            steering: false, ownerGeneration: 1, meta: { origin: 'slack', scopeId: 'B' },
        });

        assert.equal(killActiveAgent('A', 'api'), true);
        assert.deepEqual(killed, ['A']);
        assert.equal(activeMainProcesses.has('A'), false);
        assert.equal(activeMainProcesses.has('B'), true);

        assert.equal(killAllAgents('api'), true);
        assert.deepEqual(killed, ['A', 'B']);
        assert.equal(activeMainProcesses.size, 0);
    });
});
