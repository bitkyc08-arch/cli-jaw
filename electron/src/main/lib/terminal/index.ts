import { ipcMain, type BrowserWindow } from 'electron';
import type { IPty } from 'node-pty';
import { spawn as spawnPty } from 'node-pty';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
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
    shell: string;
    cwd: string;
    cols: number;
    rows: number;
};

const sessions = new Map<string, TermSession>();
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

export function registerTerminalIpc(getWindow: () => BrowserWindow | null): void {
    ipcMain.handle('terminal:list', (event) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        return {
            ok: true,
            sessions: Array.from(sessions.values()).map(session => ({
                id: session.id,
                shell: session.shell,
                cwd: session.cwd,
                cols: session.cols,
                rows: session.rows,
                buffer: session.buffer,
            })),
        };
    });

    ipcMain.handle('terminal:create', (event, opts?: { cwd?: string; cols?: number; rows?: number }) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        if (sessions.size >= MAX_SESSIONS) {
            return { ok: false, error: 'max sessions reached' };
        }
        const id = `term_${++counter}`;
        const shell = discoverShell();
        let cwd = opts?.cwd ?? homedir();
        if (!isAllowedCwd(cwd) || !existsSync(cwd)) cwd = homedir();
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

        const session: TermSession = { id, pty, buffer: '', shell, cwd, cols, rows };
        sessions.set(id, session);

        pty.onData((text: string) => {
            session.buffer += text;
            if (session.buffer.length > BUFFER_CAP) {
                session.buffer = session.buffer.slice(-BUFFER_CAP);
            }
            const win = getWindow();
            if (win && !win.isDestroyed()) {
                win.webContents.send('terminal:data', id, text);
            }
        });

        pty.onExit(({ exitCode }) => {
            sessions.delete(id);
            const win = getWindow();
            if (win && !win.isDestroyed()) {
                win.webContents.send('terminal:exit', id, exitCode);
            }
        });

        return { ok: true, id, shell, cwd };
    });

    ipcMain.handle('terminal:write', (event, id: string, data: string) => {
        if (!isAllowedSender(event)) return;
        const session = sessions.get(id);
        if (!session) return;
        session.pty.write(data);
    });

    ipcMain.handle('terminal:resize', (event, id: string, cols: number, rows: number) => {
        if (!isAllowedSender(event)) return;
        const session = sessions.get(id);
        if (!session) return;
        session.cols = clampDimension(cols, 80, 20, 500);
        session.rows = clampDimension(rows, 24, 4, 200);
        session.pty.resize(session.cols, session.rows);
    });

    ipcMain.handle('terminal:kill', (event, id: string) => {
        if (!isAllowedSender(event)) return;
        const session = sessions.get(id);
        if (!session) return;
        session.pty.kill();
        sessions.delete(id);
    });
}

export function cleanupTerminals(): void {
    for (const [, session] of sessions) {
        try { session.pty.kill(); } catch { /* ignore */ }
    }
    sessions.clear();
}
