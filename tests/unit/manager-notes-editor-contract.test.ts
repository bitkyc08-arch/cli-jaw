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
