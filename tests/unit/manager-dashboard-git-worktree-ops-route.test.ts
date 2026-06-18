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
    const repo = mkdtempSync(join(makeDashboardTempDir(t, 'dashboard-worktree-ops-parent-'), 'repo-'));
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    return repo;
}

test('dashboard git worktree operation preview validates FolderPanel context', async (t) => {
    const repo = makeRepo(t);
    const target = join(makeDashboardTempDir(t, 'dashboard-worktree-ops-target-parent-'), `target-${Date.now()}`);

    await withGitServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/dashboard/git/worktree-operation-preview`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                folderPanelRoot: repo,
                operation: { type: 'worktree-add', path: target, branch: 'feature-preview', createBranch: true },
            }),
        });
        assert.equal(response.status, 200);
        const body = await response.json() as { ok: boolean; preview: { command: string[] } };
        assert.equal(body.ok, true);
        assert.deepEqual(body.preview.command, ['git', 'worktree', 'add', '-b', 'feature-preview', target]);
    });
});

test('dashboard git worktree operation execution requires explicit confirmation', async (t) => {
    const repo = makeRepo(t);

    await withGitServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/dashboard/git/worktree-operation`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                folderPanelRoot: repo,
                operation: { type: 'worktree-prune' },
                confirmed: false,
            }),
        });
        assert.equal(response.status, 400);
        const body = await response.json() as { ok: boolean; error: string };
        assert.equal(body.ok, false);
        assert.match(body.error, /confirmation required/);
    });
});

test('dashboard git worktree operation routes parse raw operations before execution', () => {
    const source = readFileSync(join(import.meta.dirname, '..', '..', 'src/manager/routes/dashboard-git.ts'), 'utf8');
    const previewRoute = source.slice(source.indexOf("router.post('/worktree-operation-preview'"));
    const runRoute = source.slice(source.indexOf("router.post('/worktree-operation'"));

    assert.ok(previewRoute.includes('readGitWorktreeOperation'), 'preview route must parse raw operation');
    assert.ok(previewRoute.includes('validateGitWorktreeOperationPreviewContext'), 'preview route must validate FolderPanel preview context');
    assert.ok(runRoute.includes("input['confirmed'] !== true"), 'execution route must require confirmation');
    assert.ok(runRoute.includes('runGitWorktreeOperation(resolved.repoRoot, operation)'), 'execution route must call typed operation service');
});
