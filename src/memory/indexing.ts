import fs from 'fs';
import Database from 'better-sqlite3';
import { join, relative } from 'path';
import { instanceId } from '../core/instance.js';
import {
    type SearchHit,
    type ParsedMarkdown,
    getAdvancedMemoryDir,
    getAdvancedIndexDbPath,
    ensureDir,
    safeReadFile,
    hashText,
    listMarkdownFiles,
} from './shared.js';
import { expandSynonyms, initSynonymsTable } from './synonyms.js';

function parseMarkdownFile(raw: string): ParsedMarkdown {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '---') {
        return { meta: {}, body: raw, bodyStartLine: 1 };
    }
    const closing = lines.findIndex((line, idx) => idx > 0 && line === '---');
    if (closing === -1) {
        return { meta: {}, body: raw, bodyStartLine: 1 };
    }
    const meta: Record<string, string> = {};
    for (const line of lines.slice(1, closing)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key) meta[key] = value;
    }
    return {
        meta,
        body: lines.slice(closing + 1).join('\n'),
        bodyStartLine: closing + 2,
    };
}

function buildHeaderPath(stack: string[]) {
    return stack.filter(Boolean).join(' > ');
}

function sessionIdFromHeadings(headings: string[]): string {
    const sessionHeading = headings[1] ?? '';
    return /(?:^|\s)·\s*session:([^\s]+)\s*$/.exec(sessionHeading)?.[1] ?? '';
}

interface MemoryChunk {
    relpath: string;
    path: string;
    kind: string;
    sessionId: string;
    source_start_line: number;
    source_end_line: number;
    source_hash: string;
    content: string;
}

function chunkMarkdown(absPath: string, relpath: string, kind: string) {
    const raw = safeReadFile(absPath);
    const parsed = parseMarkdownFile(raw);
    const lines = parsed.body.split('\n');
    const chunks: MemoryChunk[] = [];

    const headings: string[] = [];
    let currentStart = parsed.bodyStartLine;
    let currentBody: string[] = [];
    let currentHeader = '';

    const flush = (endLine: number) => {
        const body = currentBody.join('\n').trim();
        if (!body) return;
        const headerPath = buildHeaderPath(headings);
        const prefix = [
            `Source: ${relpath}`,
            `Kind: ${kind}`,
            headerPath ? `Header: ${headerPath}` : '',
        ].filter(Boolean).join('\n');
        const content = `${prefix}\n\n${body}`.trim();
        chunks.push({
            relpath,
            path: absPath,
            kind,
            sessionId: sessionIdFromHeadings(headings),
            source_start_line: currentStart,
            source_end_line: endLine,
            source_hash: hashText(`${relpath}:${currentStart}:${body}`),
            content,
        });
    };

    for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx] ?? '';
        const actualLine = parsed.bodyStartLine + idx;
        const headerMatch = /^(#{1,3})\s+(.+)$/.exec(line.trim());
        if (headerMatch) {
            flush(actualLine - 1);
            const level = headerMatch[1]?.length || 1;
            headings[level - 1] = headerMatch[2]?.trim() || '';
            headings.length = level;
            currentHeader = headerMatch[2]?.trim() || '';
            currentStart = actualLine;
            currentBody = [line];
            continue;
        }
        if (!currentBody.length) {
            currentStart = actualLine;
            currentBody = currentHeader ? [currentHeader, line] : [line];
        } else {
            currentBody.push(line);
        }
    }
    flush(parsed.bodyStartLine + lines.length - 1);

    if (chunks.length === 0 && parsed.body.trim()) {
        chunks.push({
            relpath,
            path: absPath,
            kind,
            sessionId: '',
            source_start_line: parsed.bodyStartLine,
            source_end_line: parsed.bodyStartLine + lines.length - 1,
            source_hash: hashText(`${relpath}:${parsed.body}`),
            content: parsed.body.trim(),
        });
    }
    return chunks;
}

function probeChunkColumns(db: Database.Database): Set<string> {
    return new Set(
        (db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map(row => row.name),
    );
}

function migrateSessionColumn(db: Database.Database): void {
    if (probeChunkColumns(db).has('session_id')) return;
    let began = false;
    try {
        db.exec('BEGIN IMMEDIATE');
        began = true;
        if (!probeChunkColumns(db).has('session_id')) {
            db.exec("ALTER TABLE chunks ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
        }
        db.exec('COMMIT');
    } catch (error) {
        if (began && db.inTransaction) {
            try { db.exec('ROLLBACK'); } catch { /* connection cleanup owns any remaining failure */ }
        }
        console.warn('[memory:index] session_id migration deferred:',
            error instanceof Error ? error.message : String(error));
    }
    // The post-migration probe is authoritative. Callers probe again before
    // preparing statements, so a failed ALTER remains fully legacy-compatible.
    probeChunkColumns(db);
}

export function getIndexDb() {
    ensureDir(getAdvancedMemoryDir());
    const db = new Database(getAdvancedIndexDbPath());
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 3000');
        db.exec(`
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL,
                relpath TEXT NOT NULL,
                kind TEXT NOT NULL,
                home_id TEXT NOT NULL DEFAULT '',
                session_id TEXT NOT NULL DEFAULT '',
                source_start_line INTEGER NOT NULL,
                source_end_line INTEGER NOT NULL,
                source_hash TEXT NOT NULL,
                content TEXT NOT NULL,
                content_hash TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_relpath ON chunks(relpath);
            CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                content,
                relpath UNINDEXED,
                kind UNINDEXED,
                tokenize = 'unicode61'
            );
        `);
        migrateSessionColumn(db);
        ensureTrigramIndex(db);
        initSynonymsTable(db);
        return db;
    } catch (err) {
        db.close();
        throw err;
    }
}

export function ensureTrigramIndex(db: Database.Database): void {
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
            chunk_id UNINDEXED,
            relpath UNINDEXED,
            body,
            tokenize = 'trigram'
        );
    `);
}

interface ChunkRow {
    path: string;
    relpath: string;
    kind: string;
    source_start_line: number;
    source_end_line: number;
    content: string;
    sessionId?: string;
    score?: number;
}

function prepareChunkInsert(db: Database.Database, sessionAware: boolean) {
    const statement = db.prepare(sessionAware ? `
        INSERT INTO chunks (path, relpath, kind, home_id, session_id, source_start_line, source_end_line, source_hash, content, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ` : `
        INSERT INTO chunks (path, relpath, kind, home_id, source_start_line, source_end_line, source_hash, content, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return (chunk: MemoryChunk, homeId: string, contentHash: string, now: string) => sessionAware
        ? statement.run(chunk.path, chunk.relpath, chunk.kind, homeId, chunk.sessionId,
            chunk.source_start_line, chunk.source_end_line, chunk.source_hash, chunk.content, contentHash, now)
        : statement.run(chunk.path, chunk.relpath, chunk.kind, homeId,
            chunk.source_start_line, chunk.source_end_line, chunk.source_hash, chunk.content, contentHash, now);
}

function clearIndex(db: Database.Database) {
    db.exec('DELETE FROM chunks;');
    db.exec(`DELETE FROM chunks_fts;`);
    db.exec('DELETE FROM chunks_trigram;');
}

export function indexedFiles(root: string) {
    const buckets = [
        join(root, 'profile.md'),
        ...listMarkdownFiles(join(root, 'shared')),
        ...listMarkdownFiles(join(root, 'episodes')),
        ...listMarkdownFiles(join(root, 'semantic')),
        ...listMarkdownFiles(join(root, 'procedures')),
    ];
    return buckets.filter((value, idx, arr) => value && arr.indexOf(value) === idx && fs.existsSync(value));
}

function kindForFile(root: string, file: string) {
    const rel = relative(root, file).replace(/\\/g, '/');
    if (rel === 'profile.md') return 'profile';
    if (rel.startsWith('shared/')) return 'shared';
    if (rel.startsWith('episodes/digests/')) return 'episode-cold';
    if (rel.startsWith('episodes/')) return 'episode';
    if (rel.startsWith('semantic/')) return 'semantic';
    if (rel.startsWith('procedures/')) return 'procedure';
    return 'memory';
}

export function reindexAll(root: string) {
    const db = getIndexDb();
    try {
        clearIndex(db);
        const now = new Date().toISOString();
        const homeId = instanceId();
        const insertChunk = prepareChunkInsert(db, probeChunkColumns(db).has('session_id'));
        const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, content, relpath, kind) VALUES (?, ?, ?, ?)');
        const insertTrigram = db.prepare('INSERT INTO chunks_trigram (chunk_id, relpath, body) VALUES (?, ?, ?)');
        let totalFiles = 0;
        let totalChunks = 0;
        const tx = db.transaction(() => {
            for (const file of indexedFiles(root)) {
                totalFiles += 1;
                const rel = relative(root, file).replace(/\\/g, '/');
                const kind = kindForFile(root, file);
                for (const chunk of chunkMarkdown(file, rel, kind)) {
                    const contentHash = hashText(chunk.content);
                    const info = insertChunk(chunk, homeId, contentHash, now);
                    const chunkId = Number(info.lastInsertRowid);
                    insertFts.run(chunkId, chunk.content, chunk.relpath, chunk.kind);
                    insertTrigram.run(chunkId, chunk.relpath, chunk.content);
                    totalChunks += 1;
                }
            }
        });
        tx();
        return { totalFiles, totalChunks };
    } finally { db.close(); }
}

export function reindexSingleFile(root: string, file: string) {
    if (!fs.existsSync(file)) return 0;
    const db = getIndexDb();
    try {
        const rel = relative(root, file).replace(/\\/g, '/');
        const kind = kindForFile(root, file);
        const now = new Date().toISOString();
        const homeId = instanceId();
        db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE relpath = ?)').run(rel);
        db.prepare('DELETE FROM chunks_trigram WHERE chunk_id IN (SELECT id FROM chunks WHERE relpath = ?)').run(rel);
        db.prepare('DELETE FROM chunks WHERE relpath = ?').run(rel);
        const insertChunk = prepareChunkInsert(db, probeChunkColumns(db).has('session_id'));
        const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, content, relpath, kind) VALUES (?, ?, ?, ?)');
        const insertTrigram = db.prepare('INSERT INTO chunks_trigram (chunk_id, relpath, body) VALUES (?, ?, ?)');
        let count = 0;
        const tx = db.transaction(() => {
            for (const chunk of chunkMarkdown(file, rel, kind)) {
                const contentHash = hashText(chunk.content);
                const info = insertChunk(chunk, homeId, contentHash, now);
                const chunkId = Number(info.lastInsertRowid);
                insertFts.run(chunkId, chunk.content, chunk.relpath, chunk.kind);
                insertTrigram.run(chunkId, chunk.relpath, chunk.content);
                count++;
            }
        });
        tx();
        return count;
    } finally { db.close(); }
}

export function reindexIntegratedMemoryFile(file: string) {
    const root = getAdvancedMemoryDir();
    if (!fs.existsSync(file)) return 0;
    if (!file.startsWith(root)) return 0;
    return reindexSingleFile(root, file);
}

function buildLikeTerm(term: string) {
    return `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
}

function tokenizeQuery(query: string) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return [];
    const tokens = trimmed
        .split(/[\s,]+/)
        .map(t => t.trim())
        .filter(Boolean);
    return Array.from(new Set([trimmed, ...tokens])).slice(0, 8);
}

function tokenizeExpandedQuery(query: string, expanded?: string[]) {
    const raw = expanded?.length ? [query, ...expanded] : tokenizeQuery(query);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        const value = String(item || '').replace(/[;&|`$><]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (out.length >= 16) break;
    }
    return out;
}

function kindPriority(kind: string): number {
    if (kind === 'profile') return -4.0;
    if (kind === 'shared') return -3.0;
    if (kind === 'procedure') return -2.5;
    if (kind === 'semantic') return -2.0;
    if (kind === 'episode') return 0;
    if (kind === 'episode-cold') return 0;
    return 0;
}

const HALF_LIFE_HOURS: Record<string, number> = {
    episode: 24 * 7,
    'episode-cold': 24 * 180,
    semantic: 24 * 30,
    shared: 24 * 90,
    procedure: Infinity,
    profile: Infinity,
};

function recencyBoost(kind: string, relpath: string): number {
    const halfLife = HALF_LIFE_HOURS[kind] ?? 24 * 7;
    if (halfLife === Infinity) return 0;
    const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(relpath);
    if (!dateMatch) return 0;
    const ageHours = (Date.now() - new Date(dateMatch[1]!).getTime()) / 3600000;
    if (ageHours < 0) return -1.5;
    const boost = -1.5 * Math.exp(-Math.LN2 * ageHours / halfLife);
    // Penalize stale episodes: beyond 2x half-life, push them down
    if (kind === 'episode' && ageHours > halfLife * 2) {
        return boost + Math.min(2.0, (ageHours - halfLife * 2) / (halfLife * 2));
    }
    return boost;
}

function computeFinalScore(hit: SearchHit, query: string): number {
    const q = query.toLowerCase();
    const snippet = hit.snippet.toLowerCase();
    const exactMatch = snippet.includes(q);
    const phraseMatch = snippet.includes(`header: ${q}`) || snippet.includes(`## ${q}`);
    const kw = kindPriority(hit.kind);
    const rw = recencyBoost(hit.kind, hit.relpath);
    const exactBoost = exactMatch ? -2.0 : 0;
    const phraseBoost = phraseMatch ? -1.0 : 0;
    return hit.score + kw + rw + exactBoost + phraseBoost;
}

export function formatHits(hits: SearchHit[], opts: { includeDebugMeta?: boolean } = {}) {
    if (!hits.length) return '(no results)';
    return hits.map(hit => {
        const loc = `${hit.relpath}:${hit.source_start_line}-${hit.source_end_line}`;
        const debug = opts.includeDebugMeta
            ? `\n[kind=${hit.kind} final=${hit.score.toFixed(1)}]`
            : '';
        return `${loc}${debug}\n${hit.snippet}`;
    }).join('\n\n---\n\n');
}

function quoteFtsTerm(term: string): string {
    const cleaned = String(term || '').replace(/"/g, '""').trim();
    return cleaned ? `"${cleaned}"` : '';
}

type IndexedSearchHit = SearchHit & { sessionId?: string };
export type ProviderMemoryHit = SearchHit & { sessionId: string };

interface SearchCoreOptions {
    maxHits: number;
    bm25CandidateLimit: number;
    trigramCandidateLimit: number;
    likeCandidateLimit: number;
    includeSession: boolean;
    deterministicTies: boolean;
}

const LEGACY_SEARCH_OPTIONS: SearchCoreOptions = {
    maxHits: 8,
    bm25CandidateLimit: 16,
    trigramCandidateLimit: 15,
    likeCandidateLimit: 15,
    includeSession: false,
    deterministicTies: false,
};
const PROVIDER_CANDIDATE_CAP = 64;
const PROVIDER_SEARCH_OPTIONS: SearchCoreOptions = {
    maxHits: PROVIDER_CANDIDATE_CAP,
    bm25CandidateLimit: PROVIDER_CANDIDATE_CAP,
    trigramCandidateLimit: PROVIDER_CANDIDATE_CAP,
    likeCandidateLimit: PROVIDER_CANDIDATE_CAP,
    includeSession: true,
    deterministicTies: true,
};

function toHit(row: ChunkRow, score: number, includeSession: boolean): IndexedSearchHit {
    return {
        path: row.path,
        relpath: row.relpath,
        kind: row.kind,
        source_start_line: row.source_start_line,
        source_end_line: row.source_end_line,
        snippet: String(row.content || '').slice(0, 700),
        score,
        ...(includeSession ? { sessionId: row.sessionId ?? '' } : {}),
    };
}

function sessionProjection(cap: SchemaCapability, tableAlias: string, includeSession: boolean): string {
    if (!includeSession) return '';
    return cap.chunksColumns.has('session_id')
        ? `${tableAlias}.session_id AS sessionId,`
        : `'' AS sessionId,`;
}

function searchBM25(
    db: Database.Database,
    groups: string[][],
    cap: SchemaCapability,
    options: SearchCoreOptions,
): IndexedSearchHit[] {
    const hits = new Map<string, IndexedSearchHit>();
    const projection = sessionProjection(cap, 'c', options.includeSession);
    const ftsOrder = options.deterministicTies
        ? 'ORDER BY score, c.relpath ASC, c.source_start_line ASC, c.source_end_line ASC'
        : 'ORDER BY score';
    const fts = db.prepare(`
        SELECT
            c.path,
            c.relpath,
            c.kind,
            c.source_start_line,
            c.source_end_line,
            ${projection}
            c.content,
            bm25(chunks_fts) AS score
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ${ftsOrder}
        LIMIT ?
    `);
    const like = db.prepare(`
        SELECT c.path, c.relpath, c.kind, c.source_start_line, c.source_end_line,
            ${projection} c.content
        FROM chunks c
        WHERE c.content LIKE ? ESCAPE '\\'
        ORDER BY c.relpath ASC, c.source_start_line ASC
        LIMIT ?
    `);
    for (const group of groups) {
        const ftsQuery = group.map(quoteFtsTerm).filter(Boolean).join(' OR ');
        try {
            for (const row of fts.all(ftsQuery, options.bm25CandidateLimit) as ChunkRow[]) {
                const key = `${row.relpath}:${row.source_start_line}:${row.source_end_line}`;
                if (!hits.has(key)) hits.set(key, toHit(row, Number(row.score || 0), options.includeSession));
            }
        } catch { /* fall through to LIKE */ }
        for (const term of group) {
            for (const row of like.all(buildLikeTerm(term), options.bm25CandidateLimit) as ChunkRow[]) {
                const key = `${row.relpath}:${row.source_start_line}:${row.source_end_line}`;
                if (!hits.has(key)) hits.set(key, toHit(row, 999, options.includeSession));
            }
        }
    }
    return [...hits.values()];
}

// CJK detection helpers for trigram routing
const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

function containsCJK(text: string): boolean {
    return CJK_RE.test(text);
}

function countCJKChars(text: string): number {
    let n = 0;
    for (const ch of text) { if (CJK_RE.test(ch)) n++; }
    return n;
}

function searchTrigram(
    db: Database.Database,
    query: string,
    cap: SchemaCapability,
    options: SearchCoreOptions,
): IndexedSearchHit[] {
    const term = String(query || '').trim();
    if (term.length < 3) return [];
    try {
        const projection = sessionProjection(cap, 'c', options.includeSession);
        const order = options.deterministicTies
            ? 'ORDER BY c.relpath ASC, c.source_start_line ASC, c.source_end_line ASC' : '';
        const rows = db.prepare(`
            SELECT c.path, c.relpath, c.kind, c.source_start_line, c.source_end_line,
                ${projection} c.content, 0 AS score
            FROM chunks_trigram t
            JOIN chunks c ON c.id = t.chunk_id
            WHERE chunks_trigram MATCH ?
            ${order}
            LIMIT ?
        `).all(quoteFtsTerm(term), options.trigramCandidateLimit) as ChunkRow[];
        return rows.map((row, idx) => toHit(row, idx, options.includeSession));
    } catch { return []; }
}

function searchLikeFallback(
    db: Database.Database,
    query: string,
    cap: SchemaCapability,
    options: SearchCoreOptions,
): IndexedSearchHit[] {
    const term = String(query || '').trim();
    if (!term) return [];
    try {
        const escaped = term.replace(/[%_\\]/g, c => '\\' + c);
        const projection = sessionProjection(cap, 'c', options.includeSession);
        const order = options.deterministicTies
            ? 'ORDER BY c.relpath ASC, c.source_start_line ASC, c.source_end_line ASC' : '';
        const rows = db.prepare(`
            SELECT c.path, c.relpath, c.kind, c.source_start_line, c.source_end_line,
                ${projection} c.content, 0 AS score
            FROM chunks c
            WHERE c.content LIKE '%' || ? || '%' ESCAPE '\\'
            ${order}
            LIMIT ?
        `).all(escaped, options.likeCandidateLimit) as ChunkRow[];
        return rows.map((row, idx) => toHit(row, idx, options.includeSession));
    } catch { return []; }
}

function reciprocalRankFusion(primary: IndexedSearchHit[], secondary: IndexedSearchHit[], k = 60): IndexedSearchHit[] {
    const scores = new Map<string, { hit: IndexedSearchHit; score: number }>();
    for (const [listIndex, list] of [primary, secondary].entries()) {
        for (let i = 0; i < list.length; i++) {
            const hit = list[i]!;
            const key = `${hit.relpath}:${hit.source_start_line}:${hit.source_end_line}`;
            const prev = scores.get(key);
            scores.set(key, { hit: prev?.hit ?? hit, score: (prev?.score ?? 0) + (listIndex === 0 ? 1 : 0.8) / (k + i) });
        }
    }
    return [...scores.values()].sort((a, b) => b.score - a.score).map(v => ({ ...v.hit, score: -v.score }));
}

interface SchemaCapability {
    hasSynonyms: boolean;
    hasTrigram: boolean;
    chunksColumns: Set<string>;
}

function probeSchema(db: Database.Database): SchemaCapability {
    const tables = new Set<string>(
        (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table')`).all() as Array<{ name: string }>)
            .map(r => r.name)
    );
    const cols = probeChunkColumns(db);
    return { hasSynonyms: tables.has('memory_synonyms'), hasTrigram: tables.has('chunks_trigram'), chunksColumns: cols };
}

function compareHitTies(a: IndexedSearchHit, b: IndexedSearchHit): number {
    if (a.relpath !== b.relpath) return a.relpath < b.relpath ? -1 : 1;
    if (a.source_start_line !== b.source_start_line) return a.source_start_line - b.source_start_line;
    return a.source_end_line - b.source_end_line;
}

function searchIndexCore(
    db: Database.Database,
    query: string,
    expanded: string[] | undefined,
    cap: SchemaCapability,
    options: SearchCoreOptions = LEGACY_SEARCH_OPTIONS,
): { hits: IndexedSearchHit[]; degraded: string[] } {
    const terms = tokenizeExpandedQuery(query, expanded);
    if (!terms.length) return { hits: [], degraded: [] };
    const degraded: string[] = [];
    const baseQuery = terms[0] || query;

    // CJK-primary path: route Korean/Japanese/Chinese queries to trigram
    if (containsCJK(query) && cap.hasTrigram) {
        if (countCJKChars(query) >= 3) {
            const hits = searchTrigram(db, query, cap, options)
                .map(hit => ({ ...hit, score: computeFinalScore(hit, baseQuery) }))
                .sort((a, b) => a.score - b.score || (options.deterministicTies ? compareHitTies(a, b) : 0))
                .slice(0, options.maxHits);
            return { hits, degraded };
        }
        // Short CJK (< 3 chars): LIKE fallback
        const hits = searchLikeFallback(db, query, cap, options)
            .map(hit => ({ ...hit, score: computeFinalScore(hit, baseQuery) }))
            .sort((a, b) => a.score - b.score || (options.deterministicTies ? compareHitTies(a, b) : 0))
            .slice(0, options.maxHits);
        return { hits, degraded };
    }

    // Non-CJK: existing BM25 + trigram RRF
    const groups = cap.hasSynonyms
        ? terms.map(term => expandSynonyms(db, term))
        : (degraded.push('memory_synonyms'), terms.map(t => [t]));
    const bm25 = searchBM25(db, groups, cap, options);
    const trigram = cap.hasTrigram
        ? searchTrigram(db, query, cap, options)
        : (degraded.push('chunks_trigram'), [] as IndexedSearchHit[]);
    const merged = reciprocalRankFusion(bm25, trigram);
    const hits = merged
        .map(hit => ({ ...hit, score: computeFinalScore(hit, baseQuery) }))
        .sort((a, b) => a.score - b.score || (options.deterministicTies ? compareHitTies(a, b) : 0))
        .slice(0, options.maxHits);
    return { hits, degraded };
}

export function searchIndex(query: string, expanded?: string[]): { hits: SearchHit[] } {
    const db = getIndexDb();
    try {
        const cap = probeSchema(db);
        return { hits: searchIndexCore(db, query, expanded, cap).hits };
    } finally { db.close(); }
}

export function searchIndexForProvider(
    query: string,
    opts: { limit: number; offset: number },
): { hits: ProviderMemoryHit[]; hasMore: boolean; degraded: string[] } {
    const db = getIndexDb();
    try {
        const cap = probeSchema(db);
        if (!cap.chunksColumns.has('content') || !cap.chunksColumns.has('relpath')) {
            return { hits: [], hasMore: false, degraded: ['chunks.core'] };
        }
        const result = searchIndexCore(db, query, undefined, cap, PROVIDER_SEARCH_OPTIONS);
        const offset = Math.max(0, Math.floor(opts.offset));
        const limit = Math.max(0, Math.floor(opts.limit));
        const selected = result.hits.slice(offset, offset + limit);
        const hits: ProviderMemoryHit[] = selected.map(hit => ({ ...hit, sessionId: hit.sessionId ?? '' }));
        return {
            hits,
            hasMore: offset + selected.length < result.hits.length,
            degraded: result.degraded,
        };
    } finally { db.close(); }
}

export interface ReadOnlySearchResult { hits: SearchHit[]; degraded: string[]; }

export function searchIndexReadOnly(dbPath: string, query: string, expanded?: string[]): ReadOnlySearchResult {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
    try {
        const cap = probeSchema(db);
        if (!cap.chunksColumns.has('content') || !cap.chunksColumns.has('relpath')) {
            return { hits: [], degraded: ['chunks.core'] };
        }
        return searchIndexCore(db, query, expanded, cap);
    } finally { db.close(); }
}

export function reindexIndexCounts(dbPath: string) {
    const db = new Database(dbPath, { readonly: true });
    const totalChunks = Number((db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c?: number } | undefined)?.c || 0);
    const totalFiles = Number((db.prepare('SELECT COUNT(DISTINCT relpath) AS c FROM chunks').get() as { c?: number } | undefined)?.c || 0);
    db.close();
    return { totalFiles, totalChunks };
}
