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

test('Notes rich markdown renderer files exist', () => {
    [
        'public/manager/src/notes/rendering/MarkdownRenderer.tsx',
        'public/manager/src/notes/rendering/CodeBlock.tsx',
        'public/manager/src/notes/rendering/MermaidBlock.tsx',
        'public/manager/src/notes/rendering/highlight-languages.ts',
        'public/manager/src/notes/rendering/markdown-render-security.ts',
    ].forEach(path => {
        assert.equal(existsSync(join(projectRoot, path)), true, `${path} must exist`);
    });
});

test('MarkdownPreview delegates to the shared renderer', () => {
    const preview = read('public/manager/src/notes/MarkdownPreview.tsx');

    assert.ok(preview.includes("import { MarkdownRenderer } from './rendering/MarkdownRenderer';"),
        'MarkdownPreview must import the shared renderer');
    assert.ok(preview.includes('<MarkdownRenderer markdown={props.markdown} />'),
        'MarkdownPreview must delegate markdown content rendering');
    assert.equal(preview.includes('ReactMarkdown'), false,
        'MarkdownPreview must not own a second ReactMarkdown pipeline');
});

test('MarkdownRenderer wires math, sanitize, safe links, and block routing', () => {
    const renderer = read('public/manager/src/notes/rendering/MarkdownRenderer.tsx');

    assert.ok(renderer.includes("import remarkMath from 'remark-math';"), 'remark-math must be wired');
    assert.ok(renderer.includes("import rehypeKatex from 'rehype-katex';"), 'rehype-katex must be wired');
    assert.ok(renderer.includes("import rehypeSanitize from 'rehype-sanitize';"), 'rehype-sanitize must be wired');
    assert.ok(renderer.includes('remarkPlugins={[remarkMath]}'), 'remarkMath must be passed to ReactMarkdown');
    assert.ok(renderer.includes('[rehypeSanitize, markdownSanitizeSchema]'), 'sanitize schema must be passed before KaTeX');
    assert.ok(renderer.includes('rehypeKatex'), 'KaTeX renderer must be passed to ReactMarkdown');
    assert.ok(renderer.includes('skipHtml'), 'raw HTML must stay disabled');
    assert.ok(renderer.includes('urlTransform={safeMarkdownUrl}'), 'safe URL transform must stay active');
    assert.equal(renderer.includes('rehypeRaw'), false, 'rehype-raw must not be introduced');
    assert.ok(renderer.includes("language === 'mermaid'"), 'Mermaid must be selected from language-mermaid fenced code');
    assert.ok(renderer.includes('<CodeBlock code={code} language={language} />'), 'code fences must route to CodeBlock');
    assert.ok(renderer.includes('<code className={className}>{children}</code>'), 'inline code must remain inline');
});

test('MermaidBlock uses component-owned strict Mermaid rendering without iframe', () => {
    const mermaid = read('public/manager/src/notes/rendering/MermaidBlock.tsx');

    assert.ok(mermaid.includes("await import('mermaid')"), 'Mermaid must stay lazy-loaded');
    assert.ok(mermaid.includes('startOnLoad: false'), 'Mermaid must not scan the whole document on load');
    assert.ok(mermaid.includes("securityLevel: 'strict'"), 'Mermaid must use strict security level');
    assert.ok(mermaid.includes('mermaid.render'), 'MermaidBlock must render through the Mermaid API');
    assert.equal(mermaid.includes('<iframe'), false, 'MermaidBlock must not use iframe rendering');
    assert.ok(mermaid.includes("status: 'error'"), 'Mermaid render failures must stay local to the block');
});

test('CodeBlock uses highlight.js core with curated language aliases and safe fallback', () => {
    const codeBlock = read('public/manager/src/notes/rendering/CodeBlock.tsx');
    const highlight = read('public/manager/src/notes/rendering/highlight-languages.ts');

    assert.ok(highlight.includes("import hljs from 'highlight.js/lib/core';"), 'highlight.js core import must be used');
    [
        "'javascript'", "'js'", "'typescript'", "'ts'", "'python'", "'py'", "'bash'", "'shell'", "'sh'",
        "'json'", "'css'", "'xml'", "'html'", "'markdown'", "'md'", "'yaml'", "'yml'", "'sql'",
        "'rust'", "'rs'", "'go'", "'java'", "'cpp'", "'c'", "'diff'", "'plaintext'", "'text'",
    ].forEach(alias => {
        assert.ok(highlight.includes(alias), `language alias ${alias} must be registered`);
    });
    assert.ok(highlight.includes('hljs.getLanguage(normalized)'), 'unknown languages must be checked before highlight');
    assert.ok(highlight.includes('highlighted: false'), 'unknown languages must fall back safely');
    assert.ok(codeBlock.includes('navigator.clipboard.writeText(props.code)'), 'copy button must copy source text');
});

test('Notes app imports KaTeX CSS and notes CSS owns rich preview styling', () => {
    const main = read('public/manager/src/main.tsx');
    const css = read('public/manager/src/manager-notes.css');

    assert.ok(main.includes("import 'katex/dist/katex.min.css';"), 'KaTeX CSS must be imported');
    assert.ok(css.includes('.notes-code-block'), 'Notes CSS must style code blocks');
    assert.ok(css.includes('.notes-mermaid-block'), 'Notes CSS must style Mermaid blocks');
    assert.ok(css.includes('.katex-display'), 'Notes CSS must handle KaTeX display overflow');
});
