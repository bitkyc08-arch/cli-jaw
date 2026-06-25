import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JAW_HOME } from '../../core/config.js';
import { WebAiError } from './errors.js';

/**
 * Cross-process watcher session lock (parity catalog 104.3). cli-jaw's watcher used an
 * in-process Map only, so two separate processes could both watch (and double-finalize) the
 * same session. This adds an atomic `mkdir` lock dir under JAW_HOME with a heartbeat +
 * PID-liveness staleness check. Strict-TS port of agbrowse watcher.mjs lock helpers.
 */

export const DEFAULT_WATCH_LOCK_STALE_MS = 5 * 60_000;

interface WatcherLockMetadata {
    sessionId: string;
    pid: number;
    startedAt?: string;
    heartbeatAt?: string;
    [key: string]: unknown;
}

export interface WatcherSessionLock {
    lockPath: string;
    heartbeat: (extra?: Record<string, unknown>) => void;
    release: () => void;
}

function watcherHome(): string {
    return join(JAW_HOME, 'web-ai-watchers');
}

function watcherLockPath(sessionId: string): string {
    return join(watcherHome(), `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`);
}

function writeWatcherLockMetadata(dir: string, metadata: WatcherLockMetadata): void {
    writeFileSync(join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

function readWatcherLockMetadata(dir: string): WatcherLockMetadata | null {
    try {
        if (!existsSync(join(dir, 'metadata.json'))) return null;
        return JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as WatcherLockMetadata;
    } catch {
        return null;
    }
}

/** True if the process is alive (or exists but not ours: EPERM). */
function pidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as { code?: string })?.code === 'EPERM';
    }
}

export function isWatcherLockStale(metadata: WatcherLockMetadata | null, staleMs: number): boolean {
    if (!metadata) return true;
    if (!pidAlive(Number(metadata.pid))) return true;
    const heartbeat = Date.parse(metadata.heartbeatAt || metadata.startedAt || '');
    return Number.isFinite(heartbeat) && Date.now() - heartbeat > staleMs;
}

/**
 * Acquire an exclusive cross-process lock for a watcher session. Throws
 * `watcher.already-running` when a live, non-stale watcher already holds it.
 */
export function acquireWatcherSessionLock(
    sessionId: string,
    { staleMs = DEFAULT_WATCH_LOCK_STALE_MS }: { staleMs?: number } = {},
): WatcherSessionLock {
    const dir = watcherLockPath(sessionId);
    mkdirSync(watcherHome(), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            mkdirSync(dir); // atomic: throws EEXIST if another process holds the lock
            writeWatcherLockMetadata(dir, {
                sessionId,
                pid: process.pid,
                startedAt: new Date().toISOString(),
                heartbeatAt: new Date().toISOString(),
            });
            return {
                lockPath: dir,
                heartbeat(extra = {}) {
                    writeWatcherLockMetadata(dir, {
                        sessionId,
                        pid: process.pid,
                        heartbeatAt: new Date().toISOString(),
                        ...extra,
                    });
                },
                release() {
                    rmSync(dir, { recursive: true, force: true });
                },
            };
        } catch (err) {
            if ((err as { code?: string })?.code !== 'EEXIST') throw err;
            const existing = readWatcherLockMetadata(dir);
            if (isWatcherLockStale(existing, staleMs)) {
                rmSync(dir, { recursive: true, force: true });
                continue; // retry: the previous holder is dead/stale
            }
            throw new WebAiError({
                errorCode: 'watcher.already-running',
                stage: 'watcher-lock',
                retryHint: 'reuse-existing-watcher-or-remove-stale-lock',
                message: `a watcher is already running for session ${sessionId}`,
                ...(existing ? { evidence: existing } : {}),
            });
        }
    }
    throw new WebAiError({
        errorCode: 'watcher.already-running',
        stage: 'watcher-lock',
        retryHint: 'retry',
        message: `could not acquire watcher lock for session ${sessionId}`,
    });
}
