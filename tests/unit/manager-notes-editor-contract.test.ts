import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('Markdown editor uses CodeMirror markdown with language data', () => {
    const editor = read('public/manager/src/notes/MarkdownEditor.tsx');

    assert.ok(editor.includes("@uiw/react-codemirror"), 'editor must use @uiw/react-codemirror');
    assert.ok(editor.includes('@codemirror/lang-markdown'), 'editor must import markdown extension');
    assert.ok(editor.includes('@codemirror/language-data'), 'editor must wire CodeMirror language data');
    assert.ok(editor.includes('markdown({ codeLanguages: languages })'), 'markdown mode must receive language data');
});

test('Markdown editor wires Markdown shortcut keymap with highest precedence', () => {
    const editor = read('public/manager/src/notes/MarkdownEditor.tsx');
    const shortcuts = read('public/manager/src/notes/markdown-shortcuts.ts');

    assert.ok(editor.includes("from './markdown-shortcuts'"),
        'MarkdownEditor must import the shared shortcuts keymap');
    assert.ok(editor.includes('Prec.highest(keymap.of(markdownShortcutsKeymap))'),
        'shortcut keymap must override defaultKeymap (Mod-i selectParentSyntax) via Prec.highest');
    assert.ok(shortcuts.includes("key: 'Mod-b'"), 'Mod+B must be bound for bold');
    assert.ok(shortcuts.includes("key: 'Mod-i'"), 'Mod+I must be bound for italic');
    assert.ok(shortcuts.includes("key: 'Mod-e'"), 'Mod+E must be bound for inline code');
    assert.ok(shortcuts.includes("key: 'Mod-k'"), 'Mod+K must be bound for link insertion');
    assert.ok(shortcuts.includes("wrapSelection('**')"), 'bold binding must wrap selection with **');
    assert.ok(shortcuts.includes("wrapSelection('*')"), 'italic binding must wrap selection with *');
    assert.ok(shortcuts.includes("wrapSelection('`')"), 'inline code binding must wrap selection with backticks');
    assert.ok(shortcuts.includes('insertLink'), 'link binding must run insertLink');
    assert.ok(shortcuts.includes('preventDefault: true'), 'shortcut bindings must preventDefault to suppress browser handlers');
    assert.ok(shortcuts.includes('prefixSelectedLines'), 'WYSIWYG toolbar must be able to prefix selected Markdown lines');
    assert.ok(shortcuts.includes('insertCodeFence'), 'WYSIWYG toolbar must be able to insert fenced code blocks');
});

test('Markdown editor exposes WYSIWYG toolbar without changing the save path', () => {
    const editor = read('public/manager/src/notes/MarkdownEditor.tsx');
    const workspace = read('public/manager/src/notes/NotesWorkspace.tsx');
    const milkdown = read('public/manager/src/notes/wysiwyg/MilkdownWysiwygEditor.tsx');
    const mathPlugin = read('public/manager/src/notes/wysiwyg/milkdown-math.ts');
    const codePlugin = read('public/manager/src/notes/wysiwyg/milkdown-code-block-view.ts');

    assert.ok(editor.includes('MilkdownWysiwygEditor'), 'WYSIWYG mode must render the Milkdown authoring surface');
    assert.ok(milkdown.includes('@milkdown/kit/core'), 'WYSIWYG mode must use Milkdown core directly');
    assert.ok(milkdown.includes('@milkdown/kit/preset/commonmark'), 'Milkdown WYSIWYG must support CommonMark editing');
    assert.ok(milkdown.includes('@milkdown/kit/preset/gfm'), 'Milkdown WYSIWYG must support GFM editing');
    assert.ok(milkdown.includes('./milkdown-math'), 'Milkdown WYSIWYG must use the local math plugin instead of a deprecated dependency');
    assert.ok(milkdown.includes('./milkdown-code-block-view'), 'Milkdown WYSIWYG must use the local code block source view');
    assert.ok(milkdown.includes('notesMilkdownKatexOptionsCtx'), 'Milkdown WYSIWYG must configure KaTeX options');
    assert.ok(milkdown.includes('.use(notesMilkdownMath)'), 'Milkdown WYSIWYG must install the local math plugin');
    assert.ok(milkdown.includes('.use(notesMilkdownCodeBlockView)'), 'Milkdown WYSIWYG must install the code block source view');
    assert.ok(milkdown.includes('insertInlineMath'), 'Milkdown WYSIWYG must expose inline math insertion');
    assert.ok(milkdown.includes('insertBlockMath'), 'Milkdown WYSIWYG must expose block math insertion');
    assert.ok(milkdown.includes('createLanguageCodeBlock'), 'Milkdown WYSIWYG must create language-aware code blocks');
    assert.ok(milkdown.includes('normalizeCodeLanguage'), 'code block language input must be normalized before reaching Markdown');
    assert.ok(mathPlugin.includes('$view'), 'Milkdown math must use node views for rendered/raw editing');
    assert.ok(mathPlugin.includes('notesMathInlineView'), 'inline math must have a rendered/raw node view');
    assert.ok(mathPlugin.includes('notesMathBlockView'), 'block math must have a rendered/raw node view');
    assert.ok(mathPlugin.includes('notes-math-raw'), 'math node views must expose raw editable source');
    assert.ok(mathPlugin.includes('inlineMathSource'), 'inline math raw editing must expose the $...$ markdown source');
    assert.ok(mathPlugin.includes('blockMathSource'), 'block math raw editing must expose the $$...$$ markdown source');
    assert.ok(mathPlugin.includes('updateMathNode'), 'raw math edits must write back into the ProseMirror node');
    assert.ok(codePlugin.includes('codeBlockSchema'), 'code blocks must attach to the CommonMark code_block schema');
    assert.ok(codePlugin.includes('notesCodeBlockSourceView'), 'code blocks must have a rendered/raw node view');
    assert.ok(codePlugin.includes('fencedCodeSource'), 'code block raw editing must expose fenced markdown source');
    assert.ok(codePlugin.includes('notes-code-raw'), 'code block node views must expose raw editable source');
    assert.ok(codePlugin.includes('updateCodeBlockNode'), 'raw code block edits must write back into the ProseMirror node');
    assert.ok(milkdown.includes('listenerCtx'), 'Milkdown WYSIWYG must publish markdown changes through listenerCtx');
    assert.ok(milkdown.includes('onChangeRef.current(markdown)'), 'Milkdown WYSIWYG must keep the existing markdown save path');
    assert.ok(milkdown.includes('syncingFromPropsRef'), 'Milkdown WYSIWYG must suppress controlled prop sync writes');
    assert.ok(milkdown.includes('latestPropContentRef'), 'Milkdown WYSIWYG must reconcile async creation with latest props');
    assert.ok(workspace.includes('key={props.selectedPath}'), 'WYSIWYG history must reset on note boundaries');
    assert.ok(milkdown.includes('safeMarkdownUrl'), 'WYSIWYG link insertion must reuse safe URL policy');
    assert.ok(milkdown.includes('onPasteCapture'), 'WYSIWYG paste must own an HTML-to-text safety boundary');
    assert.ok(milkdown.includes('notes-wysiwyg-toolbar'), 'WYSIWYG mode must expose visual formatting controls');
    assert.equal(milkdown.includes('@milkdown/react'), false, 'WYSIWYG mode must avoid Crepe-pulling React wrapper');
    assert.equal(milkdown.includes('@milkdown/crepe'), false, 'WYSIWYG mode must not import Crepe');
    assert.equal(milkdown.includes('@milkdown/plugin-math'), false, 'WYSIWYG mode must not import deprecated plugin-math');
});

test('Markdown preview strips HTML and blocks unsafe URLs', () => {
    const preview = read('public/manager/src/notes/MarkdownPreview.tsx');
    const renderer = read('public/manager/src/notes/rendering/MarkdownRenderer.tsx');
    const security = read('public/manager/src/notes/markdown-security.ts');

    assert.ok(preview.includes('MarkdownRenderer'), 'preview must delegate to the shared markdown renderer');
    assert.ok(renderer.includes('react-markdown'), 'shared renderer must use react-markdown');
    assert.ok(renderer.includes('skipHtml'), 'shared renderer must strip raw HTML');
    assert.ok(renderer.includes('urlTransform={safeMarkdownUrl}'), 'shared renderer must transform markdown URLs');
    assert.ok(security.includes('safeMarkdownUrl'), 'safe URL helper must exist');
    assert.ok(security.includes('javascript:') === false, 'unsafe javascript links must not be whitelisted');
    assert.ok(security.includes('data:') === false, 'unsafe data links must not be whitelisted');
    assert.equal(renderer.includes('rehype-raw'), false, 'shared renderer must not enable rehype-raw');
});
