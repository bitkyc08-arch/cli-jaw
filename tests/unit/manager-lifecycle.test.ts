import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DashboardLifecycleManager } from '../../src/manager/lifecycle.js';
import type { DashboardInstance } from '../../src/manager/types.js';

class FakeChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 4321;
    killed = false;

    kill(signal?: NodeJS.Signals): boolean {
        this.killed = signal === 'SIGTERM' || signal == null;
        queueMicrotask(() => this.emit('exit', 0, signal || null));
        return true;
    }
}

function makeOffline(port = 3457): DashboardInstance {
    return {
        port,
        url: `http://localhost:${port}`,
        status: 'offline',
        ok: false,
        version: null,
        uptime: null,
        instanceId: null,
        homeDisplay: null,
        workingDir: null,
        currentCli: null,
        currentModel: null,
        serviceMode: 'unknown',
        lastCheckedAt: '2026-04-27T00:00:00.000Z',
        healthReason: 'offline',
    };
}

function makeOnline(port = 3457): DashboardInstance {
    return {
        ...makeOffline(port),
        status: 'online',
        ok: true,
        healthReason: null,
    };
}

test('lifecycle builds start command with top-level home flag', () => {
    const manager = new DashboardLifecycleManager({
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        homeRoot: '/Users/jun',
    });

    assert.deepEqual(manager.buildStartCommand(3458), [
        '/usr/local/bin/jaw',
        '--home',
        '/Users/jun/.cli-jaw-3458',
        'serve',
        '--port',
        '3458',
        '--no-open',
    ]);
});

test('lifecycle rejects ports outside scan range', async () => {
    const manager = new DashboardLifecycleManager({
        from: 3457,
        count: 2,
        jawPath: '/usr/local/bin/jaw',
        isPortOccupied: async () => false,
    });

    const result = await manager.start(3500);

    assert.equal(result.ok, false);
    assert.match(result.message, /outside dashboard scan range/);
});

test('lifecycle marks external online instances as visible but not stoppable', () => {
    const manager = new DashboardLifecycleManager({
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
    });

    const row = manager.decorateInstance(makeOnline(3457));

    assert.equal(row.lifecycle?.owner, 'external');
    assert.equal(row.lifecycle?.canStart, false);
    assert.equal(row.lifecycle?.canStop, false);
    assert.equal(row.lifecycle?.canRestart, false);
});

test('lifecycle marks offline ports as startable with port-derived default home', () => {
    const manager = new DashboardLifecycleManager({
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        homeRoot: '/Users/jun',
    });

    const row = manager.decorateInstance(makeOffline(3460));

    assert.equal(row.lifecycle?.owner, 'none');
    assert.equal(row.lifecycle?.canStart, true);
    assert.equal(row.lifecycle?.defaultHome, '/Users/jun/.cli-jaw-3460');
});

test('lifecycle stop/restart are limited to manager-owned child processes', async () => {
    const children: FakeChild[] = [];
    const manager = new DashboardLifecycleManager({
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        isPortOccupied: async () => false,
        spawnImpl: ((command: string, args: string[]) => {
            assert.equal(command, '/usr/local/bin/jaw');
            assert.deepEqual(args.slice(0, 2), ['--home', '/Users/jun/.cli-jaw-3457']);
            const child = new FakeChild();
            children.push(child);
            return child;
        }) as never,
    });

    const rejected = await manager.stop(3457);
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /dashboard-owned/);

    const started = await manager.start(3457, '/Users/jun/.cli-jaw-3457');
    assert.equal(started.ok, true);
    const owned = manager.decorateInstance(makeOnline(3457));
    assert.equal(owned.lifecycle?.owner, 'manager');
    assert.equal(owned.lifecycle?.canStop, true);
    assert.equal(owned.lifecycle?.canRestart, true);

    const stopped = await manager.stop(3457);
    assert.equal(stopped.ok, true);
    assert.equal(children[0]?.killed, true);
});

test('lifecycle stopAll returns empty when no child is managed', async () => {
    const manager = new DashboardLifecycleManager({
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
    });

    assert.deepEqual(await manager.stopAll(), []);
});

test('lifecycle stopAll stops all manager-owned children and is idempotent', async () => {
    const children: FakeChild[] = [];
    const manager = new DashboardLifecycleManager({
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        isPortOccupied: async () => false,
        spawnImpl: (() => {
            const child = new FakeChild();
            children.push(child);
            return child;
        }) as never,
    });

    assert.equal((await manager.start(3457)).ok, true);
    assert.equal((await manager.start(3458)).ok, true);

    const stopped = await manager.stopAll();

    assert.equal(stopped.length, 2);
    assert.deepEqual(stopped.map(result => result.port).sort(), [3457, 3458]);
    assert.ok(stopped.every(result => result.ok));
    assert.ok(children.every(child => child.killed));
    assert.deepEqual(await manager.stopAll(), []);
});

test('lifecycle stopAll ignores external online instances', async () => {
    const manager = new DashboardLifecycleManager({
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
    });

    const row = manager.decorateInstance(makeOnline(3457));

    assert.equal(row.lifecycle?.owner, 'external');
    assert.deepEqual(await manager.stopAll(), []);
});

test('lifecycle start reports immediate child process failures', async () => {
    const manager = new DashboardLifecycleManager({
        from: 3457,
        count: 50,
        jawPath: '/missing/jaw',
        isPortOccupied: async () => false,
        spawnImpl: (() => {
            const child = new FakeChild();
            queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
            return child;
        }) as never,
    });

    const result = await manager.start(3457);

    assert.equal(result.ok, false);
    assert.equal(result.status, 'error');
    assert.match(result.message, /spawn ENOENT/);
    assert.equal(manager.decorateInstance(makeOnline(3457)).lifecycle?.owner, 'external');
});
