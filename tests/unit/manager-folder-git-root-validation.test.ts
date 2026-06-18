import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFolderGitRoot } from '../../src/manager/git/folder-root-validation.js';
import { makeDashboardTempDir } from './test-dashboard-temp.js';
import type { TestContext } from 'node:test';

function makeRepo(t: TestContext): string {
    const repo = mkdtempSync(join(makeDashboardTempDir(t, 'folder-git-root-parent-'), 'repo-'));
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    return repo;
}

test('folder git root validation resolves a home-contained repo root', async (t) => {
    const repo = makeRepo(t);
    mkdirSync(join(repo, 'nested'));

    const resolved = await resolveFolderGitRoot(join(repo, 'nested'), repo);

    assert.equal(resolved.repoRoot, repo);
    assert.equal(resolved.folderPanelRoot, join(repo, 'nested'));
});

test('folder git root validation rejects non-git folders quietly', async (t) => {
    const folder = mkdtempSync(join(makeDashboardTempDir(t, 'folder-non-git-parent-'), 'folder-'));

    await assert.rejects(
        async () => resolveFolderGitRoot(folder),
        /not a git repository/,
    );
});

test('folder git root validation rejects outside-home roots and mismatched repo roots', async (t) => {
    const repo = makeRepo(t);
    const otherRepo = makeRepo(t);

    await assert.rejects(
        async () => resolveFolderGitRoot('/'),
        /folder root is outside home/,
    );
    await assert.rejects(
        async () => resolveFolderGitRoot(repo, otherRepo),
        /repo root mismatch/,
    );
});
