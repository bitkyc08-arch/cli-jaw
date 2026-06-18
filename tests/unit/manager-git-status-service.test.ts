import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitStatusPorcelain, readGitStatusMapOptions } from '../../src/manager/git/status-service.js';

const repoRoot = '/Users/test/repo';

test('git status parser maps staged, unstaged, untracked, ignored, conflict, and rename states', () => {
    const parsed = parseGitStatusPorcelain(repoRoot, [
        'M  staged.ts',
        ' M unstaged.ts',
        'A  added.ts',
        ' D deleted.ts',
        '?? new.ts',
        '!! ignored.log',
        'UU conflict.ts',
        'R  renamed-old.ts',
        'renamed-new.ts',
        '',
    ].join('\0'));

    const byPath = new Map(parsed.files.map(file => [file.repoRelativePath, file]));
    assert.equal(byPath.get('staged.ts')?.kind, 'modified');
    assert.equal(byPath.get('staged.ts')?.staged, true);
    assert.equal(byPath.get('unstaged.ts')?.unstaged, true);
    assert.equal(byPath.get('added.ts')?.kind, 'added');
    assert.equal(byPath.get('deleted.ts')?.kind, 'deleted');
    assert.equal(byPath.get('new.ts')?.kind, 'untracked');
    assert.equal(byPath.get('ignored.log')?.ignored, true);
    assert.equal(byPath.get('conflict.ts')?.conflict, true);
    assert.equal(byPath.get('renamed-new.ts')?.kind, 'renamed');
    assert.equal(byPath.has('renamed-old.ts'), false, 'rename source path must be consumed as metadata');
    assert.equal(parsed.dirty, true);
});

test('git status parser creates directory aggregate decorations', () => {
    const parsed = parseGitStatusPorcelain(repoRoot, [
        ' M src/a.ts',
        '?? src/nested/b.ts',
        '',
    ].join('\0'));

    const byPath = new Map(parsed.directories.map(directory => [directory.repoRelativePath, directory]));
    assert.equal(byPath.get('src')?.changedCount, 2);
    assert.deepEqual(byPath.get('src')?.kinds, ['modified', 'untracked']);
    assert.equal(byPath.get('src/nested')?.changedCount, 1);
    assert.deepEqual(byPath.get('src/nested')?.kinds, ['untracked']);
});

test('git status option reader defaults to full FolderPanel visibility', () => {
    assert.deepEqual(readGitStatusMapOptions(undefined), { includeIgnored: true, includeUntracked: true });
    assert.deepEqual(readGitStatusMapOptions({ includeIgnored: false }), { includeIgnored: false, includeUntracked: true });
    assert.deepEqual(readGitStatusMapOptions({ includeUntracked: false }), { includeIgnored: true, includeUntracked: false });
});
