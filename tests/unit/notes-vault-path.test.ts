import test from 'node:test';
import assert from 'node:assert/strict';
import { isNotesVaultPath, normalizeNotesVaultPath } from '../../public/js/render/notes-vault-path.ts';

const notesRoot = '/Users/jun/.cli-jaw-dashboard/notes';

test('normalizeNotesVaultPath accepts relative markdown paths', () => {
    assert.equal(normalizeNotesVaultPath('daily/foo.md', notesRoot), 'daily/foo.md');
    assert.equal(normalizeNotesVaultPath('projects/plan.md', notesRoot), 'projects/plan.md');
});

test('normalizeNotesVaultPath rejects reserved top-level segments', () => {
    assert.equal(normalizeNotesVaultPath('_templates/foo.md', notesRoot), null);
    assert.equal(normalizeNotesVaultPath('.git/leak.md', notesRoot), null);
});

test('normalizeNotesVaultPath accepts absolute paths under notesRoot', () => {
    assert.equal(
        normalizeNotesVaultPath('/Users/jun/.cli-jaw-dashboard/notes/daily/foo.md', notesRoot),
        'daily/foo.md',
    );
});

test('normalizeNotesVaultPath expands tilde paths under notesRoot', () => {
    assert.equal(
        normalizeNotesVaultPath('~/.cli-jaw-dashboard/notes/daily/foo.md', notesRoot),
        'daily/foo.md',
    );
});

test('normalizeNotesVaultPath rejects paths outside notesRoot', () => {
    assert.equal(normalizeNotesVaultPath('/Users/jun/project/foo.ts', notesRoot), null);
    assert.equal(normalizeNotesVaultPath('/tmp/other.md', notesRoot), null);
});

test('normalizeNotesVaultPath rejects relative paths when notesRoot is null', () => {
    assert.equal(normalizeNotesVaultPath('profile.md', null), null);
    assert.equal(normalizeNotesVaultPath('daily/foo.md', null), null);
    assert.equal(normalizeNotesVaultPath('SKILL.md', null), null);
});

test('isNotesVaultPath mirrors normalizeNotesVaultPath', () => {
    assert.equal(isNotesVaultPath('daily/foo.md', notesRoot), true);
    assert.equal(isNotesVaultPath('/Users/jun/project/foo.ts', notesRoot), false);
});
