import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDashboardGitRouter } from '../../src/manager/routes/dashboard-git.js';
import { makeDashboardTempDir } from './test-dashboard-temp.js';
import type { TestContext } from 'node:test';

async function withGitServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    const server = http.createServer(app);
    app.use(express.json());
    app.use('/api/dashboard/git', createDashboardGitRouter({
        resolveInstance: async () => null,
    }));

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        assert.equal(typeof address, 'object');
        assert.ok(address);
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
}

function makeRepo(t: TestContext): string {
    const repo = mkdtempSync(join(makeDashboardTempDir(t, 'dashboard-worktrees-parent-'), 'repo-'));
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    return repo;
}

test('dashboard git worktrees route resolves from FolderPanel root without selected instance candidates', async (t) => {
    const repo = makeRepo(t);

    await withGitServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/dashboard/git/worktrees`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ folderPanelRoot: repo }),
        });
        assert.equal(response.status, 200);
        const body = await response.json() as { ok: boolean; repoRoot: string; worktrees: Array<{ path: string; current: boolean }> };
        assert.equal(body.ok, true);
        assert.equal(body.repoRoot, repo);
        assert.ok(body.worktrees.some(entry => entry.path === repo && entry.current), 'current repo must appear in worktree list');
    });
});

test('dashboard git worktrees route rejects repoRoot mismatches', async (t) => {
    const repo = makeRepo(t);
    const other = makeRepo(t);

    await withGitServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/dashboard/git/worktrees`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ folderPanelRoot: repo, repoRoot: other }),
        });
        assert.equal(response.status, 400);
        const body = await response.json() as { ok: boolean; error: string };
        assert.equal(body.ok, false);
        assert.match(body.error, /repo root mismatch/);
    });
});

test('dashboard git worktrees route uses FolderPanel root validation, not selected-instance validation', () => {
    const source = readFileSync(join(import.meta.dirname, '..', '..', 'src/manager/routes/dashboard-git.ts'), 'utf8');
    const worktreesRoute = source.slice(source.indexOf("router.post('/worktrees'"));

    assert.ok(source.includes("router.post('/worktrees'"), 'dashboard git router must expose worktrees route');
    assert.ok(worktreesRoute.includes('resolveFolderGitRoot(folderPanelRoot, repoRoot)'), 'worktrees route must validate FolderPanel root directly');
    assert.ok(worktreesRoute.includes('getGitWorktrees(resolved.repoRoot)'), 'worktrees route must call the read-only worktree service');
    assert.equal(worktreesRoute.includes('validateRepoRoot'), false, 'worktrees route must not reuse selected-instance candidate validation');
});
