import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardLifecycleManager } from '../../src/manager/lifecycle.js';
import { LifecycleStore, type PersistedEntry } from '../../src/manager/lifecycle-store.js';
import type { ProcessVerifyImpl } from '../../src/manager/process-verify.js';

const MGR = 24576;

function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), 'jaw-lifecycle-home-test-'));
}

function makeEntry(port: number, home: string, pid: number, token: string): PersistedEntry {
    return {
        schemaVersion: 1,
        managerPort: MGR,
        port,
        pid,
        home,
        startedAt: '2026-04-30T00:00:00.000Z',
        command: ['/jaw', '--home', home, 'serve', '--port', String(port), '--no-open'],
        token,
    };
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

async function writeMarker(store: LifecycleStore, entry: PersistedEntry): Promise<void> {
    await store.writeMarker(entry.home, {
        schemaVersion: 1,
        managedBy: 'cli-jaw-dashboard',
        managerPort: MGR,
        port: entry.port,
        pid: entry.pid,
        token: entry.token,
        startedAt: entry.startedAt,
    });
}

function writeLegacyRegistry(root: string, entries: PersistedEntry[]): string {
    const dir = join(root, `.cli-jaw-manager-${MGR}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'dashboard-managed.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, managerPort: MGR, entries }, null, 2));
    return path;
}

test('default store path uses CLI_JAW_DASHBOARD_HOME lifecycle path', (t) => {
    const root = tmpRoot();
    const previous = process.env.CLI_JAW_DASHBOARD_HOME;
    t.after(() => {
        if (previous === undefined) delete process.env.CLI_JAW_DASHBOARD_HOME;
        else process.env.CLI_JAW_DASHBOARD_HOME = previous;
        rmSync(root, { recursive: true, force: true });
    });
    process.env.CLI_JAW_DASHBOARD_HOME = root;
    const store = new LifecycleStore({ managerPort: MGR });
    assert.equal(store.path(), join(root, 'lifecycle', 'managers', String(MGR), 'dashboard-managed.json'));
});

test('legacy registry is read when new dashboard path is missing', async (t) => {
    const dashboardHome = tmpRoot();
    const legacyRoot = tmpRoot();
    t.after(() => {
        rmSync(dashboardHome, { recursive: true, force: true });
        rmSync(legacyRoot, { recursive: true, force: true });
    });
    const entry = makeEntry(3457, join(dashboardHome, 'home-3457'), 99001, 'a'.repeat(32));
    const legacyPath = writeLegacyRegistry(legacyRoot, [entry]);
    const store = new LifecycleStore({ managerPort: MGR, dashboardHome, legacyStorageRoot: legacyRoot });
    const loaded = await store.load();
    assert.equal(loaded.source, 'legacy');
    assert.equal(loaded.sourcePath, legacyPath);
    assert.equal(loaded.entries[0]?.port, 3457);
});

test('new dashboard path wins when both current and legacy registries exist', async (t) => {
    const dashboardHome = tmpRoot();
    const legacyRoot = tmpRoot();
    t.after(() => {
        rmSync(dashboardHome, { recursive: true, force: true });
        rmSync(legacyRoot, { recursive: true, force: true });
    });
    writeLegacyRegistry(legacyRoot, [makeEntry(3457, join(dashboardHome, 'legacy-home'), 99001, 'b'.repeat(32))]);
    const store = new LifecycleStore({ managerPort: MGR, dashboardHome, legacyStorageRoot: legacyRoot });
    await store.save([makeEntry(3458, join(dashboardHome, 'current-home'), 99002, 'c'.repeat(32))]);
    const loaded = await store.load();
    assert.equal(loaded.source, 'current');
    assert.equal(loaded.entries[0]?.port, 3458);
});

test('corrupt legacy registry returns corrupt source without throwing', async (t) => {
    const dashboardHome = tmpRoot();
    const legacyRoot = tmpRoot();
    t.after(() => {
        rmSync(dashboardHome, { recursive: true, force: true });
        rmSync(legacyRoot, { recursive: true, force: true });
    });
    const legacyPath = writeLegacyRegistry(legacyRoot, []);
    writeFileSync(legacyPath, '{not json');
    const store = new LifecycleStore({ managerPort: MGR, dashboardHome, legacyStorageRoot: legacyRoot });
    const loaded = await store.load();
    assert.equal(loaded.source, 'corrupt');
    assert.deepEqual(loaded.entries, []);
});

test('hydrate writes verified legacy survivors into new dashboard path', async (t) => {
    const dashboardHome = tmpRoot();
    const legacyRoot = tmpRoot();
    t.after(() => {
        rmSync(dashboardHome, { recursive: true, force: true });
        rmSync(legacyRoot, { recursive: true, force: true });
    });
    const home = join(dashboardHome, 'home-3458');
    const entry = makeEntry(3458, home, 99003, 'd'.repeat(32));
    writeLegacyRegistry(legacyRoot, [entry]);
    const store = new LifecycleStore({ managerPort: MGR, dashboardHome, legacyStorageRoot: legacyRoot });
    await writeMarker(store, entry);
    const manager = new DashboardLifecycleManager({
        managerPort: MGR,
        from: 3457,
        count: 4,
        jawPath: '/jaw',
        dashboardHome,
        legacyStorageRoot: legacyRoot,
        processVerify: fakeVerify({
            isPidAlive: (pid) => pid === 99003,
            resolveListeningPid: async (port) => (port === 3458 ? 99003 : null),
        }),
    });

    const result = await manager.hydrate();
    assert.deepEqual(result, { adopted: 1, pruned: 0 });
    assert.equal(existsSync(store.path()), true);
    const persisted = JSON.parse(readFileSync(store.path(), 'utf8')) as { entries: PersistedEntry[] };
    assert.equal(persisted.entries[0]?.port, 3458);
});
