import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('Notes authoring mode is separate from Notes view mode', () => {
    const notesTypes = read('public/manager/src/notes/notes-types.ts');
    const publicTypes = read('public/manager/src/types.ts');
    const serverTypes = read('src/manager/types.ts');
    const registry = read('src/manager/registry.ts');

    assert.ok(notesTypes.includes("export type NotesViewMode = 'raw' | 'split' | 'preview' | 'settings';"),
        'NotesViewMode must not include rich');
    assert.ok(notesTypes.includes("export type NotesAuthoringMode = 'plain' | 'rich' | 'wysiwyg';"),
        'NotesAuthoringMode must exist separately');
    assert.ok(publicTypes.includes("export type DashboardNotesAuthoringMode = 'plain' | 'rich' | 'wysiwyg';"),
        'frontend registry type must include authoring mode');
    assert.ok(serverTypes.includes("export type DashboardNotesAuthoringMode = 'plain' | 'rich' | 'wysiwyg';"),
        'server registry type must include authoring mode');
    assert.ok(registry.includes('NOTES_AUTHORING_MODES'), 'registry must validate authoring mode');
    assert.ok(registry.includes("notesAuthoringMode: 'plain'"), 'registry default must be plain authoring');
});

test('Notes toolbar exposes Plain/Rich authoring independently from layout tabs', () => {
    const toolbar = read('public/manager/src/notes/NotesToolbar.tsx');
    const app = read('public/manager/src/App.tsx');
    const workspace = read('public/manager/src/notes/NotesWorkspace.tsx');

    assert.ok(toolbar.includes("const VIEW_MODES: NotesViewMode[] = ['raw', 'split', 'preview', 'settings'];"),
        'Rich must not be a view tab');
    assert.ok(toolbar.includes("const AUTHORING_MODES: NotesAuthoringMode[] = ['plain', 'rich', 'wysiwyg'];"),
        'toolbar must expose authoring modes separately');
    assert.ok(toolbar.includes('aria-label="Notes authoring mode"'), 'authoring control must be accessible');
    assert.ok(toolbar.includes('authoringModeLabel'), 'authoring labels must be explicit');
    assert.ok(app.includes('handleNotesAuthoringModeChange'), 'App must persist authoring mode changes');
    assert.ok(workspace.includes('authoringMode={props.authoringMode}'), 'workspace must pass authoring mode to the editor');
});

test('Rich markdown files reuse the shared renderer and avoid renderer dependency duplication', () => {
    [
        'public/manager/src/notes/rich-markdown/rich-markdown-types.ts',
        'public/manager/src/notes/rich-markdown/scan-markdown-tree.ts',
        'public/manager/src/notes/rich-markdown/rich-markdown-state.ts',
        'public/manager/src/notes/rich-markdown/rich-markdown-extension.ts',
        'public/manager/src/notes/rich-markdown/rich-widget.ts',
        'public/manager/src/notes/rich-markdown/RichMarkdownPortalHost.tsx',
        'public/manager/src/notes/rich-markdown/paste-policy.ts',
    ].forEach(path => {
        assert.equal(existsSync(join(projectRoot, path)), true, `${path} must exist`);
    });

    const portal = read('public/manager/src/notes/rich-markdown/RichMarkdownPortalHost.tsx');
    const extension = read('public/manager/src/notes/rich-markdown/rich-markdown-extension.ts');
    const state = read('public/manager/src/notes/rich-markdown/rich-markdown-state.ts');
    const richFiles = [
        portal,
        extension,
        state,
        read('public/manager/src/notes/rich-markdown/rich-widget.ts'),
        read('public/manager/src/notes/rich-markdown/scan-markdown-tree.ts'),
        read('public/manager/src/notes/rich-markdown/paste-policy.ts'),
    ].join('\n');

    assert.ok(portal.includes('MarkdownRenderer'), 'rich widgets must render through the shared MarkdownRenderer');
    assert.ok(state.includes('StateField.define<DecorationSet>'), 'rich decorations must use a StateField<DecorationSet>');
    assert.ok(extension.includes('Decoration.replace'), 'rich widgets must be direct replacement decorations');
    [
        "from 'mermaid'", "import('mermaid')", "from 'katex'", "from 'highlight.js'",
        'ReactMarkdown', 'rehypeRaw', 'rehypeKatex', 'rehypeSanitize',
        'remarkMath', 'dangerouslySetInnerHTML',
    ].forEach(forbidden => {
        assert.equal(richFiles.includes(forbidden), false, `rich layer must not import or use ${forbidden}`);
    });
});

test('Rich markdown scanner and paste policy keep unsafe or ambiguous input raw', () => {
    const scanner = read('public/manager/src/notes/rich-markdown/scan-markdown-tree.ts');
    const paste = read('public/manager/src/notes/rich-markdown/paste-policy.ts');

    assert.ok(scanner.includes('maxMermaidWidgets'), 'scanner must cap Mermaid widgets');
    assert.ok(scanner.includes('largeNoteDisableThreshold'), 'scanner must disable rich widgets for large notes');
    assert.ok(scanner.includes('intersectsSelection'), 'scanner must reveal source for active selection ranges');
    assert.ok(scanner.includes('^```'), 'scanner must detect fenced code blocks');
    assert.ok(scanner.includes('math-block'), 'scanner must detect block math');
    assert.ok(scanner.includes('math-inline'), 'scanner must detect inline math');
    assert.ok(paste.includes("getData('text/plain')"), 'paste policy must prefer text/plain');
    assert.ok(paste.includes("getData('text/html')"), 'paste policy must handle HTML-only paste');
    assert.equal(paste.includes('innerHTML = html'), true, 'HTML-only paste must be converted through inert template text extraction');
});
