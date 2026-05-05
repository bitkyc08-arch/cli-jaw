import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeStrictPropertyAccess } from './source-normalize';

const renderSrc = normalizeStrictPropertyAccess(readFileSync(join(import.meta.dirname, '../../public/js/render.ts'), 'utf8'));
const virtualScrollSrc = normalizeStrictPropertyAccess(readFileSync(join(import.meta.dirname, '../../public/js/virtual-scroll.ts'), 'utf8'));

function functionBlock(source: string, signature: string): string {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `${signature} must exist`);
    const open = source.indexOf('{', start);
    assert.ok(open >= 0, `${signature} must have a body`);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) return source.slice(start, i + 1);
    }
    assert.fail(`${signature} body must close`);
}

test('renderSingleMermaidImpl drops raw source after preserving canonical copy source', () => {
    const block = functionBlock(renderSrc, 'async function renderSingleMermaidImpl');
    const setIdx = block.indexOf('el.dataset.mermaidCode = code');
    const deleteIdx = block.indexOf('delete el.dataset.mermaidCodeRaw');

    assert.ok(setIdx >= 0, 'render must preserve canonical mermaidCode');
    assert.ok(deleteIdx > setIdx, 'render must delete mermaidCodeRaw after preserving mermaidCode');
});

test('releaseMermaidNodes unobserves pending Mermaid nodes and clears transient queue flags', () => {
    const block = functionBlock(renderSrc, 'export function releaseMermaidNodes');

    assert.ok(block.includes('if (!mermaidObserver) return'),
        'release helper must be safe before observer initialization');
    assert.ok(block.includes("'.mermaid-pending'"),
        'release helper must include pending Mermaid nodes');
    assert.ok(block.includes("'[data-mermaid-queued=\"1\"]'"),
        'release helper must include queued Mermaid nodes');
    assert.ok(block.includes("'[data-mermaid-inflight=\"1\"]'"),
        'release helper must include inflight Mermaid nodes');
    assert.ok(block.includes('scope.matches(selector)'),
        'release helper must include the scope itself when it matches release selector');
    assert.ok(block.includes('querySelectorAll<HTMLElement>(selector)'),
        'release helper must scan pending descendants');
    assert.ok(block.includes('mermaidObserver.unobserve(el)'),
        'release helper must unobserve each pending element');
    assert.ok(block.includes('delete el.dataset.mermaidQueued'),
        'release helper must clear queued marker');
    assert.ok(block.includes('delete el.dataset.mermaidQueuedAt'),
        'release helper must clear queued timestamp marker');
    assert.ok(block.includes('delete el.dataset.mermaidInflight'),
        'release helper must clear inflight marker');
});

test('virtual-scroll releases Mermaid observer targets before unmount and deactivate', () => {
    assert.ok(virtualScrollSrc.includes("import { releaseMermaidNodes } from './render.js';"),
        'virtual-scroll must import releaseMermaidNodes');

    const deactivateBlock = functionBlock(virtualScrollSrc, 'private deactivate');
    assert.ok(deactivateBlock.includes('for (const el of this.mounted.values()) releaseMermaidNodes(el);'),
        'deactivate must release mounted Mermaid nodes before clearing mounted map');
    assert.ok(deactivateBlock.indexOf('releaseMermaidNodes(el)')
        < deactivateBlock.indexOf('this.mounted.clear()'),
        'deactivate release must happen before mounted.clear()');

    const renderBlock = functionBlock(virtualScrollSrc, 'private renderItems');
    assert.ok(renderBlock.includes('releaseMermaidNodes(el);\n                el.remove();'),
        'renderItems unmount path must release Mermaid nodes before removing DOM');
});

test('flushToDOM remains unused outside its definition and intentional comment', () => {
    const matches = [...virtualScrollSrc.matchAll(/flushToDOM\(/g)].map(match => match.index ?? -1);
    assert.equal(matches.length, 1, 'virtual-scroll.ts should only define flushToDOM');
    assert.ok(renderSrc.indexOf('flushToDOM(') === -1, 'render.ts must not call flushToDOM');
});
