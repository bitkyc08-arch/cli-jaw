import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardLifecycleManager } from '../../src/manager/lifecycle.js';
import { LifecycleStore } from '../../src/manager/lifecycle-store.js';
import type { ProcessVerifyImpl } from '../../src/manager/process-verify.js';
import type { DashboardInstance } from '../../src/manager/types.js';

const MGR = 24576;

class FakeChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid: number;
    killed = false;

    constructor(pid = 4321) {
        super();
        this.pid = pid;
    }

    kill(signal?: NodeJS.Signals): boolean {
        this.killed = signal === 'SIGTERM' || signal == null;
        queueMicrotask(() => this.emit('exit', 0, signal || null));
        return true;
    }

    unref(): void {}
}

function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), 'jaw-persist-test-'));
}

// These serial fixtures trigger fire-and-forget prune writes. Capture the real
// public store promises and drain them before deleting their filesystem root.
function capturePersistence(t: TestContext): () => Promise<void> {
    const pending: Promise<void>[] = [];
    for (const method of ['save', 'deleteMarker'] as const) {
        const original = LifecycleStore.prototype[method];
        t.mock.method(LifecycleStore.prototype, method, function (this: LifecycleStore, ...args: unknown[]) {
            const operation = Reflect.apply(original, this, args) as Promise<void>;
            pending.push(operation); return operation;
        });
    }
    return async () => {
        let seen = 0, failure: PromiseRejectedResult | undefined;
        while (seen < pending.length) {
            const batch = pending.slice(seen); seen = pending.length;
            const results = await Promise.allSettled(batch);
            failure ??= results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        }
        if (failure) throw failure.reason;
    };
}

function makeOnline(port: number): DashboardInstance {
    return {
        port,
        url: `http://localhost:${port}`,
        status: 'online',
        ok: true,
        version: null,
        uptime: null,
        instanceId: null,
        homeDisplay: null,
        workingDir: null,
        currentCli: null,
        currentModel: null,
        serviceMode: 'unknown',
        lastCheckedAt: '2026-04-27T00:00:00.000Z',
        healthReason: null,
    };
}

function makeOffline(port: number): DashboardInstance {
    return { ...makeOnline(port), status: 'offline', ok: false, healthReason: 'offline' };
}

function fakeVerify(overrides: Partial<ProcessVerifyImpl> = {}): ProcessVerifyImpl {
    return {
        isPidAlive: () => true,
        resolveListeningPid: async () => null,
        killPid: () => undefined,
        isPortOccupied: async () => false,
        ...overrides,
    };
}

type EntrySeed = { port: number; pid: number; token: string; home: string };

async function plantPersistedEntries(root: string, seeds: EntrySeed[]): Promise<void> {
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    await store.save(
        seeds.map(s => ({
            schemaVersion: 1 as const,
            managerPort: MGR,
            port: s.port,
            pid: s.pid,
            home: s.home,
            startedAt: '2026-04-28T00:00:00.000Z',
            command: ['/jaw', '--home', s.home, 'serve', '--port', String(s.port), '--no-open'],
            token: s.token,
        })),
    );
    for (const s of seeds) {
        await store.writeMarker(s.home, {
            schemaVersion: 1,
            managedBy: 'cli-jaw-dashboard',
            managerPort: MGR,
            port: s.port,
            pid: s.pid,
            token: s.token,
            startedAt: '2026-04-28T00:00:00.000Z',
        });
    }
}

async function plantPersistedEntry(
    root: string,
    port: number,
    pid: number,
    token: string,
    home: string,
): Promise<void> {
    await plantPersistedEntries(root, [{ port, pid, token, home }]);
}

test('start persists registry + marker immediately and prunes on early exit', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, '.cli-jaw-3457');
    let child: FakeChild | null = null;
    const manager = new DashboardLifecycleManager({
        managerPort: MGR,
        from: 3457,
        count: 4,
        jawPath: '/jaw',
        homeRoot: root,
        storageRoot: root,
        processVerify: fakeVerify({ isPortOccupied: async () => false }),
        spawnImpl: (() => {
            child = new FakeChild(99001);
            queueMicrotask(() => child!.emit('error', new Error('spawn failed')));
            return child!;
        }) as never,
    });

    const result = await manager.start(3457, home);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'error');

    // registry file should exist (we wrote it during the spawn) but should now contain no entries
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    const persisted = await store.load();
    assert.deepEqual(persisted.entries, []);
    assert.equal(existsSync(join(home, '.dashboard-managed.json')), false);
});

test('attached stop unchanged: child.kill SIGTERM, registry + marker pruned', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, '.cli-jaw-3457');
    let child: FakeChild | null = null;
    const manager = new DashboardLifecycleManager({
        managerPort: MGR,
        from: 3457,
        count: 4,
        jawPath: '/jaw',
        homeRoot: root,
        storageRoot: root,
        processVerify: fakeVerify({ isPortOccupied: async () => false }),
        spawnImpl: (() => {
            child = new FakeChild(99002);
            return child!;
        }) as never,
    });

    assert.equal((await manager.start(3457, home)).ok, true);
    assert.equal(existsSync(join(home, '.dashboard-managed.json')), true);

    const stop = await manager.stop(3457);
    assert.equal(stop.ok, true);
    assert.equal(child!.killed, true);

    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    assert.deepEqual((await store.load()).entries, []);
    assert.equal(existsSync(join(home, '.dashboard-managed.json')), false);
});

test('hydrate adopts a valid persisted entry and exposes recovered capability', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, '.cli-jaw-3458');
    const token = 'a'.repeat(32);
    await plantPersistedEntry(root, 3458, 99003, token, home);
    const manager = new DashboardLifecycleManager({
        managerPort: MGR,
        from: 3457,
        count: 4,
        jawPath: '/jaw',
        homeRoot: root,
        storageRoot: root,
        processVerify: fakeVerify({
            isPidAlive: (pid) => pid === 99003,
            resolveListeningPid: async (port) => (port === 3458 ? 99003 : null),
        }),
    });

    const { adopted, pruned } = await manager.hydrate();
    assert.equal(adopted, 1);
    assert.equal(pruned, 0);

    const decorated = manager.decorateInstance(makeOnline(3458));
    assert.equal(decorated.lifecycle?.owner, 'manager');
    assert.equal(decorated.lifecycle?.canStop, true);
    assert.equal(decorated.lifecycle?.canRestart, true);
    assert.match(decorated.lifecycle?.reason || '', /recovered/);
    assert.equal(decorated.lifecycle?.pid, 99003);
});

test('hydrate prunes when pid is dead', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, '.cli-jaw-3458');
    await plantPersistedEntry(root, 3458, 99004, 'b'.repeat(32), home);
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify({ isPidAlive: () => false }),
    });
    const { adopted, pruned } = await manager.hydrate();
    assert.equal(adopted, 0);
    assert.equal(pruned, 1);
});

test('hydrate prunes when resolveListeningPid mismatches', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, '.cli-jaw-3458');
    await plantPersistedEntry(root, 3458, 99005, 'c'.repeat(32), home);
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify({
            isPidAlive: () => true,
            resolveListeningPid: async () => 88888, // different pid owns the port
        }),
    });
    const { adopted, pruned } = await manager.hydrate();
    assert.equal(adopted, 0);
    assert.equal(pruned, 1);
});

test('hydrate prunes when marker is missing', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, '.cli-jaw-3458');
    const token = 'd'.repeat(32);
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    await store.save([
        {
            schemaVersion: 1, managerPort: MGR, port: 3458, pid: 99006, home,
            startedAt: '', command: [], token,
        },
    ]);
    // do NOT write marker
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify({
            isPidAlive: () => true,
            resolveListeningPid: async () => 99006,
        }),
    });
    const { adopted, pruned } = await manager.hydrate();
    assert.equal(adopted, 0);
    assert.equal(pruned, 1);
});

test('hydrate prunes when marker token mismatches', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, '.cli-jaw-3458');
    await plantPersistedEntry(root, 3458, 99007, 'e'.repeat(32), home);
    // tamper marker
    const markerPath = join(home, '.dashboard-managed.json');
    const tampered = JSON.parse(readFileSync(markerPath, 'utf8'));
    tampered.token = 'f'.repeat(32);
    writeFileSync(markerPath, JSON.stringify(tampered));
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify({
            isPidAlive: () => true,
            resolveListeningPid: async () => 99007,
        }),
    });
    const { adopted, pruned } = await manager.hydrate();
    assert.equal(adopted, 0);
    assert.equal(pruned, 1);
});

test('hydrate prunes when port is outside scan range', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, '.cli-jaw-9999');
    await plantPersistedEntry(root, 9999, 99008, 'g'.repeat(32), home);
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify({
            isPidAlive: () => true,
            resolveListeningPid: async () => 99008,
        }),
    });
    const { adopted, pruned } = await manager.hydrate();
    assert.equal(adopted, 0);
    assert.equal(pruned, 1);
});

test('detached stop sends SIGTERM via verify.killPid; alive→dead exits cleanly', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, '.cli-jaw-3458');
    await plantPersistedEntry(root, 3458, 99010, 'h'.repeat(32), home);
    const sigSent: { pid: number; sig: NodeJS.Signals }[] = [];
    let alive = true;
    let owns = true;
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify({
            isPidAlive: () => alive,
            resolveListeningPid: async () => (owns ? 99010 : 11111),
            killPid: (pid, sig) => {
                sigSent.push({ pid, sig });
                alive = false;
                owns = false;
            },
            isPortOccupied: async () => false,
        }),
    });
    await manager.hydrate();
    const result = await manager.stop(3458);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'stopped');
    assert.equal(sigSent[0]?.pid, 99010);
    assert.equal(sigSent[0]?.sig, 'SIGTERM');
});

test('detached stop with ownership change does NOT SIGKILL; reports stopped with note', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, '.cli-jaw-3458');
    await plantPersistedEntry(root, 3458, 99011, 'i'.repeat(32), home);
    const sigSent: NodeJS.Signals[] = [];
    let aliveSince = Date.now();
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify({
            isPidAlive: () => Date.now() - aliveSince < 999_999, // always alive during this test
            // After SIGTERM is sent, port ownership "changes" so SIGKILL must be skipped.
            resolveListeningPid: async () => (sigSent.length === 0 ? 99011 : 22222),
            killPid: (_pid, sig) => { sigSent.push(sig); },
            isPortOccupied: async () => false,
        }),
    });
    await manager.hydrate();
    const result = await manager.stop(3458);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'stopped');
    assert.match(result.message, /ownership changed/);
    assert.deepEqual(sigSent, ['SIGTERM']); // SIGKILL never sent
});

test('stopAll on hydrated detached registry sends SIGTERM and prunes persisted state', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home1 = join(root, '.cli-jaw-3457');
    const home2 = join(root, '.cli-jaw-3458');
    await plantPersistedEntries(root, [
        { port: 3457, pid: 99020, token: 'j'.repeat(32), home: home1 },
        { port: 3458, pid: 99021, token: 'k'.repeat(32), home: home2 },
    ]);
    const killed: number[] = [];
    let aliveMap: Record<number, boolean> = { 99020: true, 99021: true };
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify({
            isPidAlive: (pid) => aliveMap[pid] === true,
            resolveListeningPid: async (port) => (port === 3457 ? 99020 : port === 3458 ? 99021 : null),
            killPid: (pid) => { killed.push(pid); aliveMap[pid] = false; },
            isPortOccupied: async () => false,
        }),
    });
    await manager.hydrate();
    const results = await manager.stopAll();
    assert.equal(results.length, 2);
    assert.deepEqual(killed.sort(), [99020, 99021]);
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    assert.deepEqual((await store.load()).entries, []);
    assert.equal(existsSync(join(home1, '.dashboard-managed.json')), false);
    assert.equal(existsSync(join(home2, '.dashboard-managed.json')), false);
});

test('activeEntry prunes detached entry whose PID is gone', async (t) => {
    const root = tmpRoot();
    const drain = capturePersistence(t);
    t.after(async () => { try { await drain(); } finally { rmSync(root, { recursive: true, force: true }); } });
    const home = join(root, '.cli-jaw-3458');
    await plantPersistedEntry(root, 3458, 99030, 'l'.repeat(32), home);
    let alive = true;
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify({
            isPidAlive: () => alive,
            resolveListeningPid: async () => 99030,
        }),
    });
    await manager.hydrate();
    let row = manager.decorateInstance(makeOnline(3458));
    assert.equal(row.lifecycle?.owner, 'manager');

    alive = false; // process died externally
    row = manager.decorateInstance(makeOnline(3458));
    assert.equal(row.lifecycle?.owner, 'external');
});

test('fixture drain awaits queued registry writes and marker deletion before cleanup', async t => {
    const root = tmpRoot(), home = join(root, 'home');
    const drain = capturePersistence(t);
    let release!: () => void, wrote!: () => void, deleted!: () => void, gated = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writeEntered = new Promise<void>(resolve => { wrote = resolve; });
    const deleteEntered = new Promise<void>(resolve => { deleted = resolve; });
    t.after(async () => { release(); try { await drain(); } finally { rmSync(root, { recursive: true, force: true }); } });
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root, fsImpl: {
        mkdir, readFile, rename, existsSync,
        writeFile: async (...args: Parameters<typeof writeFile>) => { if (gated) { wrote(); await gate; } return writeFile(...args); },
        rm: async (...args: Parameters<typeof rm>) => { deleted(); await gate; return rm(...args); },
    } });
    await store.writeMarker(home, { schemaVersion: 1, managedBy: 'cli-jaw-dashboard', managerPort: MGR,
        port: 3458, pid: 99030, token: 'fixture-token', startedAt: '2026-09-06T00:00:00Z' });
    gated = true;
    const saving = store.save([]), deleting = store.deleteMarker(home);
    let drained = false; const waiting = drain().then(() => { drained = true; });
    await Promise.all([writeEntered, deleteEntered]); assert.equal(drained, false);
    release(); await waiting; await Promise.all([saving, deleting]);
    assert.equal(drained, true); assert.equal(existsSync(join(home, '.dashboard-managed.json')), false);
});

test('decorateScanResult prunes detached entry when scan reports offline', async (t) => {
    const root = tmpRoot();
    const drain = capturePersistence(t);
    t.after(async () => { try { await drain(); } finally { rmSync(root, { recursive: true, force: true }); } });
    const home = join(root, '.cli-jaw-3458');
    await plantPersistedEntry(root, 3458, 99040, 'm'.repeat(32), home);
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify({
            isPidAlive: () => true,
            resolveListeningPid: async () => 99040,
        }),
    });
    await manager.hydrate();
    const result = manager.decorateScanResult({
        manager: { port: MGR, rangeFrom: 3457, rangeTo: 3460, checkedAt: '', proxy: { enabled: false, basePath: '/i', allowedFrom: 3457, allowedTo: 3460 } },
        instances: [makeOffline(3458)],
    });
    assert.equal(result.instances[0]?.lifecycle?.owner, 'none');
    assert.equal(result.instances[0]?.lifecycle?.canStart, true);
});

test('concurrent start(port) calls only spawn one child (per-port lock)', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, '.cli-jaw-3457');
    let spawnCount = 0;
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify({ isPortOccupied: async () => false }),
        spawnImpl: (() => {
            spawnCount += 1;
            return new FakeChild(99050 + spawnCount);
        }) as never,
    });

    const [a, b] = await Promise.all([manager.start(3457, home), manager.start(3457, home)]);
    assert.equal(spawnCount, 1);
    assert.equal(a.ok && !b.ok || !a.ok && b.ok, true); // exactly one wins
});

test('two managers on different managerPorts use independent registry paths', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const a = new LifecycleStore({ managerPort: 24576, storageRoot: root });
    const b = new LifecycleStore({ managerPort: 24577, storageRoot: root });
    assert.notEqual(a.path(), b.path());
    await a.save([
        {
            schemaVersion: 1, managerPort: 24576, port: 3457, pid: 1, home: '/h',
            startedAt: '', command: [], token: 't',
        },
    ]);
    assert.deepEqual((await b.load()).entries, []);
});

test('corrupt registry JSON does not throw on hydrate', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    await store.save([]); // ensure dir exists
    writeFileSync(store.path(), '{not json}');
    const manager = new DashboardLifecycleManager({
        managerPort: MGR, from: 3457, count: 4, jawPath: '/jaw',
        homeRoot: root, storageRoot: root,
        processVerify: fakeVerify(),
    });
    const { adopted, pruned } = await manager.hydrate();
    assert.equal(adopted, 0);
    assert.equal(pruned, 0);
});
