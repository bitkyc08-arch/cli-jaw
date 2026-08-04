import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
    getIndexDb,
    reindexAll,
    reindexSingleFile,
    searchIndex,
    searchIndexForProvider,
} from '../../src/memory/indexing.ts';
import { getAdvancedIndexDbPath, getAdvancedMemoryDir } from '../../src/memory/shared.ts';
import type { ProviderStatus, SearchHit, SearchQuery } from '../../src/search/contract.ts';
import { SearchCoordinator } from '../../src/search/coordinator.ts';
import {
    createOffProvider,
    providerEnvelope,
    SearchProviderRegistry,
    type ProviderSearchOptions,
    type SearchProvider,
} from '../../src/search/provider.ts';
import { MemorySearchProvider } from '../../src/search/providers/memory.ts';

function resetMemory(): string {
    const root = getAdvancedMemoryDir();
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    return root;
}

function writeEpisode(root: string, body: string, name = '2026-08-05.md'): string {
    const file = join(root, 'episodes', 'live', name);
    mkdirSync(join(root, 'episodes', 'live'), { recursive: true });
    writeFileSync(file, body);
    return file;
}

function registryOf(...providers: SearchProvider[]): SearchProviderRegistry {
    const registry = new SearchProviderRegistry();
    for (const provider of providers) registry.register(provider);
    return registry;
}

class FilteringChatProvider implements SearchProvider {
    readonly id = 'local-chat';
    readonly corpus = 'chat' as const;

    constructor(private readonly rows: SearchHit[]) {}

    status(): ProviderStatus { return 'ready'; }

    async search(query: SearchQuery, opts: ProviderSearchOptions) {
        const rows = query.sessionFilter === undefined
            ? this.rows : this.rows.filter(row => row.session === query.sessionFilter);
        const selected = rows.slice(opts.offset, opts.offset + opts.limit);
        return providerEnvelope(this, query, selected, [], rows.length > opts.offset + selected.length);
    }
}

const chatHit = (key: string, session: string): SearchHit => ({
    corpus: 'chat',
    provider: 'local-chat',
    key,
    session,
    snippet: `chat-${key}`,
    ranking: { mode: 'bm25', sourceRank: Number(key) },
});

test('MEM-01/03/04: provider returns RRF memory hits with optional session provenance', async () => {
    const root = resetMemory();
    writeEpisode(root, [
        '## 10:00 · session:session-a',
        'providerneedle tagged memory',
        '',
        '## 10:01',
        'providerneedle legacy memory',
    ].join('\n'));
    reindexAll(root);

    const result = await new MemorySearchProvider().search(
        { query: 'providerneedle', corpus: 'memory' },
        { limit: 10, offset: 0 },
    );

    assert.equal(result.groups[0]?.ranking, 'rrf');
    assert.ok(result.groups[0]?.hits.every(hit => hit.provider === 'local-memory'));
    assert.deepEqual(result.groups[0]?.hits.map(hit => hit.session ?? '').sort(), ['', 'session-a']);
    assert.ok(result.groups[0]?.hits.every(hit => hit.ranking.mode === 'rrf'));
});

test('MEM-02: corpus=all returns chat and memory groups while only wiki is off', async () => {
    const root = resetMemory();
    writeEpisode(root, '## memory\nallcorpusneedle memory result');
    reindexAll(root);
    const coordinator = new SearchCoordinator(registryOf(
        new FilteringChatProvider([chatHit('1', 'chat-a')]),
        new MemorySearchProvider(),
        createOffProvider('wiki-placeholder', 'wiki'),
    ));

    const result = await coordinator.search({ query: 'allcorpusneedle', corpus: 'all', limit: 10 });

    assert.deepEqual(result.groups.map(group => group.corpus), ['chat', 'memory']);
    assert.deepEqual(result.providers.filter(provider => provider.status === 'off'), [{
        id: 'wiki-placeholder', corpus: 'wiki', status: 'off',
    }]);
    assert.deepEqual(result.warnings.filter(warning => warning.code === 'provider_off').map(w => w.provider),
        ['wiki-placeholder']);
});

test('MEM-05: sessionFilter narrows chat, not shared memory, and emits an explicit warning', async () => {
    const root = resetMemory();
    writeEpisode(root, [
        '## 10:00 · session:session-a',
        'sharedfilterneedle memory A',
        '## 10:01 · session:session-b',
        'sharedfilterneedle memory B',
    ].join('\n'));
    reindexAll(root);
    const coordinator = new SearchCoordinator(registryOf(
        new FilteringChatProvider([chatHit('1', 'session-a'), chatHit('2', 'session-b')]),
        new MemorySearchProvider(),
    ));

    const result = await coordinator.search({
        query: 'sharedfilterneedle', corpus: 'all', sessionFilter: 'session-a', limit: 10,
    });
    const chat = result.groups.find(group => group.corpus === 'chat');
    const memory = result.groups.find(group => group.corpus === 'memory');

    assert.deepEqual(chat?.hits.map(hit => hit.session), ['session-a']);
    assert.deepEqual(memory?.hits.map(hit => hit.session), ['session-a', 'session-b']);
    assert.ok(result.warnings.some(warning => warning.code === 'session_filter_ignored' &&
        warning.provider === 'local-memory'));
});

test('MEM-07/10: an old schema migrates, preserves untagged rows, and writes new session tags', async () => {
    const root = resetMemory();
    const initialized = getIndexDb();
    initialized.close();
    const old = new Database(getAdvancedIndexDbPath());
    old.exec('ALTER TABLE chunks DROP COLUMN session_id');
    const legacy = old.prepare(`
        INSERT INTO chunks(path, relpath, kind, home_id, source_start_line, source_end_line,
            source_hash, content, content_hash, created_at)
        VALUES (?, ?, ?, '', 1, 2, '', ?, '', '')
    `).run('/legacy.md', 'episodes/legacy.md', 'episode', 'oldschemaneedle legacy');
    old.prepare('INSERT INTO chunks_fts(rowid, content, relpath, kind) VALUES (?, ?, ?, ?)').run(
        legacy.lastInsertRowid, 'oldschemaneedle legacy', 'episodes/legacy.md', 'episode',
    );
    old.close();

    const taggedFile = writeEpisode(root,
        '## 10:00 · session:migrated-session\nnewtagneedle migrated write', '2026-08-06.md');
    assert.equal(reindexSingleFile(root, taggedFile), 1);

    const migrated = new Database(getAdvancedIndexDbPath());
    const columns = migrated.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
    const rows = migrated.prepare(`
        SELECT relpath, session_id FROM chunks
        WHERE relpath IN ('episodes/legacy.md', 'episodes/live/2026-08-06.md')
        ORDER BY relpath
    `).all();
    migrated.close();
    assert.ok(columns.some(column => column.name === 'session_id'));
    assert.deepEqual(rows, [
        { relpath: 'episodes/legacy.md', session_id: '' },
        { relpath: 'episodes/live/2026-08-06.md', session_id: 'migrated-session' },
    ]);
    assert.equal(searchIndexForProvider('oldschemaneedle', { limit: 5, offset: 0 }).hits[0]?.sessionId, '');
    assert.equal(searchIndexForProvider('newtagneedle', { limit: 5, offset: 0 }).hits[0]?.sessionId,
        'migrated-session');
});

test('session migration serializes concurrent opens and retries after a busy ALTER', async () => {
    resetMemory();
    const initialized = getIndexDb();
    initialized.close();
    const old = new Database(getAdvancedIndexDbPath());
    old.exec('ALTER TABLE chunks DROP COLUMN session_id');
    old.close();

    const locker = spawn(process.execPath, ['--input-type=module', '-e', `
        import Database from 'better-sqlite3';
        const db = new Database(${JSON.stringify(getAdvancedIndexDbPath())});
        db.exec('BEGIN IMMEDIATE');
        process.stdout.write('locked\\n');
        setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 4200);
    `], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
        let output = '';
        locker.stdout.on('data', chunk => {
            output += String(chunk);
            if (output.includes('locked\n')) resolve();
        });
        locker.once('error', reject);
        locker.once('exit', code => {
            if (!output.includes('locked\n')) reject(new Error(`locker exited before lock: ${code}`));
        });
    });

    const busyOpen = getIndexDb();
    assert.equal((busyOpen.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>)
        .some(column => column.name === 'session_id'), false, 'busy migration must use legacy statements');
    busyOpen.close();
    await new Promise<void>((resolve, reject) => {
        locker.once('exit', code => code === 0 ? resolve() : reject(new Error(`locker exit ${code}`)));
        locker.once('error', reject);
    });

    const retried = getIndexDb();
    assert.equal((retried.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>)
        .filter(column => column.name === 'session_id').length, 1);
    retried.close();
});

test('legacy search keeps its exact top-eight order and public hit shape', () => {
    const root = resetMemory();
    const dir = join(root, 'semantic');
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 24; index++) {
        writeFileSync(join(dir, `${String(index).padStart(2, '0')}.md`),
            `## item ${index}\nlegacytopneedle shared text ${index}`);
    }
    reindexAll(root);

    const hits = searchIndex('legacytopneedle').hits;
    assert.deepEqual(hits.map(hit => `${hit.relpath}:${hit.source_start_line}:${hit.source_end_line}`),
        Array.from({ length: 8 }, (_, index) => `semantic/${String(index).padStart(2, '0')}.md:1:2`));
    assert.ok(hits.every(hit => !Object.hasOwn(hit, 'sessionId')));
});

test('MEM-14: BM25, trigram, and LIKE paginate one fixed candidate universe', async () => {
    const root = resetMemory();
    const chunks = Array.from({ length: 40 }, (_, index) =>
        `## item ${String(index).padStart(2, '0')}\nax 가나다 한글 candidate ${index}`);
    writeEpisode(root, chunks.join('\n'));
    reindexAll(root);
    const provider = new MemorySearchProvider();

    for (const { label, query, oldLimit } of [
        { label: 'BM25', query: 'ax', oldLimit: 16 },
        { label: 'trigram', query: '가나다', oldLimit: 15 },
        { label: 'LIKE', query: '한글', oldLimit: 15 },
    ]) {
        const first = await provider.search({ query, corpus: 'memory' }, { limit: oldLimit, offset: 0 });
        const second = await provider.search(
            { query, corpus: 'memory' }, { limit: oldLimit, offset: oldLimit },
        );
        const large = await provider.search({ query, corpus: 'memory' }, { limit: 64, offset: 0 });
        const firstHits = first.groups[0]?.hits ?? [];
        const secondHits = second.groups[0]?.hits ?? [];
        const largeHits = large.groups[0]?.hits ?? [];
        const keys = (hits: SearchHit[]) => hits.map(hit => hit.key);

        assert.ok(largeHits.length > oldLimit, `${label} exceeds its legacy upstream limit`);
        assert.ok(secondHits.length > 0, `${label} has a second page`);
        assert.equal(first.page.hasMore, true, `${label} page one reports more bounded hits`);
        assert.equal(new Set([...keys(firstHits), ...keys(secondHits)]).size,
            firstHits.length + secondHits.length, `${label} pages do not overlap`);
        assert.deepEqual([...keys(firstHits), ...keys(secondHits)],
            keys(largeHits).slice(0, firstHits.length + secondHits.length),
            `${label} page concatenation matches the fixed-universe order`);
    }
});
