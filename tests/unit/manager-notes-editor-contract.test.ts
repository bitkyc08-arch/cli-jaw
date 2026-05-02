import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeEscapedTaskMarkers } from '../../public/manager/src/notes/wysiwyg/milkdown-task-markers';

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
    const gfmPlugin = read('public/manager/src/notes/wysiwyg/milkdown-gfm-safe.ts');
    const mathPlugin = read('public/manager/src/notes/wysiwyg/milkdown-math.ts');
    const codePlugin = read('public/manager/src/notes/wysiwyg/milkdown-code-block-view.ts');

    assert.ok(editor.includes('MilkdownWysiwygEditor'), 'WYSIWYG mode must render the Milkdown authoring surface');
    assert.ok(editor.includes('hasMilkdownUnsafeGfm'), 'WYSIWYG mode must guard Milkdown from known unsafe GFM constructs');
    assert.ok(editor.includes("enabled: props.authoringMode === 'rich' || props.authoringMode === 'wysiwyg'"),
        'WYSIWYG fallback must enable CodeMirror rich widgets for task checkboxes');
    assert.ok(editor.includes('WYSIWYG is temporarily disabled for notes with GFM task lists, tables, or footnotes.'),
        'unsafe GFM fallback must explain why WYSIWYG did not mount');
    assert.ok(editor.includes('<MarkdownPreview markdown={props.content} />'),
        'unsafe GFM fallback must still show rendered checkboxes through the safe preview renderer');
    assert.ok(milkdown.includes('@milkdown/kit/core'), 'WYSIWYG mode must use Milkdown core directly');
    assert.ok(milkdown.includes('@milkdown/kit/preset/commonmark'), 'Milkdown WYSIWYG must support CommonMark editing');
    assert.ok(milkdown.includes('./milkdown-gfm-safe'), 'Milkdown WYSIWYG must support GFM editing through the local safe wrapper');
    assert.ok(milkdown.includes('.use(notesMilkdownGfm)'), 'Milkdown WYSIWYG must install the local GFM wrapper');
    assert.equal(milkdown.includes('.use(gfm)'), false, 'WYSIWYG must not install the upstream GFM bundle with the unsafe task input rule');
    assert.ok(milkdown.includes('./milkdown-math'), 'Milkdown WYSIWYG must use the local math plugin instead of a deprecated dependency');
    assert.ok(milkdown.includes('./milkdown-code-block-view'), 'Milkdown WYSIWYG must use the local code block source view');
    assert.ok(milkdown.includes('notesMilkdownKatexOptionsCtx'), 'Milkdown WYSIWYG must configure KaTeX options');
    assert.ok(milkdown.includes('.use(notesMilkdownMath)'), 'Milkdown WYSIWYG must install the local math plugin');
    assert.ok(milkdown.includes('.use(notesMilkdownCodeBlockView)'), 'Milkdown WYSIWYG must install the code block source view');
    assert.ok(milkdown.includes('insertInlineMath'), 'Milkdown WYSIWYG must expose inline math insertion');
    assert.ok(milkdown.includes('insertBlockMath'), 'Milkdown WYSIWYG must expose block math insertion');
    assert.ok(milkdown.includes('insertTaskListItem'), 'Task list toolbar insertion must use a safe handler');
    assert.ok(milkdown.includes('}- [ ] `'), 'Task toolbar insertion must append canonical task markdown');
    assert.equal(milkdown.includes("insert('\\n- [ ] '"), false, 'Task toolbar insertion must not enter Milkdown task parsing');
    assert.ok(milkdown.includes('onMouseDown={event => event.preventDefault()}'), 'Task toolbar button must preserve the current Milkdown selection before click');
    assert.ok(milkdown.includes('normalizeEscapedTaskMarkers'), 'WYSIWYG must save literal task markers as canonical GFM task list markdown');
    assert.ok(milkdown.includes('toggleStrikethroughCommand'), 'Milkdown WYSIWYG must expose GFM strikethrough');
    assert.ok(milkdown.includes('insertTableCommand'), 'Milkdown WYSIWYG must expose GFM tables');
    assert.ok(milkdown.includes('handleTaskListClick'), 'Milkdown WYSIWYG must let users toggle task list checkboxes');
    assert.ok(milkdown.includes('handleTaskListKeyDown'), 'Milkdown WYSIWYG task checkboxes must be keyboard-toggleable');
    assert.ok(milkdown.includes("item.setAttribute('role', 'checkbox')"), 'Milkdown WYSIWYG task items must expose checkbox semantics');
    assert.ok(milkdown.includes("item.setAttribute('aria-checked'"), 'Milkdown WYSIWYG task items must expose checked state');
    assert.ok(milkdown.includes('createLanguageCodeBlock'), 'Milkdown WYSIWYG must create language-aware code blocks');
    assert.ok(milkdown.includes('normalizeCodeLanguage'), 'code block language input must be normalized before reaching Markdown');
    assert.ok(gfmPlugin.includes('rule !== wrapInTaskListInputRule'), 'GFM wrapper must exclude Milkdown upstream task-list input rule');
    assert.equal(gfmPlugin.includes('$inputRule'), false, 'GFM wrapper must not add any task-list input rule on the live typing path');
    assert.ok(milkdown.includes('observer.disconnect()'), 'WYSIWYG task accessibility observer must be disconnected on unmount');
    assert.ok(milkdown.includes("root.removeEventListener('click', handleTaskListClick)"), 'WYSIWYG task click listener must be removed on unmount');
    assert.ok(milkdown.includes("root.removeEventListener('keydown', handleTaskListKeyDown, true)"), 'WYSIWYG task key listener must be removed on unmount');
    assert.ok(milkdown.includes('aria-label="Task list"'), 'Task toolbar button must be enabled for ready WYSIWYG editors');
    assert.ok(milkdown.includes('onClick={insertTaskListItem}'), 'Task toolbar button must insert a task item');
    assert.equal(milkdown.includes('Task list toolbar insertion is disabled'), false, 'Task toolbar button must not remain disabled as a policy choice');
    assert.equal(milkdown.includes('aria-disabled="true"'), false, 'Task toolbar button must not expose a fake permanently disabled state');
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
    assert.ok(codePlugin.includes("import { highlightCode } from '../rendering/highlight-languages';"),
        'WYSIWYG code block rendering must reuse the preview highlight pipeline');
    assert.ok(codePlugin.includes('code.innerHTML = highlighted.html'),
        'WYSIWYG rendered code must preserve highlight.js spans instead of plain text only');
    assert.ok(codePlugin.includes('code.dataset.highlighted'),
        'WYSIWYG rendered code must expose highlight state for regression checks');
    assert.ok(codePlugin.includes('commitAndExitCodeBlock'),
        'code block exit must commit and move caret in a single transaction');
    assert.equal(codePlugin.includes('function moveAfterCodeBlock'), false,
        'code block exit must not use the legacy multi-dispatch moveAfterCodeBlock helper');
    assert.ok(mathPlugin.includes('commitAndExitMathNode'),
        'math node exit must commit and move caret in a single transaction');
    assert.equal(mathPlugin.includes('function moveAfterMathNode'), false,
        'math node exit must not use the legacy multi-dispatch moveAfterMathNode helper');
    assert.ok(milkdown.includes('listenerCtx'), 'Milkdown WYSIWYG must publish markdown changes through listenerCtx');
    assert.ok(milkdown.includes('onChangeRef.current(normalizedMarkdown)') || milkdown.includes('onChangeRef.current(markdown)'), 'Milkdown WYSIWYG must keep the existing markdown save path');
    assert.ok(milkdown.includes('syncingFromPropsRef'), 'Milkdown WYSIWYG must suppress controlled prop sync writes');
    assert.ok(milkdown.includes('latestPropContentRef'), 'Milkdown WYSIWYG must reconcile async creation with latest props');
    assert.ok(workspace.includes('key={props.selectedPath}'), 'WYSIWYG history must reset on note boundaries');
    assert.ok(workspace.includes('{showEditor && <div className="notes-editor-pane">'),
        'Notes preview mode must not mount the hidden editor pane or hidden WYSIWYG editor');
    assert.equal(workspace.includes('hidden={!showEditor}'), false,
        'Notes preview mode must unmount the editor instead of hiding a live WYSIWYG instance');
    assert.ok(milkdown.includes('safeMarkdownUrl'), 'WYSIWYG link insertion must reuse safe URL policy');
    assert.ok(milkdown.includes('onPasteCapture'), 'WYSIWYG paste must own an HTML-to-text safety boundary');
    assert.ok(milkdown.includes('notes-wysiwyg-toolbar'), 'WYSIWYG mode must expose visual formatting controls');
    assert.equal(milkdown.includes('@milkdown/react'), false, 'WYSIWYG mode must avoid Crepe-pulling React wrapper');
    assert.equal(milkdown.includes('@milkdown/crepe'), false, 'WYSIWYG mode must not import Crepe');
    assert.equal(milkdown.includes('@milkdown/plugin-math'), false, 'WYSIWYG mode must not import deprecated plugin-math');
});

test('CodeMirror rich widgets render and toggle task markers without Milkdown task nodes', () => {
    const extension = read('public/manager/src/notes/rich-markdown/rich-markdown-extension.ts');
    const css = read('public/manager/src/manager-notes.css');

    assert.ok(extension.includes('class TaskLineWidget'), 'task checkboxes must be implemented as CodeMirror widgets');
    assert.ok(extension.includes('taskLinePattern'), 'task widget scanner must match markdown task lines');
    assert.ok(extension.includes("insert: checkbox.checked ? '[x]' : '[ ]'"),
        'task widget toggle must update the source markdown marker');
    assert.ok(extension.includes("userEvent: 'input.task-toggle'"),
        'task widget toggle must identify its editor transaction');
    assert.ok(extension.includes('MAX_TASK_WIDGETS_PER_VIEWPORT'),
        'task widget rendering must be bounded for large notes');
    assert.ok(extension.includes('destroy(dom: HTMLElement)'),
        'task widget must explicitly release DOM event handlers on destroy');
    assert.ok(extension.includes('updateDOM(dom: HTMLElement, view: EditorView)'),
        'task widget must update existing DOM instead of recreating every checkbox');
    assert.ok(extension.includes('EditorView.atomicRanges.of'),
        'task widget replacement ranges must be exposed as atomic ranges');
    assert.ok(extension.includes('let inFence = false'),
        'task widget scanner must avoid rendering checkboxes inside fenced code blocks');
    assert.ok(extension.includes('decorations.sort'),
        'task and rich markdown decorations must be sorted before RangeSetBuilder.add');
    assert.ok(extension.includes('left.decoration.startSide - right.decoration.startSide'),
        'decoration sorting must honor CodeMirror startSide ordering for equal from positions');
    assert.ok(css.includes('.cm-rich-task-widget'), 'task widgets must have scoped notes styling');
});

test('WYSIWYG task marker normalization is narrow and idempotent', () => {
    const input = [
        '  - [X]\tchecked',
        '\t* \\[ \\]\ttab indented',
        '+ \\[x\\] done',
        '- [not-task] keep',
        'plain \\[ \\] keep',
    ].join('\n');

    const expected = [
        '  - [X]\tchecked',
        '\t* [ ]\ttab indented',
        '+ [x] done',
        '- [not-task] keep',
        'plain \\[ \\] keep',
    ].join('\n');

    const normalized = normalizeEscapedTaskMarkers(input);
    assert.equal(normalized, expected);
    assert.equal(normalizeEscapedTaskMarkers(normalized), expected);
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
