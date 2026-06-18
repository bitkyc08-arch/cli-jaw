import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseGitWorktreePorcelain } from '../../src/manager/git/worktree-service.js';
import { makeDashboardTempDir } from './test-dashboard-temp.js';

const repoRoot = join(homedir(), 'repo');

test('git worktree parser maps branch, detached, locked, prunable, bare, and current states', () => {
    const linked = join(homedir(), 'repo-feature');
    const detached = join(homedir(), 'repo-detached');
    const parsed = parseGitWorktreePorcelain(repoRoot, [
        `worktree ${repoRoot}`,
        'HEAD abc1234',
        'branch refs/heads/main',
        '',
        `worktree ${linked}`,
        'HEAD def5678',
        'branch refs/heads/feature/a',
        'locked needs migration',
        '',
        `worktree ${detached}`,
        'HEAD feedbee',
        'detached',
        'prunable stale admin entry',
        '',
        `worktree ${join(homedir(), 'repo-bare')}`,
        'bare',
        '',
    ].join('\n'));

    assert.equal(parsed.length, 4);
    assert.equal(parsed[0]?.path, repoRoot);
    assert.equal(parsed[0]?.branch, 'main');
    assert.equal(parsed[0]?.current, true);
    assert.equal(parsed[1]?.branch, 'feature/a');
    assert.equal(parsed[1]?.locked, true);
    assert.equal(parsed[1]?.reason, 'needs migration');
    assert.equal(parsed[2]?.detached, true);
    assert.equal(parsed[2]?.prunable, true);
    assert.equal(parsed[2]?.reason, 'stale admin entry');
    assert.equal(parsed[3]?.bare, true);
});

test('git worktree parser filters linked worktree paths outside home', () => {
    const parsed = parseGitWorktreePorcelain(repoRoot, [
        `worktree ${repoRoot}`,
        'HEAD abc1234',
        'branch refs/heads/main',
        '',
        'worktree /tmp/outside-home-worktree',
        'HEAD badbad',
        'branch refs/heads/outside',
        '',
    ].join('\n'));

    assert.deepEqual(parsed.map(entry => entry.path), [repoRoot]);
});

test('git worktree service uses porcelain worktree list through runGit arguments', () => {
    const source = readFileSync(join(import.meta.dirname, '..', '..', 'src/manager/git/worktree-service.ts'), 'utf8');

    assert.ok(source.includes("runGit(['worktree', 'list', '--porcelain'], repoRoot)"), 'worktree service must use argument arrays, not shell strings');
    assert.ok(source.includes('if (!isWithinHome(repoRoot))'), 'worktree service must guard repoRoot before running git');
    assert.ok(source.includes('!isWithinHome(entry.path)'), 'worktree service must filter outside-home worktree entries');
});

test('git worktree parser tolerates empty porcelain output', (t) => {
    const homeRepo = mkdtempSync(join(makeDashboardTempDir(t, 'empty-worktree-parent-'), 'repo-'));

    assert.deepEqual(parseGitWorktreePorcelain(homeRepo, ''), []);
});
