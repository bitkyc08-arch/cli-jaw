import { ipcMain, webContents, type WebContents } from 'electron';
import type { IPty } from 'node-pty';
import { spawn as spawnPty } from 'node-pty';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { discoverShell } from './shell-discovery.js';
import { sanitizeEnv } from './env-sanitize.js';
import { isWithinHome } from '../path-security.js';
import { isAllowedSender } from '../ipc-origin-guard.js';

const MAX_SESSIONS = 8;
const BUFFER_CAP = 1024 * 1024;

type TermSession = {
    id: string;
    pty: IPty;
    buffer: string;
    seq: number;
    shell: string;
    cwd: string;
    port: number | null;
    ownerWebContentsId: number;
    cols: number;
    rows: number;
};

const sessions = new Map<string, TermSession>();
// Owner registry: exactly one destroyed-listener per webContents, and a
// central removeSession used by natural exit, kill, owner reap, and cleanup.
const ownerSessions = new Map<number, Set<string>>();
const ownersWithDestroyListener = new Set<number>();
let counter = 0;

function isAllowedCwd(cwd: string): boolean {
    if (!isWithinHome(cwd)) return false;
    try {
        return statSync(resolve(cwd)).isDirectory();
    } catch {
        return false;
    }
}

function clampDimension(value: unknown, fallback: number, min: number, max: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function clampPort(value: unknown): number | null | 'invalid' {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 65535) return 'invalid';
    return value;
}

function sendToOwner(session: TermSession, channel: string, ...args: unknown[]): void {
    const owner = webContents.fromId(session.ownerWebContentsId);
    if (!owner || owner.isDestroyed()) return;
    owner.send(channel, ...args);
}

function removeSession(id: string): void {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    const owned = ownerSessions.get(session.ownerWebContentsId);
    if (owned) {
        owned.delete(id);
        if (owned.size === 0) ownerSessions.delete(session.ownerWebContentsId);
    }
}

function trackOwner(session: TermSession, sender: WebContents): void {
    let owned = ownerSessions.get(session.ownerWebContentsId);
    if (!owned) {
        owned = new Set<string>();
        ownerSessions.set(session.ownerWebContentsId, owned);
    }
    owned.add(session.id);
    if (ownersWithDestroyListener.has(session.ownerWebContentsId)) return;
    ownersWithDestroyListener.add(session.ownerWebContentsId);
    sender.once('destroyed', () => {
        ownersWithDestroyListener.delete(session.ownerWebContentsId);
        const ownedIds = ownerSessions.get(session.ownerWebContentsId);
        if (!ownedIds) return;
        for (const sessionId of ownedIds) {
            const orphan = sessions.get(sessionId);
            try { orphan?.pty.kill(); } catch { /* ignore */ }
            removeSession(sessionId);
        }
    });
}

export function registerTerminalIpc(): void {
    ipcMain.handle('terminal:list', (event) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        return {
            ok: true,
            sessions: Array.from(sessions.values())
                .filter(session => session.ownerWebContentsId === event.sender.id)
                .map(session => ({
                    id: session.id,
                    shell: session.shell,
                    cwd: session.cwd,
                    port: session.port,
                    seq: session.seq,
                    cols: session.cols,
                    rows: session.rows,
                    buffer: session.buffer,
                })),
        };
    });

    ipcMain.handle('terminal:create', (event, opts?: { cwd?: string; cols?: number; rows?: number; port?: number | null }) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        if (sessions.size >= MAX_SESSIONS) {
            return { ok: false, error: 'max sessions reached' };
        }
        const port = clampPort(opts?.port);
        if (port === 'invalid') return { ok: false, error: 'invalid port' };
        const id = `term_${++counter}`;
        const shell = discoverShell();
        const requestedCwd = opts?.cwd;
        if (requestedCwd !== undefined && !isAllowedCwd(requestedCwd)) {
            return { ok: false, error: 'cwd not allowed' };
        }
        const cwd = requestedCwd ?? homedir();
        const env = sanitizeEnv();
        const cols = clampDimension(opts?.cols, 80, 20, 500);
        const rows = clampDimension(opts?.rows, 24, 4, 200);

        const pty = spawnPty(shell, ['-l'], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
        });

        const session: TermSession = {
            id, pty, buffer: '', seq: 0, shell, cwd,
            port, ownerWebContentsId: event.sender.id, cols, rows,
        };
        sessions.set(id, session);
        trackOwner(session, event.sender);

        pty.onData((text: string) => {
            session.seq += 1;
            session.buffer += text;
            if (session.buffer.length > BUFFER_CAP) {
                session.buffer = session.buffer.slice(-BUFFER_CAP);
            }
            sendToOwner(session, 'terminal:data', id, text, session.seq);
        });

        pty.onExit(({ exitCode }) => {
            sendToOwner(session, 'terminal:exit', id, exitCode);
            removeSession(id);
        });

        return { ok: true, id, shell, cwd };
    });

    ipcMain.handle('terminal:write', (event, id: string, data: string) => {
        if (!isAllowedSender(event)) return;
        const session = sessions.get(id);
        if (!session) return;
        if (session.ownerWebContentsId !== event.sender.id) return;
        session.pty.write(data);
    });

    ipcMain.handle('terminal:resize', (event, id: string, cols: number, rows: number) => {
        if (!isAllowedSender(event)) return;
        const session = sessions.get(id);
        if (!session) return;
        if (session.ownerWebContentsId !== event.sender.id) return;
        session.cols = clampDimension(cols, 80, 20, 500);
        session.rows = clampDimension(rows, 24, 4, 200);
        session.pty.resize(session.cols, session.rows);
    });

    ipcMain.handle('terminal:kill', (event, id: string) => {
        if (!isAllowedSender(event)) return;
        const session = sessions.get(id);
        if (!session) return;
        if (session.ownerWebContentsId !== event.sender.id) return;
        session.pty.kill();
        removeSession(id);
    });
}

export function cleanupTerminals(): void {
    for (const [id, session] of sessions) {
        try { session.pty.kill(); } catch { /* ignore */ }
        removeSession(id);
    }
}
