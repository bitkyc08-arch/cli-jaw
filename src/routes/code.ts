// Workspace utilities shared by the native Code workbench.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { Router, RequestHandler } from 'express';
import { pickFolderNative } from '../core/folder-picker.js';
import { asyncHandler } from '../http/async-handler.js';

function realOrOriginal(path: string): string {
    try { return realpathSync(path); }
    catch { return path; }
}

/** Discover the filesystem worktree marker rather than trusting shared core.worktree. */
function worktreeRoot(cwd: string): string | null {
    let current = realOrOriginal(cwd);
    while (true) {
        if (existsSync(join(current, '.git'))) return current;
        const parent = dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

function git(cwd: string, root: string, args: string[]): Promise<string> {
    return new Promise(resolve => {
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
        env['GIT_OPTIONAL_LOCKS'] = '0';
        execFile('git', ['--work-tree', root, ...args], { cwd, env, timeout: 5_000 }, (error, stdout) => {
            resolve(error ? '' : stdout.trim());
        });
    });
}

export function registerCodeRoutes(app: Router, requireAuth: RequestHandler): void {
    app.get('/api/code/git-info', requireAuth, asyncHandler(async (req, res) => {
        const value = req.query['cwd'];
        if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || value.includes('\0')) {
            res.status(400).json({ ok: false, error: 'absolute cwd required' }); return;
        }
        const cwd = realOrOriginal(value);
        const root = worktreeRoot(cwd);
        if (!root) { res.json({ ok: true, isRepo: false, branch: null, worktrees: [] }); return; }
        const [branch, head, statusOutput, porcelain] = await Promise.all([
            git(cwd, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
            git(cwd, root, ['rev-parse', '--short', 'HEAD']),
            git(cwd, root, ['status', '--short']),
            git(cwd, root, ['worktree', 'list', '--porcelain']),
        ]);
        if (!branch) { res.json({ ok: true, isRepo: false, branch: null, worktrees: [] }); return; }
        const statusLines = statusOutput.split('\n').filter(Boolean);
        const worktrees = porcelain.split('\n\n').filter(Boolean).map(block => {
            const lines = block.split('\n');
            const path = lines.find(line => line.startsWith('worktree '))?.slice(9) ?? '';
            return { path,
                branch: lines.find(line => line.startsWith('branch '))?.slice(7).replace('refs/heads/', '') ?? null,
                head: lines.find(line => line.startsWith('HEAD '))?.slice(5) ?? null,
                current: realOrOriginal(path) === root };
        });
        const currentWorktree = worktrees.find(worktree => worktree.current);
        res.json({ ok: true, isRepo: true, repoRoot: root, relativePath: relative(root, cwd), branch, head,
            status: { dirty: statusLines.length > 0, changed: statusLines.filter(line => !line.startsWith('??')).length,
                untracked: statusLines.filter(line => line.startsWith('??')).length }, worktrees,
            ...(currentWorktree ? { currentWorktree } : {}) });
    }));

    app.post('/api/code/workspace/pick', requireAuth, asyncHandler(async (_req, res) => {
        try {
            const result = await pickFolderNative({ prompt: 'Select Code workspace folder' });
            switch (result.status) {
                case 'picked': res.json({ ok: true, path: result.path }); return;
                case 'cancelled': res.json({ ok: true, cancelled: true }); return;
                case 'busy': res.status(409).json({ ok: false, error: 'folder picker busy' }); return;
                case 'unavailable': res.status(503).json({ ok: false, error: result.reason }); return;
            }
        } catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }));
}
