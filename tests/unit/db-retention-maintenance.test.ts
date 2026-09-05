import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateOversizedToolLogs, readDatabaseStorageStats } from '../../src/core/db-maintenance.ts';
const traceCalls: Array<[number, number]> = [];
test.mock.module('../../src/trace/store.js', {
    namedExports: {
        pruneTraceEvents: (days: number, rows: number) => {
            traceCalls.push([days, rows]);
            return { deletedEvents: 0, deletedRuns: 0 };
        },
    },
});
const { startTraceRetention } = await import('../../src/trace/retention.ts');
test('DBR-001: oversized tool_log migration shrinks once and records its marker', () => {
    const database = new Database(':memory:');
    try {
        database.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, tool_log TEXT)');
        const raw = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ icon: 'tool', label: `tool-${i}`, detail: 'x'.repeat(1_000) })));
        database.prepare('INSERT INTO messages(tool_log) VALUES (?)').run(raw);
        assert.ok(raw.length > 64_000 && raw.length < 180_000);
        assert.equal(migrateOversizedToolLogs(database), 1);
        const first = database.prepare('SELECT tool_log FROM messages').pluck().get() as string;
        assert.ok(first.length <= 64_000);
        assert.ok(first.length < raw.length);
        assert.equal(migrateOversizedToolLogs(database), 0);
        assert.equal(database.prepare('SELECT tool_log FROM messages').pluck().get(), first);
        assert.equal(database.prepare('SELECT count(*) FROM schema_migrations').pluck().get(), 1);
    } finally {
        database.close();
    }
});
test('DBR-002a: trace retention owner prunes immediately and again after 6h', (t) => {
    traceCalls.length = 0;
    t.mock.timers.enable({ apis: ['setInterval'] });
    const handle = startTraceRetention({ retentionDays: 3, maxRows: 123 });
    try {
        assert.deepEqual(traceCalls, [[3, 123]]);
        t.mock.timers.tick(6 * 60 * 60 * 1_000);
        assert.deepEqual(traceCalls, [[3, 123], [3, 123]]);
    } finally {
        handle.stop();
    }
});
test('DBR-002b: stop() ends the sweep — no prune after a further 6h, and stop is idempotent', (t) => {
    traceCalls.length = 0;
    t.mock.timers.enable({ apis: ['setInterval'] });
    const handle = startTraceRetention({ retentionDays: 3, maxRows: 123 });
    assert.equal(handle.stopped, false);
    handle.stop();
    handle.stop();
    assert.equal(handle.stopped, true);
    t.mock.timers.tick(12 * 60 * 60 * 1_000);
    assert.deepEqual(traceCalls, [[3, 123]], 'only the boot prune ran; the interval was cleared by stop()');
});
test('DBR-002c: server.ts shutdown(sig) owns the production stop() call', () => {
    // server.ts cannot be imported in a unit test (it listens on boot), so the
    // wiring is pinned at the source level: the handle created at boot is the one
    // stopped inside shutdown(sig). Behaviour of stop() itself is DBR-002b.
    const serverSource = readFileSync(join(import.meta.dirname, '..', '..', 'server.ts'), 'utf8');
    assert.match(serverSource, /const traceRetention = startTraceRetention\(settings\["trace"\]\);/);
    const shutdownStart = serverSource.indexOf('const shutdown = async (sig: string) => {');
    const signalHooksStart = serverSource.indexOf("process.once('SIGTERM'", shutdownStart);
    assert.ok(shutdownStart >= 0 && signalHooksStart > shutdownStart, 'shutdown(sig) hook must exist');
    assert.match(serverSource.slice(shutdownStart, signalHooksStart), /traceRetention\.stop\(\);/);
});
test('DBR-003: jaw db maintain reports before/after and reclaims free pages', () => {
    const repoRoot = join(import.meta.dirname, '..', '..');
    const cliEntry = join(repoRoot, 'bin', 'cli-jaw.ts');
    const home = mkdtempSync(join(tmpdir(), 'jaw-db-maintain-'));
    const database = new Database(join(home, 'jaw.db'));
    try {
        database.exec('CREATE TABLE payloads (id INTEGER PRIMARY KEY, body TEXT)');
        const insert = database.prepare('INSERT INTO payloads(body) VALUES (?)');
        database.transaction(() => {
            for (let i = 0; i < 300; i++) insert.run('x'.repeat(4_000));
        })();
        database.exec('DELETE FROM payloads');
        assert.ok(readDatabaseStorageStats(database).freelistCount > 0);
    } finally {
        database.close();
    }
    try {
        assert.ok(existsSync(cliEntry));
        const run = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, '--home', home, 'db', 'maintain'],
            { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
        assert.equal(run.status, 0, run.stderr || run.stdout);
        assert.match(run.stdout, /before: page_count=\d+ freelist_count=\d+/);
        assert.match(run.stdout, /after: page_count=\d+ freelist_count=0/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
