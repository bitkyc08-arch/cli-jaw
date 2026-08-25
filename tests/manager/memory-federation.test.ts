import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { searchFederated, searchFederatedEnvelope } from '../../src/manager/memory/federation.ts';
import { searchChatFederated } from '../../src/manager/memory/chat-federation.ts';
import type { InstanceMemoryRef } from '../../src/manager/memory/types.ts';

function freshTmp(): string {
    return mkdtempSync(join(tmpdir(), 'jaw-fed-'));
}

function createIndexDb(dbPath: string, opts: { withSynonyms?: boolean; withTrigram?: boolean } = {}): void {
    mkdirSync(join(dbPath, '..'), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.pragma('journal_mode = WAL');
        db.exec(`
            CREATE TABLE chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL,
                relpath TEXT NOT NULL,
                kind TEXT NOT NULL,
                home_id TEXT NOT NULL DEFAULT '',
                source_start_line INTEGER NOT NULL,
                source_end_line INTEGER NOT NULL,
                source_hash TEXT NOT NULL,
                content TEXT NOT NULL,
                content_hash TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT ''
            );
            CREATE VIRTUAL TABLE chunks_fts USING fts5(
                content, relpath UNINDEXED, kind UNINDEXED, tokenize='unicode61'
            );
        `);
        if (opts.withTrigram) {
            db.exec(`CREATE VIRTUAL TABLE chunks_trigram USING fts5(
                chunk_id UNINDEXED, relpath UNINDEXED, body, tokenize='trigram'
            );`);
        }
        if (opts.withSynonyms) {
            db.exec(`CREATE TABLE memory_synonyms (
                term TEXT NOT NULL,
                synonym TEXT NOT NULL,
                weight REAL NOT NULL DEFAULT 1.0
            );`);
        }
        const insertChunk = db.prepare(
            `INSERT INTO chunks (path, relpath, kind, source_start_line, source_end_line, source_hash, content) VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, content, relpath, kind) VALUES (?, ?, ?, ?)');
        const info = insertChunk.run(dbPath, 'shared/test.md', 'shared', 1, 2, 'h1', 'federation testing content');
        insertFts.run(Number(info.lastInsertRowid), 'federation testing content', 'shared/test.md', 'shared');
    } finally {
        db.close();
    }
}

function createChatDb(
    dbPath: string,
    rows: Array<{ content: string; session?: string; createdAt?: string }> = [],
    withSessionId = true,
): void {
    mkdirSync(join(dbPath, '..'), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            cli TEXT,
            tool_log TEXT,
            created_at TEXT NOT NULL
            ${withSessionId ? ', session_id TEXT' : ''}
        )`);
        const columns = withSessionId
            ? '(role, content, cli, tool_log, created_at, session_id)'
            : '(role, content, cli, tool_log, created_at)';
        const placeholders = withSessionId ? '(?, ?, ?, ?, ?, ?)' : '(?, ?, ?, ?, ?)';
        const insert = db.prepare(`INSERT INTO messages ${columns} VALUES ${placeholders}`);
        rows.forEach((row, index) => {
            const values: unknown[] = [
                'user', row.content, 'codex', null,
                row.createdAt ?? `2026-08-05T00:00:${String(index).padStart(2, '0')}.000Z`,
            ];
            if (withSessionId) values.push(row.session ?? 'session-default');
            insert.run(...values);
        });
    } finally {
        db.close();
    }
}

function makeRef(id: string, homePath: string, hasDb = true, origin: 'registry' | 'scan' = 'scan'): InstanceMemoryRef {
    return {
        instanceId: id,
        homePath,
        homeSource: 'default-port',
        port: Number(id),
        label: null,
        dbPath: join(homePath, 'memory', 'structured', 'index.sqlite'),
        hasDb,
        chatDbPath: join(homePath, 'jaw.db'),
        hasChatDb: false,
        origin,
    };
}

function makeChatRef(id: string, homePath: string, hasChatDb = true): InstanceMemoryRef {
    return { ...makeRef(id, homePath, false), hasChatDb };
}

test('federation: returns hits from full-schema instances', () => {
    const base = freshTmp();
    const home = join(base, '.cli-jaw-3457');
    createIndexDb(join(home, 'memory', 'structured', 'index.sqlite'), { withSynonyms: true, withTrigram: true });
    const ref = makeRef('3457', home);
    const result = searchFederated('federation', { instances: [ref] });
    assert.equal(result.instancesQueried, 1);
    assert.equal(result.instancesSucceeded, 1);
    assert.equal(result.warnings.length, 0);
    assert.ok(result.hits.length > 0, 'should return at least one hit');
});

test('federation: hasDb=false → missing_db warning, still aggregates others', () => {
    const base = freshTmp();
    const home1 = join(base, '.cli-jaw-3457');
    createIndexDb(join(home1, 'memory', 'structured', 'index.sqlite'), { withSynonyms: true, withTrigram: true });
    const refOk = makeRef('3457', home1, true);
    const refMissing = makeRef('3458', join(base, '.cli-jaw-3458'), false);
    const result = searchFederated('federation', { instances: [refOk, refMissing] });
    assert.equal(result.instancesQueried, 2);
    assert.equal(result.instancesSucceeded, 1);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]!.code, 'missing_db');
    assert.ok(result.hits.length > 0);
});

test('federation: older schema (no synonyms, no trigram) → schema_mismatch warning, BM25 hits return', () => {
    const base = freshTmp();
    const home = join(base, '.cli-jaw-3457');
    createIndexDb(join(home, 'memory', 'structured', 'index.sqlite'), { withSynonyms: false, withTrigram: false });
    const ref = makeRef('3457', home);
    const result = searchFederated('federation', { instances: [ref] });
    assert.equal(result.instancesSucceeded, 1);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]!.code, 'schema_mismatch');
    assert.ok(result.warnings[0]!.detail?.degraded?.includes('memory_synonyms'));
    assert.ok(result.warnings[0]!.detail?.degraded?.includes('chunks_trigram'));
});

test('federation: empty query returns empty result with 0 queried', () => {
    const ref = makeRef('3457', '/tmp/never', true);
    const result = searchFederated('   ', { instances: [ref] });
    assert.equal(result.instancesQueried, 0);
    assert.equal(result.hits.length, 0);
});

test('federation: instanceFilter restricts to listed ids', () => {
    const base = freshTmp();
    const home1 = join(base, '.cli-jaw-3457');
    const home2 = join(base, '.cli-jaw-3458');
    createIndexDb(join(home1, 'memory', 'structured', 'index.sqlite'), { withSynonyms: true, withTrigram: true });
    createIndexDb(join(home2, 'memory', 'structured', 'index.sqlite'), { withSynonyms: true, withTrigram: true });
    const refs = [makeRef('3457', home1), makeRef('3458', home2)];
    const result = searchFederated('federation', { instances: refs, instanceFilter: ['3458'] });
    assert.equal(result.instancesQueried, 1);
});

test('federation: corrupt db produces structured warning, does not throw', () => {
    const base = freshTmp();
    const home = join(base, '.cli-jaw-3457');
    mkdirSync(join(home, 'memory', 'structured'), { recursive: true });
    writeFileSync(join(home, 'memory', 'structured', 'index.sqlite'), 'not a real sqlite db');
    const ref = makeRef('3457', home, true);
    const result = searchFederated('test', { instances: [ref] });
    assert.equal(result.instancesSucceeded, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(['corrupt', 'open_failed', 'query_failed'].includes(result.warnings[0]!.code));
});

test('FED-01/FED-03: enriched chat hits carry real session provenance and sessionFilter narrows', () => {
    const home = join(freshTmp(), '.cli-jaw-4101');
    createChatDb(join(home, 'jaw.db'), [
        { content: 'federated needle alpha', session: 'session-a' },
        { content: 'federated needle beta', session: 'session-b' },
    ]);
    const ref = makeChatRef('4101', home);

    const legacy = searchChatFederated('federated needle', { instances: [ref] });
    assert.deepEqual(Object.keys(legacy.hits[0]!).sort(), [
        'cli', 'content', 'created_at', 'id', 'instanceId', 'instanceLabel', 'match_field', 'role',
    ]);

    const all = searchFederatedEnvelope('federated needle', { instances: [ref] });
    assert.deepEqual(new Set(all.groups[0]!.hits.map(hit => hit.session)),
        new Set(['session-a', 'session-b']));
    assert.equal(all.groups[0]!.hits[0]!.provider, 'instance:4101:chat');

    const narrowed = searchFederatedEnvelope('federated needle', {
        instances: [ref],
        sessionFilter: 'session-a',
    });
    assert.deepEqual(narrowed.groups[0]!.hits.map(hit => hit.session), ['session-a']);
});

test('FED-02/FED-05: old chat peer succeeds without session and reports legacy_response', () => {
    const home = join(freshTmp(), '.cli-jaw-4102');
    createChatDb(join(home, 'jaw.db'), [{ content: 'legacy needle row' }], false);
    const result = searchFederatedEnvelope('legacy needle', { instances: [makeChatRef('4102', home)] });

    assert.equal(result.groups[0]!.hits.length, 1);
    assert.equal(result.groups[0]!.hits[0]!.session, undefined);
    assert.deepEqual(result.providers, [{ id: 'instance:4102:chat', corpus: 'chat', status: 'ready' }]);
    assert.ok(result.warnings.some(warning => warning.code === 'legacy_response' &&
        warning.provider === 'instance:4102:chat' && warning.message.includes('4102')));
});

test('FED-04/FED-08/FED-11: healthy and open-failed peers remain distinguishable', () => {
    const base = freshTmp();
    const home1 = join(base, '.cli-jaw-4201');
    const home2 = join(base, '.cli-jaw-4202');
    const missingHome = join(base, '.cli-jaw-4203');
    createChatDb(join(home1, 'jaw.db'), [{ content: 'fleet needle one', session: 'one' }]);
    createChatDb(join(home2, 'jaw.db'), [{ content: 'fleet needle two', session: 'two' }]);
    const result = searchFederatedEnvelope('fleet needle', {
        instances: [
            makeChatRef('4201', home1),
            makeChatRef('4202', home2),
            makeChatRef('4203', missingHome, true),
        ],
    });

    assert.equal(result.groups[0]!.hits.length, 2);
    // Inventory alone is not enough: both hits could carry the same provider id
    // and this would still pass. Pin each hit to the peer it came from.
    const byProvider = new Map(result.groups[0]!.hits.map(hit => [hit.provider, hit]));
    assert.deepEqual([...byProvider.keys()].sort(), ['instance:4201:chat', 'instance:4202:chat']);
    assert.match(byProvider.get('instance:4201:chat')!.snippet, /one/);
    assert.match(byProvider.get('instance:4202:chat')!.snippet, /two/);
    assert.equal(byProvider.get('instance:4201:chat')!.session, 'one');
    assert.equal(byProvider.get('instance:4202:chat')!.session, 'two');
    assert.deepEqual(result.providers, [
        { id: 'instance:4201:chat', corpus: 'chat', status: 'ready' },
        { id: 'instance:4202:chat', corpus: 'chat', status: 'ready' },
        { id: 'instance:4203:chat', corpus: 'chat', status: 'error' },
    ]);
    assert.ok(result.warnings.some(warning => warning.code === 'provider_failed' &&
        warning.provider === 'instance:4203:chat' && warning.message.includes('4203')));
});

test('FED-10: old peer with sessionFilter fails closed and names the unsupported instance', () => {
    const home = join(freshTmp(), '.cli-jaw-4301');
    createChatDb(join(home, 'jaw.db'), [{ content: 'closed needle row' }], false);
    const result = searchFederatedEnvelope('closed needle', {
        instances: [makeChatRef('4301', home)],
        sessionFilter: 'requested-session',
    });

    assert.equal(result.groups[0]!.hits.length, 0);
    assert.deepEqual(result.providers, [
        { id: 'instance:4301:chat', corpus: 'chat', status: 'error' },
    ]);
    assert.ok(result.warnings.some(warning => warning.code === 'legacy_response' &&
        warning.provider === 'instance:4301:chat' &&
        warning.message.includes('4301') &&
        warning.message.includes('session filtering unsupported')));
});

test('FED-13: a peer-local truncation keeps hasMore true when merged length equals limit', () => {
    const base = freshTmp();
    const fullHome = join(base, '.cli-jaw-4401');
    const emptyHome = join(base, '.cli-jaw-4402');
    createChatDb(join(fullHome, 'jaw.db'), Array.from({ length: 51 }, (_, index) => ({
        content: `capacity needle ${index}`,
        session: 'capacity-session',
        createdAt: `2026-08-05T00:${String(index).padStart(2, '0')}:00.000Z`,
    })));
    createChatDb(join(emptyHome, 'jaw.db'), [{ content: 'unrelated row', session: 'empty' }]);

    const result = searchFederatedEnvelope('capacity needle', {
        instances: [makeChatRef('4401', fullHome), makeChatRef('4402', emptyHome)],
        limit: 50,
    });
    assert.equal(result.groups[0]!.hits.length, 50);
    assert.equal(result.page.hasMore, true);
    assert.equal(result.page.nextCursor, null);
});

// ─── #436: which instances reach the federation list ────────────────────

test('a registry entry with no index does not warn; a live scanned one does', () => {
    const home = freshTmp();
    // Neither has an index.sqlite. The difference is why they are in the list.
    const declared = makeRef('3457', join(home, 'declared'), false, 'registry');
    const scanned = makeRef('3458', join(home, 'scanned'), false, 'scan');
    const res = searchFederated('anything', { instances: [declared, scanned] });
    const codes = res.warnings.map(w => w.instanceId + ':' + w.code);
    assert.deepEqual(codes, ['3458:missing_db'],
        'an offline operator-declared instance has no index to open — saying so every search is noise');
});
