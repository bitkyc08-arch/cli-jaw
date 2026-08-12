import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardLifecycleManager } from '../../src/manager/lifecycle.js';
import type { DashboardInstance } from '../../src/manager/types.js';

const MANAGER_PORT = 24576;

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

    unref(): void {}
}

function setupTmpStorage(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-mgr-test-'));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
    return { ...makeOffline(port), status: 'online', ok: true, healthReason: null };
}

test('lifecycle builds start command with top-level home flag', () => {
    const { dir, cleanup } = setupTmpStorage();
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        homeRoot: '/Users/jun',
        storageRoot: dir,
    });

    assert.deepEqual(manager.buildStartCommand(3457), [
        '/usr/local/bin/jaw',
        '--home',
        join('/Users/jun', '.cli-jaw'),
        'serve',
        '--port',
        '3457',
        '--no-open',
    ]);
    assert.deepEqual(manager.buildStartCommand(3458), [
        '/usr/local/bin/jaw',
        '--home',
        join('/Users/jun', '.cli-jaw-3458'),
        'serve',
        '--port',
        '3458',
        '--no-open',
    ]);
    cleanup();
});

test('lifecycle runs JavaScript jaw entrypoints through Node', (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\cli-jaw\\dist\\bin\\cli-jaw.js',
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        storageRoot: dir,
    });

    assert.deepEqual(manager.buildStartCommand(3458, 'C:\\Users\\user\\.cli-jaw-3458'), [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\cli-jaw\\dist\\bin\\cli-jaw.js',
        '--home',
        'C:\\Users\\user\\.cli-jaw-3458',
        'serve',
        '--port',
        '3458',
        '--no-open',
    ]);
});

test('lifecycle keeps executable jaw entrypoints in command position', (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: 'C:\\Users\\user\\AppData\\Roaming\\npm\\jaw.cmd',
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        storageRoot: dir,
    });

    assert.deepEqual(manager.buildStartCommand(3458, 'C:\\Users\\user\\.cli-jaw-3458'), [
        'C:\\Users\\user\\AppData\\Roaming\\npm\\jaw.cmd',
        '--home',
        'C:\\Users\\user\\.cli-jaw-3458',
        'serve',
        '--port',
        '3458',
        '--no-open',
    ]);
});

test('lifecycle rejects ports outside scan range', async (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 2,
        jawPath: '/usr/local/bin/jaw',
        storageRoot: dir,
        processVerify: { isPortOccupied: async () => false },
    });

    const result = await manager.start(3500);

    assert.equal(result.ok, false);
    assert.match(result.message, /outside dashboard scan range/);
});

test('lifecycle marks external online core instances as stoppable by listener PID only', (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        storageRoot: dir,
    });

    const row = manager.decorateInstance(makeOnline(3457));

    assert.equal(row.lifecycle?.owner, 'external');
    assert.equal(row.lifecycle?.canStart, false);
    assert.equal(row.lifecycle?.canStop, true);
    assert.equal(row.lifecycle?.canRestart, false);
    assert.match(row.lifecycle?.reason || '', /listener pid/);
});

test('lifecycle keeps external custom scan ports non-stoppable in capability', (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 4000,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        storageRoot: dir,
    });

    const row = manager.decorateInstance(makeOnline(4000));

    assert.equal(row.lifecycle?.owner, 'external');
    assert.equal(row.lifecycle?.canStop, false);
    assert.equal(row.lifecycle?.canRestart, false);
    assert.equal(row.lifecycle?.reason, 'not dashboard-owned');
});

test('lifecycle marks offline ports as startable with default home policy', (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        homeRoot: '/Users/jun',
        storageRoot: dir,
    });

    const defaultRow = manager.decorateInstance(makeOffline(3457));
    const row = manager.decorateInstance(makeOffline(3460));

    assert.equal(defaultRow.lifecycle?.defaultHome, join('/Users/jun', '.cli-jaw'));
    assert.equal(row.lifecycle?.owner, 'none');
    assert.equal(row.lifecycle?.canStart, true);
    assert.equal(row.lifecycle?.defaultHome, join('/Users/jun', '.cli-jaw-3460'));
});

test('lifecycle stop can terminate external core listener PID but restart remains owner-limited', async (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const children: FakeChild[] = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        homeRoot: dir,
        storageRoot: dir,
        processVerify: {
            isPortOccupied: async () => false,
            resolveListeningPid: async (port) => (port === 3457 ? 99001 : null),
            isPidAlive: () => false,
            killPid: (pid, signal) => { killed.push({ pid, signal }); },
        },
        spawnImpl: ((command: string, args: string[]) => {
            assert.equal(command, '/usr/local/bin/jaw');
            assert.deepEqual(args.slice(0, 2), ['--home', join(dir, '.cli-jaw')]);
            const child = new FakeChild();
            children.push(child);
            return child;
        }) as never,
    });

    const restartRejected = await manager.restart(3457);
    assert.equal(restartRejected.ok, false);
    assert.match(restartRejected.message, /dashboard-owned/);

    const stoppedExternal = await manager.stop(3457);
    assert.equal(stoppedExternal.ok, true);
    assert.equal(stoppedExternal.pid, 99001);
    assert.match(stoppedExternal.message, /listener PID 99001/);
    assert.deepEqual(killed, [{ pid: 99001, signal: 'SIGTERM' }]);

    const started = await manager.start(3457);
    assert.equal(started.ok, true);
    const owned = manager.decorateInstance(makeOnline(3457));
    assert.equal(owned.lifecycle?.owner, 'manager');
    assert.equal(owned.lifecycle?.canStop, true);
    assert.equal(owned.lifecycle?.canRestart, true);

    const stopped = await manager.stop(3457);
    assert.equal(stopped.ok, true);
    assert.equal(children[0]?.killed, true);
});

test('lifecycle external stop rejects outside canonical core ports even with custom scan range', async (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const killed: number[] = [];
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 4000,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        storageRoot: dir,
        processVerify: {
            isPortOccupied: async () => true,
            resolveListeningPid: async () => 99002,
            isPidAlive: () => true,
            killPid: (pid) => { killed.push(pid); },
        },
    });

    const result = await manager.stop(4000);

    assert.equal(result.ok, false);
    assert.match(result.message, /External stop is limited to core instance ports 3457-3506/);
    assert.deepEqual(killed, []);
});

test('lifecycle self stop and peer dashboard stop keep separate policies', async (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        storageRoot: dir,
        processVerify: {
            isPortOccupied: async () => false,
            resolveListeningPid: async (port) => (port === 24577 ? 99003 : null),
            isPidAlive: () => false,
            killPid: (pid, signal) => { killed.push({ pid, signal }); },
        },
    });

    const self = await manager.stop(MANAGER_PORT);
    assert.equal(self.ok, false);
    assert.match(self.message, /self/);

    const peer = await manager.stop(24577);
    assert.equal(peer.ok, true);
    assert.match(peer.message, /Peer dashboard/);
    assert.deepEqual(killed, [{ pid: 99003, signal: 'SIGTERM' }]);
});

test('lifecycle stopAll returns empty when no child is managed', async (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        storageRoot: dir,
    });

    assert.deepEqual(await manager.stopAll(), []);
});

test('lifecycle stopAll stops all manager-owned children and is idempotent', async (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const children: FakeChild[] = [];
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        homeRoot: dir,
        storageRoot: dir,
        processVerify: { isPortOccupied: async () => false },
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

test('lifecycle stopAll ignores external online instances', async (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        storageRoot: dir,
    });

    const row = manager.decorateInstance(makeOnline(3457));

    assert.equal(row.lifecycle?.owner, 'external');
    assert.deepEqual(await manager.stopAll(), []);
    assert.deepEqual(manager.processControlState().managed, []);
});

test('lifecycle process control inventory lists only dashboard-managed entries', async (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: '/usr/local/bin/jaw',
        homeRoot: dir,
        storageRoot: dir,
        processVerify: { isPortOccupied: async () => false },
        spawnImpl: (() => new FakeChild()) as never,
    });

    assert.equal((await manager.start(3457)).ok, true);

    const state = manager.processControlState();
    assert.equal(state.managed.length, 1);
    assert.equal(state.managed[0]?.port, 3457);
    assert.equal(state.managed[0]?.proof, 'child');
    assert.equal(state.managed[0]?.canStop, true);
    assert.equal(state.managed[0]?.canForceRelease, false);
    assert.equal(state.unsupported.forceRelease, true);
});

test('lifecycle start reports immediate child process failures', async (t) => {
    const { dir, cleanup } = setupTmpStorage();
    t.after(cleanup);
    const manager = new DashboardLifecycleManager({
        managerPort: MANAGER_PORT,
        from: 3457,
        count: 50,
        jawPath: '/missing/jaw',
        homeRoot: dir,
        storageRoot: dir,
        processVerify: { isPortOccupied: async () => false },
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
