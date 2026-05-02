import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { dashboardPath } from '../dashboard-home.js';

export type DashboardTaskLane = 'inbox' | 'doing' | 'blocked' | 'review' | 'done';
export const TASK_LANES: readonly DashboardTaskLane[] = ['inbox', 'doing', 'blocked', 'review', 'done'] as const;

function isLane(v: unknown): v is DashboardTaskLane {
    return typeof v === 'string' && (TASK_LANES as readonly string[]).includes(v);
}

export type DashboardTask = {
    id: string;
    title: string;
    summary: string | null;
    detail: string | null;
    lane: DashboardTaskLane;
    port: number | null;
    threadKey: string | null;
    notePath: string | null;
    source: string;
    createdAt: string;
    updatedAt: string;
};

export type DashboardTaskInput = {
    title: string;
    summary?: string | null;
    detail?: string | null;
    lane?: DashboardTaskLane;
    port?: number | null;
    threadKey?: string | null;
    notePath?: string | null;
    source?: string;
};

export type DashboardTaskPatch = Partial<Omit<DashboardTaskInput, 'source'>>;

type Row = {
    id: string;
    title: string;
    summary: string | null;
    detail: string | null;
    lane: string;
    port: number | null;
    thread_key: string | null;
    note_path: string | null;
    source: string;
    created_at: string;
    updated_at: string;
};

function rowToTask(row: Row): DashboardTask {
    const lane: DashboardTaskLane = isLane(row.lane) ? row.lane : 'inbox';
    return {
        id: row.id,
        title: row.title,
        summary: row.summary,
        detail: row.detail,
        lane,
        port: row.port,
        threadKey: row.thread_key,
        notePath: row.note_path,
        source: row.source,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function ensureDir(p: string) {
    const d = dirname(p);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function normalizeOptionalText(value: string | null | undefined, maxLength: number): string | null {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.length > maxLength) throw new Error('text too long');
    return text;
}

export type BoardStoreOptions = { dbPath?: string };

export class BoardStore {
    private readonly db: Database.Database;

    constructor(options: BoardStoreOptions = {}) {
        const path = options.dbPath || dashboardPath('dashboard.db');
        ensureDir(path);
        this.db = new Database(path);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS dashboard_tasks (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                summary     TEXT,
                detail      TEXT,
                lane        TEXT NOT NULL DEFAULT 'inbox',
                port        INTEGER,
                thread_key  TEXT,
                note_path   TEXT,
                source      TEXT NOT NULL DEFAULT 'user',
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_dashboard_tasks_lane ON dashboard_tasks(lane);
            CREATE INDEX IF NOT EXISTS idx_dashboard_tasks_updated ON dashboard_tasks(updated_at);
        `);
        this.ensureColumn('summary', 'TEXT');
        this.ensureColumn('detail', 'TEXT');
    }

    private ensureColumn(name: string, ddl: string): void {
        const rows = this.db.prepare('PRAGMA table_info(dashboard_tasks)').all() as Array<{ name: string }>;
        if (rows.some(row => row.name === name)) return;
        this.db.exec(`ALTER TABLE dashboard_tasks ADD COLUMN ${name} ${ddl}`);
    }

    list(): DashboardTask[] {
        const rows = this.db.prepare('SELECT * FROM dashboard_tasks ORDER BY updated_at DESC').all() as Row[];
        return rows.map(rowToTask);
    }

    get(id: string): DashboardTask | null {
        const row = this.db.prepare('SELECT * FROM dashboard_tasks WHERE id = ?').get(id) as Row | undefined;
        return row ? rowToTask(row) : null;
    }

    create(input: DashboardTaskInput): DashboardTask {
        const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        if (input.lane !== undefined && !isLane(input.lane)) throw new Error('invalid lane');
        const lane: DashboardTaskLane = input.lane ?? 'inbox';
        const title = String(input.title || '').trim();
        if (!title) throw new Error('title required');
        if (title.length > 500) throw new Error('title too long');
        const summary = normalizeOptionalText(input.summary, 500);
        const detail = normalizeOptionalText(input.detail, 20000);
        this.db.prepare(`
            INSERT INTO dashboard_tasks (id, title, summary, detail, lane, port, thread_key, note_path, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            title,
            summary,
            detail,
            lane,
            input.port ?? null,
            input.threadKey ?? null,
            input.notePath ?? null,
            input.source || 'user',
        );
        const created = this.get(id);
        if (!created) throw new Error('task creation failed');
        return created;
    }

    update(id: string, patch: DashboardTaskPatch): DashboardTask | null {
        const existing = this.get(id);
        if (!existing) return null;
        const fields: string[] = [];
        const values: unknown[] = [];
        if (patch.title !== undefined) {
            const t = String(patch.title).trim();
            if (!t || t.length > 500) throw new Error('invalid title');
            fields.push('title = ?'); values.push(t);
        }
        if (patch.summary !== undefined) {
            fields.push('summary = ?'); values.push(normalizeOptionalText(patch.summary, 500));
        }
        if (patch.detail !== undefined) {
            fields.push('detail = ?'); values.push(normalizeOptionalText(patch.detail, 20000));
        }
        if (patch.lane !== undefined) {
            if (!isLane(patch.lane)) throw new Error('invalid lane');
            fields.push('lane = ?'); values.push(patch.lane);
        }
        if (patch.port !== undefined) { fields.push('port = ?'); values.push(patch.port); }
        if (patch.threadKey !== undefined) { fields.push('thread_key = ?'); values.push(patch.threadKey); }
        if (patch.notePath !== undefined) { fields.push('note_path = ?'); values.push(patch.notePath); }
        if (fields.length === 0) return existing;
        fields.push("updated_at = datetime('now')");
        values.push(id);
        this.db.prepare(`UPDATE dashboard_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        return this.get(id);
    }

    remove(id: string): boolean {
        const r = this.db.prepare('DELETE FROM dashboard_tasks WHERE id = ?').run(id);
        return r.changes > 0;
    }

    close(): void { this.db.close(); }
}
