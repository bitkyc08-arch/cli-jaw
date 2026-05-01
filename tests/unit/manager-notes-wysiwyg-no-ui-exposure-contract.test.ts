import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const projectRoot = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('WYSIWYG is exposed only as an authoring mode, not a Notes view mode', () => {
    const notesTypes = read('public/manager/src/notes/notes-types.ts');
    const publicTypes = read('public/manager/src/types.ts');
    const toolbar = read('public/manager/src/notes/NotesToolbar.tsx');
    const app = read('public/manager/src/App.tsx');
    const workspace = read('public/manager/src/notes/NotesWorkspace.tsx');
    const editor = read('public/manager/src/notes/MarkdownEditor.tsx');

    assert.ok(notesTypes.includes("export type NotesAuthoringMode = 'plain' | 'rich' | 'wysiwyg';"));
    assert.ok(notesTypes.includes("export type NotesViewMode = 'raw' | 'split' | 'preview' | 'settings';"));
    assert.ok(publicTypes.includes("export type DashboardNotesAuthoringMode = 'plain' | 'rich' | 'wysiwyg';"));
    assert.ok(toolbar.includes("const AUTHORING_MODES: NotesAuthoringMode[] = ['plain', 'rich', 'wysiwyg'];"));
    assert.ok(toolbar.includes('WYSIWYG'));
    assert.ok(app.includes('notesAuthoringMode'), 'App must persist authoring mode through the existing UI registry');
    assert.ok(workspace.includes('authoringMode={props.authoringMode}'), 'Workspace must route authoring mode without adding a view tab');
    assert.ok(editor.includes("props.authoringMode === 'wysiwyg'"), 'Editor must own the WYSIWYG authoring surface');
});
