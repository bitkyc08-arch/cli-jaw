import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import {
    previewGitWorktreeOperation,
    readGitWorktreeOperation,
    runGitWorktreeOperation,
    validateNewWorktreePathInsideHome,
} from '../../src/manager/git/worktree-operations.js';
import { makeDashboardTempDir } from './test-dashboard-temp.js';

function makeRepo(t: TestContext, prefix = 'worktree-ops-parent-'): string {
    const repo = mkdtempSync(join(makeDashboardTempDir(t, prefix), 'repo-'));
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
    return repo;
}

test('worktree operation preview builds git argv arrays instead of shell strings', () => {
    assert.deepEqual(
        previewGitWorktreeOperation({ type: 'worktree-add', path: '/Users/test/wt', branch: 'feature/a', createBranch: false }).command,
        ['git', 'worktree', 'add', '/Users/test/wt', 'feature/a'],
    );
    assert.deepEqual(
        previewGitWorktreeOperation({ type: 'worktree-add', path: '/Users/test/wt', branch: 'feature/a', createBranch: true }).command,
        ['git', 'worktree', 'add', '-b', 'feature/a', '/Users/test/wt'],
    );
    assert.deepEqual(
        previewGitWorktreeOperation({ type: 'worktree-remove', path: '/Users/test/wt', force: true }).command,
        ['git', 'worktree', 'remove', '--force', '/Users/test/wt'],
    );
    assert.deepEqual(previewGitWorktreeOperation({ type: 'worktree-prune' }).command, ['git', 'worktree', 'prune']);
});

test('worktree operation reader rejects invalid raw shapes and branch tokens', () => {
    assert.throws(() => readGitWorktreeOperation({}), /unknown worktree operation/);
    assert.throws(() => readGitWorktreeOperation({ type: 'worktree-add', path: '/Users/test/a', branch: '../bad', createBranch: true }), /invalid worktree branch/);
    assert.throws(() => readGitWorktreeOperation({ type: 'worktree-remove', path: '/Users/test/a', force: 'yes' }), /force must be boolean/);
    assert.deepEqual(readGitWorktreeOperation({ type: 'worktree-prune' }), { type: 'worktree-prune' });
});

test('new worktree path validation rejects symlink-parent escape targets', async (t) => {
    const link = join(makeDashboardTempDir(t, 'worktree-ops-link-parent-'), `link-${Date.now()}`);
    const outside = mkdtempSync(join(tmpdir(), 'worktree-ops-outside-'));
    symlinkSync(outside, link);

    await assert.rejects(
        validateNewWorktreePathInsideHome(join(link, 'child'), []),
        /parent symlinks are not allowed/,
    );
});

test('dirty worktree remove is blocked without explicit force', async (t) => {
    const repo = makeRepo(t);
    const worktree = mkdtempSync(join(makeDashboardTempDir(t, 'worktree-ops-linked-parent-'), 'worktree-'));
    execFileSync('git', ['worktree', 'add', '-b', 'feature-dirty', worktree], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(worktree, 'dirty.txt'), 'dirty\n');

    await assert.rejects(
        runGitWorktreeOperation(repo, { type: 'worktree-remove', path: worktree, force: false }),
        /uncommitted changes/,
    );
});
