import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    LifecycleStore,
    type HomeMarker,
    type PersistedEntry,
} from '../../src/manager/lifecycle-store.js';

function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), 'jaw-store-test-'));
}

const MGR = 24576;

function makeEntry(port = 3458, overrides: Partial<PersistedEntry> = {}): PersistedEntry {
    return {
        schemaVersion: 1,
        managerPort: MGR,
        port,
        pid: 12345,
        home: join(tmpdir(), `home-${port}`),
        startedAt: '2026-04-28T00:00:00.000Z',
        command: ['/jaw', '--home', `home-${port}`, 'serve'],
        token: 'abcd'.repeat(8),
        ...overrides,
    };
}

test('store load returns empty entries when registry file is missing', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    const result = await store.load();
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.managerPort, MGR);
    assert.deepEqual(result.entries, []);
    assert.equal(result.source, 'missing');
});

test('store save writes atomically and load round-trips', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    const entries = [makeEntry(3458), makeEntry(3459, { pid: 67890 })];
    await store.save(entries);

    const reload = await new LifecycleStore({ managerPort: MGR, storageRoot: root }).load();
    assert.equal(reload.source, 'current');
    assert.equal(reload.entries.length, 2);
    assert.equal(reload.entries[0]?.port, 3458);
    assert.equal(reload.entries[1]?.pid, 67890);
});

test('store load returns empty on schemaVersion mismatch', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    assert.equal(store.path(), join(root, 'lifecycle', 'managers', String(MGR), 'dashboard-managed.json'));
    await store.save([makeEntry()]);
    writeFileSync(store.path(), JSON.stringify({ schemaVersion: 99, managerPort: MGR, entries: [makeEntry()] }));
    const result = await store.load();
    assert.deepEqual(result.entries, []);
});

test('store load returns empty on managerPort mismatch', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    await store.save([makeEntry()]);
    writeFileSync(store.path(), JSON.stringify({ schemaVersion: 1, managerPort: 99999, entries: [makeEntry()] }));
    const result = await store.load();
    assert.deepEqual(result.entries, []);
});

test('store load returns empty on JSON parse error (no throw)', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    await store.save([]);
    writeFileSync(store.path(), '{not valid json');
    const result = await store.load();
    assert.deepEqual(result.entries, []);
    assert.equal(result.source, 'corrupt');
});

test('store writeMarker / readMarker round-trip', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    const home = join(root, 'home-3458');
    const marker: HomeMarker = {
        schemaVersion: 1,
        managedBy: 'cli-jaw-dashboard',
        managerPort: MGR,
        port: 3458,
        pid: 12345,
        token: 'tok-' + 'x'.repeat(28),
        startedAt: '2026-04-28T00:00:00.000Z',
    };
    await store.writeMarker(home, marker);
    const loaded = await store.readMarker(home);
    assert.deepEqual(loaded, marker);
});

test('store readMarker returns null when managedBy mismatches', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    const home = join(root, 'home-3458');
    await store.writeMarker(home, {
        schemaVersion: 1,
        managedBy: 'cli-jaw-dashboard',
        managerPort: MGR,
        port: 3458,
        pid: 1,
        token: 'tok-' + 'x'.repeat(28),
        startedAt: '',
    });
    writeFileSync(join(home, '.dashboard-managed.json'), JSON.stringify({
        schemaVersion: 1,
        managedBy: 'something-else',
        managerPort: MGR,
        port: 3458,
        pid: 1,
        token: 'tok',
        startedAt: '',
    }));
    const loaded = await store.readMarker(home);
    assert.equal(loaded, null);
});

test('store deleteMarker is idempotent', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    const home = join(root, 'home-3458');
    await store.deleteMarker(home);
    await store.writeMarker(home, {
        schemaVersion: 1,
        managedBy: 'cli-jaw-dashboard',
        managerPort: MGR,
        port: 3458,
        pid: 1,
        token: 'tok',
        startedAt: '',
    });
    await store.deleteMarker(home);
    await store.deleteMarker(home);
    assert.equal(await store.readMarker(home), null);
});

test('store save serializes concurrent writes', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new LifecycleStore({ managerPort: MGR, storageRoot: root });
    const writes = [
        store.save([makeEntry(3458)]),
        store.save([makeEntry(3458), makeEntry(3459)]),
        store.save([makeEntry(3458), makeEntry(3459), makeEntry(3460)]),
    ];
    await Promise.all(writes);
    const final = await store.load();
    assert.equal(final.entries.length, 3);
    assert.deepEqual(final.entries.map(e => e.port).sort(), [3458, 3459, 3460]);
});

test('store newToken returns 32-char hex', () => {
    const t1 = LifecycleStore.newToken();
    const t2 = LifecycleStore.newToken();
    assert.match(t1, /^[0-9a-f]{32}$/);
    assert.match(t2, /^[0-9a-f]{32}$/);
    assert.notEqual(t1, t2);
});
