// Cross-process active-command registry (parity2 100, catalog B8).
//
// Ported subset of agbrowse web-ai/active-command-store.mjs: a file-backed
// registry of in-flight commands (heartbeat + TTL, atomic lock) so tab cleanup
// and the session doctor can see active commands from OTHER processes.
// `activeCommandTargetIds` protects their tabs from lease reclamation.

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JAW_HOME } from '../../core/config.js';

export interface ActiveCommandRow {
    commandId: string;
    status: 'running' | 'completed' | 'failed' | 'expired' | 'stale';
    command?: string;
    owner?: string;
    targetId?: string;
    sessionId?: string;
    browserProfileKey?: string;
    pid?: number;
    startedAt: string;
    heartbeatAt: string;
    expiresAt: string;
    completedAt?: string;
}

export interface ActiveCommandInput {
    commandId?: string;
    command?: string;
    owner?: string;
    targetId?: string;
    sessionId?: string;
    browserProfileKey?: string | number;
    ttlMs?: number;
    heartbeatIntervalMs?: number;
    startedAt?: string;
    heartbeatAt?: string;
    expiresAt?: string;
}

interface ActiveCommandStore { version: number; commands: ActiveCommandRow[] }

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 120_000;
const LOCK_RETRY_MS = 25;
const LOCK_RETRY_LIMIT = 200;
const STALE_LOCK_MS = 30_000;

function storePath(): string {
    return join(JAW_HOME, 'web-ai-active-commands.json');
}
function lockPath(): string {
    return `${storePath()}.lock`;
}

function readStore(): ActiveCommandStore {
    const path = storePath();
    if (!existsSync(path)) return { version: STORE_VERSION, commands: [] };
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ActiveCommandStore>;
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.commands)) {
            throw new Error(`active-command store schema-invalid at ${path}`);
        }
        return { version: STORE_VERSION, commands: parsed.commands as ActiveCommandRow[] };
    } catch (err) {
        // parity2 110 fix (final-audit F2): a corrupt store must be OBSERVED —
        // silently returning empty unprotects every running command's tab
        // (agbrowse throws active-command.store-unavailable here).
        const error = new Error(`active-command store unavailable: ${(err as Error)?.message || err}`) as Error & { code?: string };
        error.code = 'active-command.store-unavailable';
        throw error;
    }
}

function writeStore(store: ActiveCommandStore): void {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
}

function isStaleLock(path: string): boolean {
    try {
        const acquired = statSync(path).mtimeMs;
        return !Number.isFinite(acquired) || Date.now() - acquired > STALE_LOCK_MS;
    } catch {
        return true;
    }
}

async function withActiveCommandLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const path = lockPath();
    mkdirSync(dirname(path), { recursive: true });
    let attempts = 0;
    while (attempts < LOCK_RETRY_LIMIT) {
        try {
            const fd = openSync(path, 'wx');
            closeSync(fd);
            try {
                return await fn();
            } finally {
                try { unlinkSync(path); } catch { /* already gone */ }
            }
        } catch (err) {
            if ((err as { code?: string })?.code !== 'EEXIST') throw err;
            attempts += 1;
            if (isStaleLock(path)) {
                try { unlinkSync(path); } catch { /* races resolve naturally */ }
                continue;
            }
            await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
        }
    }
    throw new Error(`active-command store: failed to acquire lock at ${path} after ${LOCK_RETRY_LIMIT} attempts`);
}

function normalizeActiveCommand(input: ActiveCommandInput & { commandId: string; startedAt: string; heartbeatAt: string; expiresAt: string; status: ActiveCommandRow['status'] }): ActiveCommandRow {
    return {
        commandId: input.commandId,
        status: input.status,
        ...(input.command ? { command: input.command } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
        ...(input.targetId ? { targetId: input.targetId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.browserProfileKey !== undefined ? { browserProfileKey: String(input.browserProfileKey) } : {}),
        pid: process.pid,
        startedAt: input.startedAt,
        heartbeatAt: input.heartbeatAt,
        expiresAt: input.expiresAt,
    };
}

export class ActiveCommandTargetOwnedError extends Error {
    code = 'active-command.target-owned';
    command: ActiveCommandRow;
    constructor(conflict: ActiveCommandRow) {
        super(`target already owned by active command: ${conflict.commandId}`);
        this.command = conflict;
    }
}

export async function registerActiveCommand(input: ActiveCommandInput = {}): Promise<ActiveCommandRow> {
    const now = new Date();
    const command = normalizeActiveCommand({
        ...input,
        commandId: input.commandId || randomUUID(),
        startedAt: input.startedAt || now.toISOString(),
        heartbeatAt: input.heartbeatAt || now.toISOString(),
        expiresAt: input.expiresAt || new Date(now.getTime() + (input.ttlMs || DEFAULT_TTL_MS)).toISOString(),
        status: 'running',
    });
    return withActiveCommandLock(() => {
        const store = readStore();
        const nowMs = Date.now();
        let changed = false;
        store.commands = store.commands.map(row => {
            if (row.status !== 'running') return row;
            const expiresMs = Date.parse(row.expiresAt || '');
            if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
                changed = true;
                return { ...row, status: 'expired' as const, completedAt: new Date(nowMs).toISOString() };
            }
            return row;
        });
        if (changed) writeStore(store);
        const targetConflict = command.targetId
            ? store.commands.find(row =>
                row.status === 'running' &&
                row.targetId === command.targetId &&
                row.commandId !== command.commandId)
            : null;
        if (targetConflict) throw new ActiveCommandTargetOwnedError(targetConflict);
        store.commands = store.commands.filter(row => row.commandId !== command.commandId);
        store.commands.push(command);
        writeStore(store);
        return command;
    });
}

export async function heartbeatActiveCommand(commandId: string, { ttlMs = DEFAULT_TTL_MS }: { ttlMs?: number } = {}): Promise<ActiveCommandRow | null> {
    const now = new Date();
    return withActiveCommandLock(() => {
        const store = readStore();
        const idx = store.commands.findIndex(row => row.commandId === commandId);
        if (idx < 0) return null;
        store.commands[idx] = {
            ...store.commands[idx]!,
            heartbeatAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        };
        writeStore(store);
        return store.commands[idx]!;
    });
}

export async function releaseActiveCommand(commandId: string, status: ActiveCommandRow['status'] = 'completed'): Promise<ActiveCommandRow | null> {
    return withActiveCommandLock(() => {
        const store = readStore();
        const idx = store.commands.findIndex(row => row.commandId === commandId);
        if (idx < 0) return null;
        const updated: ActiveCommandRow = { ...store.commands[idx]!, status, completedAt: new Date().toISOString() };
        store.commands[idx] = updated;
        writeStore(store);
        return updated;
    });
}

export async function listActiveCommands(filter: { active?: boolean; targetId?: string; browserProfileKey?: string | number; owner?: string } = {}): Promise<ActiveCommandRow[]> {
    return withActiveCommandLock(() => {
        const now = Date.now();
        const store = readStore();
        let changed = false;
        let commands = store.commands.map(row => {
            if (row.status === 'running' && Date.parse(row.expiresAt || '') <= now) {
                changed = true;
                return { ...row, status: 'stale' as const };
            }
            return row;
        });
        if (changed) writeStore({ ...store, commands });
        if (filter.active === true) commands = commands.filter(row => row.status === 'running');
        if (filter.targetId) commands = commands.filter(row => row.targetId === filter.targetId);
        if (filter.browserProfileKey !== undefined) commands = commands.filter(row => row.browserProfileKey === String(filter.browserProfileKey));
        if (filter.owner) commands = commands.filter(row => row.owner === filter.owner);
        return commands;
    });
}

/** Target ids owned by RUNNING commands — lease cleanup must not reclaim these tabs. */
export async function activeCommandTargetIds(filter: { targetId?: string; browserProfileKey?: string | number; owner?: string } = {}): Promise<Set<string>> {
    const commands = await listActiveCommands({ ...filter, active: true });
    return new Set(commands.map(row => row.targetId).filter((id): id is string => Boolean(id)));
}

/** Run `fn` under a registered command with periodic heartbeats; always released. */
export async function withActiveCommand<T>(input: ActiveCommandInput, fn: (command: ActiveCommandRow) => Promise<T>): Promise<T> {
    const command = await registerActiveCommand(input);
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (input.heartbeatIntervalMs !== 0) {
        const interval = Math.max(1000, input.heartbeatIntervalMs || 15_000);
        heartbeatTimer = setInterval(() => {
            void heartbeatActiveCommand(command.commandId, { ttlMs: input.ttlMs ?? DEFAULT_TTL_MS }).catch(() => undefined);
        }, interval);
        heartbeatTimer.unref?.();
    }
    try {
        const result = await fn(command);
        await releaseActiveCommand(command.commandId, 'completed').catch(() => undefined);
        return result;
    } catch (err) {
        await releaseActiveCommand(command.commandId, 'failed').catch(() => undefined);
        throw err;
    } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
}
