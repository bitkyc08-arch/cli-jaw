import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DashboardApiError } from '../../public/manager/src/api';
import {
    canSaveNote,
    isRevisionConflict,
    noteDisplayName,
} from '../../public/manager/src/notes/note-revisions';

test('canSaveNote requires a selected dirty note that is not saving', () => {
    assert.equal(canSaveNote('daily/today.md', true, false), true);
    assert.equal(canSaveNote(null, true, false), false);
    assert.equal(canSaveNote('daily/today.md', false, false), false);
    assert.equal(canSaveNote('daily/today.md', true, true), false);
});

test('stale revision API errors are detected as note conflicts', () => {
    const conflict = new DashboardApiError('note changed since it was loaded', 409, 'note_revision_conflict');
    const other = new DashboardApiError('bad path', 400, 'invalid_note_path');

    assert.equal(isRevisionConflict(conflict), true);
    assert.equal(isRevisionConflict(other), false);
    assert.equal(isRevisionConflict(new Error('note_revision_conflict')), false);
});

test('noteDisplayName derives compact labels from note paths', () => {
    assert.equal(noteDisplayName('daily/today.md'), 'today.md');
    assert.equal(noteDisplayName(null), 'No note selected');
});
