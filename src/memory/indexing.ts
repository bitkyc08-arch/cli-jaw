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
    sanitizeKeywords,
    listMarkdownFiles,
} from './shared.js';

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

function chunkMarkdown(absPath: string, relpath: string, kind: string) {
    const raw = safeReadFile(absPath);
    const parsed = parseMarkdownFile(raw);
    const lines = parsed.body.split('\n');
    const chunks: Array<{
        relpath: string;
        path: string;
        kind: string;
        source_start_line: number;
        source_end_line: number;
        source_hash: string;
        content: string;
    }> = [];

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
            source_start_line: parsed.bodyStartLine,
            source_end_line: parsed.bodyStartLine + lines.length - 1,
            source_hash: hashText(`${relpath}:${parsed.body}`),
            content: parsed.body.trim(),
        });
    }
    return chunks;
}

export function getIndexDb() {
    ensureDir(getAdvancedMemoryDir());
    const db = new Database(getAdvancedIndexDbPath());
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
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
        CREATE INDEX IF NOT EXISTS idx_chunks_relpath ON chunks(relpath);
        CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            content,
            relpath UNINDEXED,
            kind UNINDEXED,
            tokenize = 'unicode61'
        );
    `);
    return db;
}

function clearIndex(db: any) {
    db.exec('DELETE FROM chunks;');
    db.exec(`DELETE FROM chunks_fts;`);
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
    if (rel.startsWith('episodes/')) return 'episode';
    if (rel.startsWith('semantic/')) return 'semantic';
    if (rel.startsWith('procedures/')) return 'procedure';
    return 'memory';
}

export function reindexAll(root: string) {
    const db = getIndexDb();
    clearIndex(db);

    const now = new Date().toISOString();
    const homeId = instanceId();
    const insertChunk = db.prepare(`
        INSERT INTO chunks (path, relpath, kind, home_id, source_start_line, source_end_line, source_hash, content, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(`
        INSERT INTO chunks_fts (rowid, content, relpath, kind)
        VALUES (?, ?, ?, ?)
    `);

    let totalFiles = 0;
    let totalChunks = 0;
    const tx = db.transaction(() => {
        for (const file of indexedFiles(root)) {
            totalFiles += 1;
            const rel = relative(root, file).replace(/\\/g, '/');
            const kind = kindForFile(root, file);
            for (const chunk of chunkMarkdown(file, rel, kind)) {
                const contentHash = hashText(chunk.content);
                const info = insertChunk.run(
                    chunk.path,
                    chunk.relpath,
                    chunk.kind,
                    homeId,
                    chunk.source_start_line,
                    chunk.source_end_line,
                    chunk.source_hash,
                    chunk.content,
                    contentHash,
                    now,
                );
                insertFts.run(
                    Number(info.lastInsertRowid),
                    chunk.content,
                    chunk.relpath,
                    chunk.kind,
                );
                totalChunks += 1;
            }
        }
    });
    tx();
    db.close();
    return { totalFiles, totalChunks };
}

export function reindexSingleFile(root: string, file: string) {
    if (!fs.existsSync(file)) return 0;
    const db = getIndexDb();
    const rel = relative(root, file).replace(/\\/g, '/');
    const kind = kindForFile(root, file);
    const now = new Date().toISOString();
    const homeId = instanceId();

    db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE relpath = ?)').run(rel);
    db.prepare('DELETE FROM chunks WHERE relpath = ?').run(rel);

    const insertChunk = db.prepare(
        'INSERT INTO chunks (path, relpath, kind, home_id, source_start_line, source_end_line, source_hash, content, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertFts = db.prepare(
        'INSERT INTO chunks_fts (rowid, content, relpath, kind) VALUES (?, ?, ?, ?)'
    );
    let count = 0;
    const tx = db.transaction(() => {
        for (const chunk of chunkMarkdown(file, rel, kind)) {
            const contentHash = hashText(chunk.content);
            const info = insertChunk.run(chunk.path, chunk.relpath, chunk.kind, homeId, chunk.source_start_line, chunk.source_end_line, chunk.source_hash, chunk.content, contentHash, now);
            insertFts.run(Number(info.lastInsertRowid), chunk.content, chunk.relpath, chunk.kind);
            count++;
        }
    });
    tx();
    db.close();
    return count;
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
    if (expanded?.length) return sanitizeKeywords([query, ...expanded]).slice(0, 8);
    return tokenizeQuery(query);
}

// ─── Phase 2: Ranking helpers ───────────────────────

function kindPriority(kind: string): number {
    if (kind === 'profile') return -4.0;
    if (kind === 'shared') return -3.0;
    if (kind === 'procedure') return -2.5;
    if (kind === 'semantic') return -2.0;
    if (kind === 'episode') return 0;
    return 0;
}

function estimateRecencyBoost(relpath: string): number {
    const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(relpath);
    if (!dateMatch) return 0;
    const fileDate = new Date(dateMatch[1]!);
    const now = new Date();
    const daysDiff = (now.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff <= 1) return -1.5;
    if (daysDiff <= 3) return -1.0;
    if (daysDiff <= 7) return -0.5;
    return 0;
}

function computeFinalScore(hit: SearchHit, query: string): number {
    const q = query.toLowerCase();
    const snippet = hit.snippet.toLowerCase();
    const exactMatch = snippet.includes(q);
    const phraseMatch = snippet.includes(`header: ${q}`) || snippet.includes(`## ${q}`);
    const kw = kindPriority(hit.kind);
    const rw = estimateRecencyBoost(hit.relpath);
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

export function searchIndex(query: string, expanded?: string[]) {
    const db = getIndexDb();
    const searchTerms = tokenizeExpandedQuery(query, expanded);
    if (!searchTerms.length) {
        db.close();
        return { hits: [] as SearchHit[] };
    }

    const byPathLine = new Map<string, SearchHit>();
    const ftsStmt = db.prepare(`
        SELECT
            c.path,
            c.relpath,
            c.kind,
            c.source_start_line,
            c.source_end_line,
            c.content,
            bm25(chunks_fts) AS score
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY score
        LIMIT 16
    `);
    const likeStmt = db.prepare(`
        SELECT path, relpath, kind, source_start_line, source_end_line, content
        FROM chunks
        WHERE content LIKE ? ESCAPE '\\'
        ORDER BY relpath ASC, source_start_line ASC
        LIMIT 16
    `);

    for (const term of searchTerms) {
        const ftsQuery = term.split(/\s+/).map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
        try {
            const rows = ftsStmt.all(ftsQuery) as any[];
            for (const row of rows) {
                const key = `${row.relpath}:${row.source_start_line}:${row.source_end_line}`;
                if (!byPathLine.has(key)) {
                    byPathLine.set(key, {
                        path: row.path,
                        relpath: row.relpath,
                        kind: row.kind,
                        source_start_line: row.source_start_line,
                        source_end_line: row.source_end_line,
                        snippet: String(row.content || '').slice(0, 700),
                        score: Number(row.score || 0),
                    });
                }
            }
        } catch {
            // ignore FTS parse issues, fallback to LIKE below
        }
        const likeRows = likeStmt.all(buildLikeTerm(term)) as any[];
        for (const row of likeRows) {
            const key = `${row.relpath}:${row.source_start_line}:${row.source_end_line}`;
            if (!byPathLine.has(key)) {
                byPathLine.set(key, {
                    path: row.path,
                    relpath: row.relpath,
                    kind: row.kind,
                    source_start_line: row.source_start_line,
                    source_end_line: row.source_end_line,
                    snippet: String(row.content || '').slice(0, 700),
                    score: 999,
                });
            }
        }
    }
    db.close();
    const baseQuery = searchTerms[0] || query;
    const hits = [...byPathLine.values()]
        .map(hit => ({ ...hit, score: computeFinalScore(hit, baseQuery) }))
        .sort((a, b) => a.score - b.score)
        .slice(0, 8);
    return { hits };
}

export function reindexIndexCounts(dbPath: string) {
    const db = new Database(dbPath, { readonly: true });
    const totalChunks = Number((db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as any)?.c || 0);
    const totalFiles = Number((db.prepare('SELECT COUNT(DISTINCT relpath) AS c FROM chunks').get() as any)?.c || 0);
    db.close();
    return { totalFiles, totalChunks };
}
