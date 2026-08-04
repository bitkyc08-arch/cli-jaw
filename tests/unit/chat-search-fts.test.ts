import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ChatSearchProvider } from '../../src/search/providers/chat.ts';
import { db, migrateSearchFts } from '../../src/core/db.ts';
import type { SearchQuery } from '../../src/search/contract.ts';

function query(text: string, sessionFilter?: string): SearchQuery {
    return {
        query: text,
        corpus: 'chat',
        ...(sessionFilter !== undefined ? { sessionFilter } : {}),
    };
}

function countMatch(database: Database.Database, table: 'messages_fts' | 'messages_trigram', match: string): number {
    const row = database.prepare(
        `SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`,
    ).get(`"${match}"`) as { count: number };
    return row.count;
}

test('chat FTS migration and provider regressions', async t => {
    await t.test('pre-migration rows rebuild, rank=1 integrity, and triggers stay synchronized', () => {
        const home = mkdtempSync(join(tmpdir(), 'jaw-chat-fts-migration-'));
        const path = join(home, 'messages.db');
        const fixture = new Database(path);
        try {
            fixture.exec(`
                CREATE TABLE messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    cli TEXT,
                    tool_log TEXT DEFAULT NULL,
                    session_id TEXT DEFAULT 'default',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO messages(role, content, session_id)
                VALUES('user', 'preexisting rebuild sentinel', 's-before');
            `);

            assert.equal(migrateSearchFts(fixture), true);
            assert.equal(countMatch(fixture, 'messages_fts', 'preexisting rebuild sentinel'), 1);
            fixture.prepare(
                "INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)",
            ).run();
            fixture.prepare(
                "INSERT INTO messages_trigram(messages_trigram, rank) VALUES('integrity-check', 1)",
            ).run();

            const inserted = fixture.prepare(
                "INSERT INTO messages(role, content, session_id) VALUES('user', 'trigger alpha 한국어', 'sync')",
            ).run();
            const id = Number(inserted.lastInsertRowid);
            assert.equal(countMatch(fixture, 'messages_fts', 'trigger alpha'), 1);
            assert.equal(countMatch(fixture, 'messages_trigram', '한국어'), 1);

            fixture.prepare("UPDATE messages SET content='updated needle 멀티세션아키텍처' WHERE id=?").run(id);
            assert.equal(countMatch(fixture, 'messages_fts', 'trigger alpha'), 0);
            assert.equal(countMatch(fixture, 'messages_fts', 'updated needle'), 1);
            assert.equal(countMatch(fixture, 'messages_trigram', '세션아'), 1);

            fixture.prepare('DELETE FROM messages WHERE id=?').run(id);
            assert.equal(countMatch(fixture, 'messages_fts', 'updated needle'), 0);
            assert.equal(countMatch(fixture, 'messages_trigram', '세션아'), 0);
            fixture.prepare(
                "INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)",
            ).run();
            fixture.prepare(
                "INSERT INTO messages_trigram(messages_trigram, rank) VALUES('integrity-check', 1)",
            ).run();
        } finally {
            fixture.close();
            rmSync(home, { recursive: true, force: true });
        }
    });

    await t.test('provider uses trigram and corrected CJK LIKE fallbacks', async () => {
        const provider = new ChatSearchProvider('fts5');
        db.prepare(`
            INSERT INTO messages(role, content, session_id)
            VALUES('user', '한국어 검색 테스트 멀티세션아키텍처', 'fts-cjk')
        `).run();

        const trigram = await provider.search(query('한국어'), { limit: 10, offset: 0 });
        assert.equal(trigram.groups[0]?.hits.length, 1);
        assert.equal(trigram.groups[0]?.ranking, 'trigram');

        const spaced = await provider.search(query('검색 테'), { limit: 10, offset: 0 });
        assert.equal(spaced.groups[0]?.hits.length, 1);
        assert.equal(spaced.groups[0]?.ranking, 'like');

        const short = await provider.search(query('한국'), { limit: 10, offset: 0 });
        assert.equal(short.groups[0]?.hits.length, 1);
        assert.equal(short.groups[0]?.ranking, 'like');
    });

    await t.test('provider defaults across sessions, narrows by actual session, and paginates', async () => {
        const provider = new ChatSearchProvider('fts5');
        const insert = db.prepare('INSERT INTO messages(role, content, session_id) VALUES(?, ?, ?)');
        insert.run('user', 'crosssessionneedle first', 'fts-session-a');
        insert.run('assistant', 'crosssessionneedle second', 'fts-session-b');
        insert.run('user', 'crosssessionneedle third', 'fts-session-b');

        const all = await provider.search(query('crosssessionneedle'), { limit: 10, offset: 0 });
        assert.deepEqual(new Set(all.groups[0]?.hits.map(hit => hit.session)),
            new Set(['fts-session-a', 'fts-session-b']));
        assert.ok(all.groups[0]?.hits.every(hit => hit.ranking.mode === 'bm25'));

        const first = await provider.search(query('crosssessionneedle'), { limit: 2, offset: 0 });
        assert.equal(first.groups[0]?.hits.length, 2);
        assert.equal(first.page.hasMore, true);

        const next = await provider.search(query('crosssessionneedle'), { limit: 2, offset: 2 });
        assert.equal(next.groups[0]?.hits.length, 1);
        assert.equal(next.page.hasMore, false);

        const narrowed = await provider.search(query('crosssessionneedle', 'fts-session-a'),
            { limit: 10, offset: 0 });
        assert.deepEqual(narrowed.groups[0]?.hits.map(hit => hit.session), ['fts-session-a']);
    });

    await t.test('unavailable FTS emits engine_fallback and returns LIKE hits', async () => {
        const provider = new ChatSearchProvider('fts5');
        db.prepare(`
            INSERT INTO messages(role, content, session_id)
            VALUES('user', 'fallbackneedle remains searchable', 'fts-fallback')
        `).run();
        db.exec('DROP TABLE messages_fts');

        const result = await provider.search(query('fallbackneedle'), { limit: 10, offset: 0 });
        assert.equal(result.groups[0]?.ranking, 'like');
        assert.deepEqual(result.groups[0]?.hits.map(hit => hit.session), ['fts-fallback']);
        assert.ok(result.warnings.some(warning => warning.code === 'engine_fallback'));
    });
});

// Tables alone are not a usable index. An interrupted upgrade, a restored dump,
// or a manual DROP can leave the virtual tables in place while a sync trigger
// is gone — after which new messages never reach the index and search silently
// returns stale results. The probe must look at the whole schema.
test('migration repairs an index whose triggers were dropped', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-chat-fts-repair-'));
    const path = join(home, 'messages.db');
    try {
        const database = new Database(path);
        database.exec(`CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, cli TEXT,
            model TEXT, trace TEXT, tool_log TEXT, working_dir TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP, session_id TEXT DEFAULT 'default')`);
        database.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', ?, 's1')")
            .run('alpha needle');

        assert.equal(migrateSearchFts(database), true, 'first migration succeeds');

        // Simulate the damaged state: tables survive, one trigger does not.
        database.exec('DROP TRIGGER messages_search_ai');
        const triggersAfterDrop = database.prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'messages_search_%'",
        ).get() as { n: number };
        assert.equal(triggersAfterDrop.n, 2, 'precondition: one trigger is missing');

        assert.equal(migrateSearchFts(database), true, 'second migration must repair rather than early-return');

        const triggersAfterRepair = database.prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'messages_search_%'",
        ).get() as { n: number };
        assert.equal(triggersAfterRepair.n, 3, 'all sync triggers must be restored');

        // The real proof: a message inserted after the repair is searchable.
        database.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', ?, 's1')")
            .run('beta needle');
        assert.equal(countMatch(database, 'messages_fts', 'beta'), 1,
            'post-repair inserts must reach the index');
        database.close();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

// LIKE is the fallback path for short and whitespace-containing queries, so a
// broken escape would make literal %, _, and backslash unsearchable.
test('LIKE fallback escapes wildcard characters literally', () => {
    const provider = new ChatSearchProvider();
    // The shared test DB may not have run the migration yet; the LIKE path
    // still needs the statements prepared against a complete schema.
    migrateSearchFts(db);
    const insert = db.prepare(
        "INSERT INTO messages (role, content, cli, working_dir, session_id) VALUES ('user', ?, 'web', NULL, ?)");
    insert.run('discount 50% off today', 'esc-1');
    insert.run('discount 5000 off today', 'esc-2');
    insert.run('file_name pattern', 'esc-3');
    insert.run('fileXname pattern', 'esc-4');

    return (async () => {
        const percent = await provider.search(query('50% off'), { limit: 20, offset: 0 });
        const percentSessions = percent.groups.flatMap(group => group.hits).map(h => h.session);
        assert.ok(percentSessions.includes('esc-1'), 'the literal percent row must match');
        assert.ok(!percentSessions.includes('esc-2'), '% must not act as a wildcard');

        const underscore = await provider.search(query('file_name'), { limit: 20, offset: 0 });
        const underscoreSessions = underscore.groups.flatMap(group => group.hits).map(h => h.session);
        assert.ok(underscoreSessions.includes('esc-3'), 'the literal underscore row must match');
        assert.ok(!underscoreSessions.includes('esc-4'), '_ must not act as a single-char wildcard');
    })();
});
