import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getProjectGitSummary,
    parseProjectGitStatusPorcelain,
    readPrimaryProjectRoot,
} from '../../src/project-git-summary.ts';
import { formatProjectGitSummary, type ProjectGitSummary } from '../../public/js/features/project-git-status.ts';

test('project git status parser counts tracked changes and untracked files', () => {
    const output = [
        ' M src/a.ts',
        'A  src/b.ts',
        '?? notes/todo.md',
        '!! ignored.log',
        'R  src/new.ts',
        'src/old.ts',
        '',
    ].join('\0');

    assert.deepEqual(parseProjectGitStatusPorcelain(output), {
        trackedChangedCount: 3,
        untrackedCount: 1,
    });
});

test('project git summary reads primary project dir only', () => {
    assert.equal(readPrimaryProjectRoot(null), null);
    assert.equal(readPrimaryProjectRoot([]), null);
    assert.equal(readPrimaryProjectRoot(['  ', '/repo', '/other']), '/repo');
});

test('project git summary quietly hides missing project dirs', async () => {
    const summary = await getProjectGitSummary(null, async () => {
        throw new Error('runner should not be called');
    });
    assert.deepEqual(summary, { ok: true, available: false, reason: 'no-project' });
});

test('project git summary rejects repo roots outside the home guard', async () => {
    const summary = await getProjectGitSummary([process.cwd()], async (_cwd, args) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/tmp/outside-repo';
        return '';
    });
    assert.deepEqual(summary, { ok: true, available: false, reason: 'not-repo' });
});

test('project git header formatter locks compact display contract', () => {
    const summary: ProjectGitSummary = {
        ok: true,
        available: true,
        root: '/Users/jun/project',
        repoRoot: '/Users/jun/project',
        branch: 'dev',
        head: 'abc1234',
        trackedChangedCount: 12,
        untrackedCount: 3,
        dirty: true,
    };

    assert.deepEqual(formatProjectGitSummary(summary), {
        text: '/ ⑂ dev *12 ?3',
        title: 'Git: branch dev, 12 tracked changes, 3 untracked files',
    });
});

test('project git header formatter supports branch-only and detached refs', () => {
    assert.equal(formatProjectGitSummary({
        ok: true,
        available: true,
        root: '/Users/jun/project',
        repoRoot: '/Users/jun/project',
        branch: 'agent',
        head: 'abc1234',
        trackedChangedCount: 0,
        untrackedCount: 0,
        dirty: false,
    })?.text, '/ ⑂ agent');

    assert.equal(formatProjectGitSummary({
        ok: true,
        available: true,
        root: '/Users/jun/project',
        repoRoot: '/Users/jun/project',
        branch: null,
        head: 'abc1234',
        trackedChangedCount: 2,
        untrackedCount: 0,
        dirty: true,
    })?.text, '/ ⑂ abc1234 *2');
});

test('project git header formatter hides unavailable or empty refs', () => {
    assert.equal(formatProjectGitSummary({ ok: true, available: false, reason: 'not-repo' }), null);
    assert.equal(formatProjectGitSummary({
        ok: true,
        available: true,
        root: '/Users/jun/project',
        repoRoot: '/Users/jun/project',
        branch: null,
        head: null,
        trackedChangedCount: 1,
        untrackedCount: 1,
        dirty: true,
    }), null);
});
