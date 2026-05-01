import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WYSIWYG_PREVIEW_RENDERER_POLICY } from '../../public/manager/src/notes/wysiwyg/wysiwyg-renderer-boundary';

const projectRoot = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('MarkdownPreview remains backed by the shared MarkdownRenderer', () => {
    const preview = read('public/manager/src/notes/MarkdownPreview.tsx');
    assert.equal(WYSIWYG_PREVIEW_RENDERER_POLICY.previewRenderer, 'MarkdownRenderer');
    assert.ok(preview.includes("import { MarkdownRenderer } from './rendering/MarkdownRenderer';"));
    assert.ok(preview.includes('<MarkdownRenderer markdown={props.markdown} />'));
});

test('WYSIWYG contract files do not duplicate preview renderer dependencies', () => {
    const wysiwygDir = join(projectRoot, 'public/manager/src/notes/wysiwyg');
    const sources = readdirSync(wysiwygDir)
        .filter(file => file.endsWith('.ts') || file.endsWith('.tsx'))
        .map(file => ({
            file,
            source: read(`public/manager/src/notes/wysiwyg/${file}`),
        }));
    const source = sources.map(entry => entry.source).join('\n');

    [
        "import { MarkdownRenderer",
        "from 'mermaid'",
        "from 'highlight.js'",
        'ReactMarkdown',
        'rehypeRaw',
        'rehypeKatex',
        'rehypeSanitize',
        'dangerouslySetInnerHTML',
    ].forEach(forbidden => {
        assert.equal(source.includes(forbidden), false, `WYSIWYG contracts must not include ${forbidden}`);
    });

    sources.forEach(entry => {
        const importsKatex = entry.source.includes("from 'katex'");
        assert.equal(
            importsKatex,
            entry.file === 'milkdown-math.ts',
            'Only the local Milkdown math authoring plugin may import KaTeX directly',
        );

        const importsRemarkMath = entry.source.includes('remarkMath');
        assert.equal(
            importsRemarkMath,
            entry.file === 'milkdown-math.ts',
            'Only the local Milkdown math authoring plugin may import remark-math directly',
        );
    });
});
