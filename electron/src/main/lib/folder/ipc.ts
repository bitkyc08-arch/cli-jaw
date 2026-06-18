import { ipcMain, dialog, shell, type BrowserWindow } from 'electron';
import { mkdir, readdir, rename, stat, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { isWithinHome, assertContained, assertContainedLexical } from '../path-security.js';
import { isAllowedSender } from '../ipc-origin-guard.js';
import { resolveDroppedPaths } from './dropped-paths.js';
import { moveFolderPath } from './move-path.js';
import { resolveFolderGitRoot } from '../../../../../src/manager/git/folder-root-validation.js';
import { getGitWorktrees } from '../../../../../src/manager/git/worktree-service.js';

const READ_CAP = 512 * 1024;
const DEPTH_LIMIT = 5;
const MAX_WATCHERS = 4;

const watchers = new Map<string, FSWatcher>();
let debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const pickedRoots = new Set<string>();

function isAllowedByRoot(p: string): boolean {
    if (pickedRoots.size === 0) return false;
    for (const root of pickedRoots) {
        if (assertContained(root, p)) return true;
    }
    return false;
}

function isAllowedNewPathByRoot(p: string): boolean {
    if (pickedRoots.size === 0) return false;
    for (const root of pickedRoots) {
        if (assertContainedLexical(root, p)) return true;
    }
    return false;
}

function isBinary(buf: Buffer): boolean {
    for (let i = 0; i < Math.min(buf.length, 8000); i++) {
        if (buf[i] === 0) return true;
    }
    return false;
}

function readSafeEntryName(rawName: unknown): string {
    if (typeof rawName !== 'string') throw new Error('name required');
    const name = rawName.trim();
    if (!name || name === '.' || name === '..') throw new Error('invalid name');
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) throw new Error('invalid name');
    if (basename(name) !== name) throw new Error('invalid name');
    return name;
}

function resolveDefaultRoot(): string {
    const candidates = [
        process.env.JAW_WORKSPACE_DIR,
        process.env.PWD,
        homedir(),
    ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    for (const candidate of candidates) {
        const resolved = resolve(candidate);
        try {
            const s = statSync(resolved);
            if (s.isDirectory() && isWithinHome(resolved)) return resolved;
        } catch {
            // try next candidate
        }
    }
    return homedir();
}

async function realOrResolved(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
}

export function registerFolderIpc(getWindow: () => BrowserWindow | null): void {
    // FolderPanel starts empty and must not call this on initial render.
    // It remains available for explicit cold-start callers such as DocPanel.
    ipcMain.handle('folder:getDefaultRoot', (event) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        const root = resolveDefaultRoot();
        pickedRoots.add(root);
        return { ok: true, path: root };
    });

    ipcMain.handle('folder:pick', async (event) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        const win = getWindow();
        if (!win) return { ok: false, error: 'no window' };
        const result = await dialog.showOpenDialog(win, {
            properties: ['openDirectory'],
            defaultPath: homedir(),
        });
        if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'cancelled' };
        const picked = result.filePaths[0];
        if (!isWithinHome(picked)) return { ok: false, error: 'path not allowed' };
        pickedRoots.add(resolve(picked));
        return { ok: true, path: picked };
    });

    ipcMain.handle('folder:registerGitWorktreeRoot', async (event, folderPanelRoot: string, repoRoot: string | undefined, worktreePath: string) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        try {
            const resolved = await resolveFolderGitRoot(folderPanelRoot, repoRoot);
            const target = resolve(worktreePath);
            if (!isWithinHome(target)) return { ok: false, error: 'path not allowed' };
            const ls = await lstat(target);
            if (ls.isSymbolicLink()) return { ok: false, error: 'symlinks not allowed' };
            if (!ls.isDirectory()) return { ok: false, error: 'worktree root must be a directory' };
            const targetReal = await realOrResolved(target);
            const worktrees = await getGitWorktrees(resolved.repoRoot);
            const allowed = await Promise.all(worktrees.map(async entry => realOrResolved(entry.path)));
            if (!allowed.includes(targetReal)) return { ok: false, error: 'worktree root is not registered for this repo' };
            pickedRoots.add(targetReal);
            return { ok: true, path: targetReal };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('folder:listDir', async (event, dirPath: string, _depth?: number) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        if (!isAllowedByRoot(dirPath)) return { ok: false, error: 'path not allowed — pick a folder first' };
        const resolved = resolve(dirPath);
        try {
            const names = await readdir(resolved);
            const entries = [];
            for (const name of names.slice(0, 500)) {
                if (name.startsWith('.')) continue;
                try {
                    const full = join(resolved, name);
                    const ls = await lstat(full);
                    if (ls.isSymbolicLink()) continue;
                    const s = ls;
                    entries.push({
                        name,
                        path: full,
                        kind: s.isDirectory() ? 'directory' as const : 'file' as const,
                        size: s.size,
                    });
                } catch {
                    // skip unreadable entries
                }
            }
            entries.sort((a, b) => {
                if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            return { ok: true, entries };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('folder:readFile', async (event, filePath: string) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        if (!isAllowedByRoot(filePath)) return { ok: false, error: 'path not allowed — pick a folder first' };
        try {
            const ls = await lstat(resolve(filePath));
            if (ls.isSymbolicLink()) return { ok: false, error: 'symlinks not allowed' };
        } catch {
            return { ok: false, error: 'file not accessible' };
        }
        const resolved = resolve(filePath);
        try {
            const s = await stat(resolved);
            if (s.size > READ_CAP) return { ok: true, content: '', truncated: true };
            const buf = await readFile(resolved);
            if (isBinary(buf)) return { ok: true, content: '', binary: true };
            return { ok: true, content: buf.toString('utf-8'), truncated: false, binary: false };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('folder:movePath', async (event, sourcePath: string, targetDirectory: string) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized', code: 'unauthorized' };
        return moveFolderPath(sourcePath, targetDirectory, {
            allowPath: isAllowedByRoot,
            allowDestinationPath: isAllowedNewPathByRoot,
        });
    });

    ipcMain.handle('folder:createFile', async (event, parentDirectory: string, rawName: unknown) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        try {
            if (!isAllowedByRoot(parentDirectory)) return { ok: false, error: 'path not allowed — pick a folder first' };
            const parent = resolve(parentDirectory);
            const ls = await lstat(parent);
            if (ls.isSymbolicLink() || !ls.isDirectory()) return { ok: false, error: 'parent must be a directory' };
            const name = readSafeEntryName(rawName);
            const target = join(parent, name);
            if (!isAllowedNewPathByRoot(target)) return { ok: false, error: 'path not allowed' };
            await writeFile(target, '', { flag: 'wx' });
            return { ok: true, entry: { name, path: target, kind: 'file' as const, size: 0 } };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('folder:createFolder', async (event, parentDirectory: string, rawName: unknown) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        try {
            if (!isAllowedByRoot(parentDirectory)) return { ok: false, error: 'path not allowed — pick a folder first' };
            const parent = resolve(parentDirectory);
            const ls = await lstat(parent);
            if (ls.isSymbolicLink() || !ls.isDirectory()) return { ok: false, error: 'parent must be a directory' };
            const name = readSafeEntryName(rawName);
            const target = join(parent, name);
            if (!isAllowedNewPathByRoot(target)) return { ok: false, error: 'path not allowed' };
            await mkdir(target);
            return { ok: true, entry: { name, path: target, kind: 'directory' as const, size: 0 } };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('folder:renamePath', async (event, sourcePath: string, rawName: unknown) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        try {
            if (!isAllowedByRoot(sourcePath)) return { ok: false, error: 'path not allowed — pick a folder first' };
            const source = resolve(sourcePath);
            const ls = await lstat(source);
            if (ls.isSymbolicLink()) return { ok: false, error: 'symlinks not allowed' };
            const name = readSafeEntryName(rawName);
            const target = join(dirname(source), name);
            if (target === source) return { ok: true, entry: { name, path: source, kind: ls.isDirectory() ? 'directory' as const : 'file' as const, size: ls.size } };
            if (!isAllowedNewPathByRoot(target)) return { ok: false, error: 'path not allowed' };
            await rename(source, target);
            return { ok: true, entry: { name, path: target, kind: ls.isDirectory() ? 'directory' as const : 'file' as const, size: ls.size } };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('folder:revealPath', async (event, filePath: string) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        if (!isAllowedByRoot(filePath)) return { ok: false, error: 'path not allowed — pick a folder first' };
        const resolved = resolve(filePath);
        try {
            const ls = await lstat(resolved);
            if (ls.isSymbolicLink()) return { ok: false, error: 'symlinks not allowed' };
            if (ls.isDirectory()) {
                const error = await shell.openPath(resolved);
                return error ? { ok: false, error } : { ok: true };
            }
            shell.showItemInFolder(resolved);
            return { ok: true };
        } catch {
            return { ok: false, error: 'path not accessible' };
        }
    });

    ipcMain.handle('folder:resolveDroppedItems', async (event, rawPaths: string[]) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        if (!Array.isArray(rawPaths)) return { ok: false, error: 'paths must be an array' };
        try {
            const result = await resolveDroppedPaths(rawPaths, {
                addRoot: root => pickedRoots.add(resolve(root)),
            });
            return {
                ok: result.entries.length > 0,
                entries: result.entries,
                rejected: result.rejected,
                ...(result.entries.length === 0 && result.rejected.length > 0 ? { error: result.rejected[0]?.reason } : {}),
            };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('folder:watchDir', async (event, dirPath: string) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        if (!isAllowedByRoot(dirPath)) return { ok: false, error: 'path not allowed — pick a folder first' };
        const resolved = resolve(dirPath);
        if (watchers.has(resolved)) return { ok: true };
        if (watchers.size >= MAX_WATCHERS) return { ok: false, error: 'watcher limit reached' };
        try {
            const w = watch(resolved, { recursive: false }, () => {
                const existing = debounceTimers.get(resolved);
                if (existing) clearTimeout(existing);
                debounceTimers.set(resolved, setTimeout(() => {
                    debounceTimers.delete(resolved);
                    const win = getWindow();
                    if (win && !win.isDestroyed()) {
                        win.webContents.send('folder:changed', resolved);
                    }
                }, 500));
            });
            watchers.set(resolved, w);
            return { ok: true };
        } catch {
            return { ok: false, error: 'failed to watch directory' };
        }
    });

    ipcMain.handle('folder:unwatchDir', async (event, dirPath: string) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        const resolved = resolve(dirPath);
        const w = watchers.get(resolved);
        if (w) {
            w.close();
            watchers.delete(resolved);
        }
        return { ok: true };
    });
}

export function cleanupFolderWatchers(): void {
    for (const [, w] of watchers) {
        try { w.close(); } catch { /* ignore */ }
    }
    watchers.clear();
    for (const [, t] of debounceTimers) clearTimeout(t);
    debounceTimers = new Map();
}
