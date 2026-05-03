import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JAW_HOME } from '../../core/config.js';
import { WebAiError } from './errors.js';

export const SESSION_STORE_VERSION = 1;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LOCK_RETRY_MS = 25;
const LOCK_RETRY_LIMIT = 200;
const STALE_LOCK_MS = 5 * 60 * 1000;
const STORE_FILE = 'web-ai-session-store.json';

export interface StoredSession {
    sessionId: string;
    vendor: string;
    status: string;
    createdAt: string;
    conversationUrl?: string;
    originalUrl?: string;
    composerBefore?: string;
    composerAfter?: string;
    deadlineAt?: string;
    [key: string]: unknown;
}

export interface SessionStore {
    version: number;
    sessions: StoredSession[];
}

export interface SessionFilter {
    sessionId?: string;
    vendor?: string;
    status?: string;
    active?: boolean;
    limit?: number;
}

export interface PruneOptions {
    olderThanMs?: number;
    before?: string;
    status?: string;
}

export interface PruneResult {
    removed: number;
    remaining: number;
}

function storePath(): string {
    return join(JAW_HOME, STORE_FILE);
}

function lockPath(): string {
    return `${storePath()}.lock`;
}

export function generateSessionId(now = Date.now()): string {
    return encodeTime(now) + encodeRandom();
}

function encodeTime(ms: number): string {
    let t = Math.max(0, Math.floor(Number(ms) || 0));
    const out = new Array<string>(10);
    for (let i = 9; i >= 0; i--) {
        out[i] = CROCKFORD[t % 32]!;
        t = Math.floor(t / 32);
    }
    return out.join('');
}

function encodeRandom(): string {
    const bytes = randomBytes(10);
    let bits = 0n;
    for (const b of bytes) bits = (bits << 8n) | BigInt(b);
    let out = '';
    for (let i = 0; i < 16; i++) {
        out = CROCKFORD[Number(bits & 31n)]! + out;
        bits >>= 5n;
    }
    return out;
}

export function readSessionStore(): SessionStore {
    const path = storePath();
    if (!existsSync(path)) return { version: SESSION_STORE_VERSION, sessions: [] };
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionStore>;
        if (!parsed || typeof parsed !== 'object') return { version: SESSION_STORE_VERSION, sessions: [] };
        if (!Array.isArray(parsed.sessions)) parsed.sessions = [];
        if (typeof parsed.version !== 'number') parsed.version = SESSION_STORE_VERSION;
        return parsed as SessionStore;
    } catch {
        return { version: SESSION_STORE_VERSION, sessions: [] };
    }
}

function readSessionStoreLocked(): SessionStore {
    return withStoreLock(() => readSessionStore());
}

export function writeSessionStore(store: SessionStore): void {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
}

export function withStoreLock<T>(fn: () => T): T {
    const path = lockPath();
    mkdirSync(dirname(path), { recursive: true });
    let attempts = 0;
    while (attempts < LOCK_RETRY_LIMIT) {
        try {
            const fd = openSync(path, 'wx');
            try {
                writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
            } catch { /* best-effort metadata write */ }
            try {
                return fn();
            } finally {
                try { closeSync(fd); } catch { /* already closed */ }
                try { unlinkSync(path); } catch { /* already gone */ }
            }
        } catch (err) {
            if ((err as { code?: string })?.code !== 'EEXIST') throw err;
            attempts += 1;
            const stale = isStaleLock(path);
            if (stale) {
                try { unlinkSync(path); } catch { /* races resolve naturally */ }
                continue;
            }
            sleepBlockingMs(LOCK_RETRY_MS);
        }
    }
    throw new WebAiError({
        errorCode: 'internal.unhandled',
        stage: 'session-store-lock',
        retryHint: 'retry',
        message: `web-ai session store: failed to acquire lock at ${path} after ${LOCK_RETRY_LIMIT} attempts`,
    });
}

function isStaleLock(path: string): boolean {
    try {
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw) as { acquiredAt?: string };
        const acquired = Date.parse(parsed?.acquiredAt || '');
        if (!Number.isFinite(acquired)) return true;
        return Date.now() - acquired > STALE_LOCK_MS;
    } catch {
        return true;
    }
}

function sleepBlockingMs(ms: number): void {
    const end = Date.now() + ms;
    const buf = new SharedArrayBuffer(4);
    const view = new Int32Array(buf);
    Atomics.wait(view, 0, 0, Math.max(0, end - Date.now()));
}

export function insertSession(session: StoredSession): StoredSession {
    return withStoreLock(() => {
        const store = readSessionStore();
        store.sessions.push(session);
        writeSessionStore(store);
        return session;
    });
}

export function patchSession(sessionId: string, patch: Partial<StoredSession>): StoredSession | null {
    return withStoreLock(() => {
        const store = readSessionStore();
        const idx = store.sessions.findIndex(s => s.sessionId === sessionId);
        if (idx < 0) return null;
        const existing = store.sessions[idx]!;
        const merged: StoredSession = { ...existing, ...patch, sessionId: existing.sessionId, vendor: patch.vendor ?? existing.vendor, status: patch.status ?? existing.status, createdAt: patch.createdAt ?? existing.createdAt };
        store.sessions[idx] = merged;
        writeSessionStore(store);
        return merged;
    });
}

export function listStoredSessions(filter: SessionFilter = {}): StoredSession[] {
    const store = readSessionStoreLocked();
    const active = new Set(['sent', 'polling']);
    let rows = store.sessions;
    if (filter.sessionId) rows = rows.filter(s => s.sessionId === filter.sessionId);
    if (filter.vendor) rows = rows.filter(s => s.vendor === filter.vendor);
    if (filter.status) rows = rows.filter(s => s.status === filter.status);
    if (filter.active === true) rows = rows.filter(s => active.has(s.status));
    rows = rows.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (typeof filter.limit === 'number' && filter.limit > 0) rows = rows.slice(-filter.limit);
    return rows;
}

function sessionCommandLockPath(sessionId: string): string {
    return `${storePath()}.cmd.${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`;
}

export async function withSessionCommandLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const path = sessionCommandLockPath(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    let fd: number | null = null;
    let attempts = 0;
    while (attempts < LOCK_RETRY_LIMIT) {
        try {
            fd = openSync(path, 'wx');
            try {
                writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), sessionId }));
            } catch { /* best-effort metadata write */ }
            break;
        } catch (err: any) {
            if (err?.code !== 'EEXIST') throw err;
            attempts += 1;
            const stale = isStaleLock(path);
            if (stale) {
                try { unlinkSync(path); } catch { /* races resolve naturally */ }
                continue;
            }
            sleepBlockingMs(LOCK_RETRY_MS);
        }
    }
    if (fd === null) {
        throw new WebAiError({
            errorCode: 'internal.unhandled',
            stage: 'session-command-lock',
            retryHint: 'retry',
            message: `web-ai session command: failed to acquire lock for ${sessionId} after ${LOCK_RETRY_LIMIT} attempts`,
        });
    }
    try {
        return await fn();
    } finally {
        try { closeSync(fd); } catch { /* already closed */ }
        try { unlinkSync(path); } catch { /* already gone */ }
    }
}

export function pruneSessions(options: PruneOptions = {}): PruneResult {
    return withStoreLock(() => {
        const store = readSessionStore();
        const cutoff = options.before
            ? Date.parse(options.before)
            : (typeof options.olderThanMs === 'number' && Number.isFinite(options.olderThanMs))
                ? Date.now() - options.olderThanMs
                : null;
        const before_count = store.sessions.length;
        store.sessions = store.sessions.filter(session => {
            const created = Date.parse(session.createdAt || '');
            if (options.status && session.status !== options.status) return true;
            if (cutoff !== null && Number.isFinite(created) && created < cutoff) return false;
            return true;
        });
        const removed = before_count - store.sessions.length;
        writeSessionStore(store);
        return { removed, remaining: store.sessions.length };
    });
}

export function loadLegacyBaselines(): unknown[] {
    const path = join(JAW_HOME, 'web-ai-baselines.json');
    if (!existsSync(path)) return [];
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { baselines?: unknown[] };
        return Array.isArray(parsed?.baselines) ? parsed.baselines : [];
    } catch {
        return [];
    }
}
