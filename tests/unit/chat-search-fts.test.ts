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
