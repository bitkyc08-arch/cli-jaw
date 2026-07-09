import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { statSync } from 'node:fs';
import { join } from 'node:path';

export interface VecChunk {
  chunkId: number;
  instanceId: string;
  relpath: string;
  kind: string;
  contentHash: string;
  snippet: string;
  sourceStartLine: number;
  sourceEndLine: number;
}

export interface VecSearchHit extends VecChunk {
  distance: number;
}

export class VecStore {
  private db: Database.Database;
  readonly dimensions: number;
  readonly dbPath: string;

  constructor(dbPath: string, dimensions: number) {
    this.dimensions = dimensions;
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 3000');
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_meta (
        rowid INTEGER PRIMARY KEY,
        instance_id TEXT NOT NULL,
        chunk_id INTEGER NOT NULL,
        relpath TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        snippet TEXT NOT NULL DEFAULT '',
        source_start_line INTEGER NOT NULL DEFAULT 0,
        source_end_line INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        UNIQUE(instance_id, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS idx_vm_instance ON vec_meta(instance_id);
      CREATE INDEX IF NOT EXISTS idx_vm_hash ON vec_meta(instance_id, chunk_id, content_hash);

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        embedding float[${this.dimensions}]
      );

      CREATE TABLE IF NOT EXISTS vec_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  getExistingHashes(instanceId: string): Map<number, { contentHash: string; rowid: number }> {
    const rows = this.db.prepare(
      'SELECT rowid, chunk_id, content_hash FROM vec_meta WHERE instance_id = ?'
    ).all(instanceId) as Array<{ rowid: number; chunk_id: number; content_hash: string }>;
    return new Map(rows.map(r => [r.chunk_id, { contentHash: r.content_hash, rowid: r.rowid }]));
  }

  upsertVec(
    existingRowid: number | null,
    meta: Omit<VecChunk, 'distance'>,
    embedding: Float32Array,
    provider: string,
    model: string,
  ): void {
    const tx = this.db.transaction(() => {
      if (existingRowid !== null) {
        this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(BigInt(existingRowid));
        this.db.prepare('DELETE FROM vec_meta WHERE rowid = ?').run(existingRowid);
      }
      const info = this.db.prepare(`
        INSERT INTO vec_meta (instance_id, chunk_id, relpath, kind, content_hash, snippet, source_start_line, source_end_line, provider, model, embedded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        meta.instanceId, meta.chunkId, meta.relpath, meta.kind,
        meta.contentHash, meta.snippet, meta.sourceStartLine, meta.sourceEndLine,
        provider, model, new Date().toISOString(),
      );
      const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
      const rowid = typeof info.lastInsertRowid === 'bigint' ? info.lastInsertRowid : BigInt(info.lastInsertRowid);
      this.db.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)').run(rowid, buf);
    });
    tx();
  }

  deleteByRowid(rowid: number): void {
    const tx = this.db.transaction(() => {
      const rid = BigInt(rowid);
      this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(rid);
      this.db.prepare('DELETE FROM vec_meta WHERE rowid = ?').run(rowid);
    });
    tx();
  }

  deleteByInstance(instanceId: string): void {
    const tx = this.db.transaction(() => {
      const rowids = this.db.prepare(
        'SELECT rowid FROM vec_meta WHERE instance_id = ?'
      ).all(instanceId) as Array<{ rowid: number }>;
      for (const { rowid } of rowids) {
        this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(BigInt(rowid));
      }
      this.db.prepare('DELETE FROM vec_meta WHERE instance_id = ?').run(instanceId);
    });
    tx();
  }

  search(queryEmbedding: Float32Array, topK: number = 50): VecSearchHit[] {
    const buf = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
    const rows = this.db.prepare(`
      SELECT v.rowid, v.distance, m.instance_id, m.chunk_id, m.relpath, m.kind,
             m.content_hash, m.snippet, m.source_start_line, m.source_end_line
      FROM vec_chunks v
      JOIN vec_meta m ON m.rowid = v.rowid
      WHERE v.embedding MATCH ? AND v.k = ?
      ORDER BY v.distance
    `).all(buf, topK) as Array<any>;
    return rows.map(r => ({
      chunkId: r.chunk_id,
      instanceId: r.instance_id,
      relpath: r.relpath,
      kind: r.kind,
      contentHash: r.content_hash,
      snippet: r.snippet,
      sourceStartLine: r.source_start_line,
      sourceEndLine: r.source_end_line,
      distance: r.distance,
    }));
  }

  searchScoped(queryEmbedding: Float32Array, topK: number, instanceIds: string[]): VecSearchHit[] {
    if (instanceIds.length === 0) return this.search(queryEmbedding, topK);
    const buf = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
    const placeholders = instanceIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT v.rowid, v.distance, m.instance_id, m.chunk_id, m.relpath, m.kind,
             m.content_hash, m.snippet, m.source_start_line, m.source_end_line
      FROM vec_chunks v
      JOIN vec_meta m ON m.rowid = v.rowid
      WHERE v.embedding MATCH ? AND v.k = ?
        AND m.instance_id IN (${placeholders})
      ORDER BY v.distance
    `).all(buf, topK, ...instanceIds) as Array<any>;
    return rows.map(r => ({
      chunkId: r.chunk_id,
      instanceId: r.instance_id,
      relpath: r.relpath,
      kind: r.kind,
      contentHash: r.content_hash,
      snippet: r.snippet,
      sourceStartLine: r.source_start_line,
      sourceEndLine: r.source_end_line,
      distance: r.distance,
    }));
  }

  getExistingHashesByRelpath(instanceId: string, relpath: string): Map<number, { contentHash: string; rowid: number }> {
    const rows = this.db.prepare(
      'SELECT rowid, chunk_id, content_hash FROM vec_meta WHERE instance_id = ? AND relpath = ?'
    ).all(instanceId, relpath) as Array<{ rowid: number; chunk_id: number; content_hash: string }>;
    const map = new Map<number, { contentHash: string; rowid: number }>();
    for (const r of rows) {
      map.set(r.chunk_id, { contentHash: r.content_hash, rowid: r.rowid });
    }
    return map;
  }

  getStats(): { totalChunks: number; instances: number; dbSizeBytes: number } {
    const countRow = this.db.prepare('SELECT COUNT(*) as cnt FROM vec_meta').get() as { cnt: number };
    const instRow = this.db.prepare('SELECT COUNT(DISTINCT instance_id) as cnt FROM vec_meta').get() as { cnt: number };
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(this.dbPath).size;
    } catch {} // best-effort: size stat is informational
    return { totalChunks: countRow.cnt, instances: instRow.cnt, dbSizeBytes };
  }

  getConfig(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM vec_config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setConfig(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO vec_config (key, value) VALUES (?, ?)').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

export function getVecDbPath(dashboardHome: string): string {
  return join(dashboardHome, 'vec_memory.sqlite');
}
