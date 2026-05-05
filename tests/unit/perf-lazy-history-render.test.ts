import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeStrictPropertyAccess } from './source-normalize';

const uiSrc = normalizeStrictPropertyAccess(readFileSync(join(import.meta.dirname, '../../public/js/ui.ts'), 'utf8'));

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

test('buildVirtualHistoryItems stores lazy shells instead of rendered markdown HTML', () => {
    const block = functionBlock(uiSrc, 'function buildVirtualHistoryItems');

    assert.ok(block.includes('lazy-pending'), 'history rows must use lazy-pending shells');
    assert.ok(block.includes('data-raw="${escapeHtml(rawContent)}"'),
        'history rows must retain raw markdown in data-raw');
    assert.ok(!block.includes('renderMarkdown(rawContent)'),
        'history item construction must not eagerly render markdown');
});

test('buildVirtualHistoryItems stores raw escaped tool_log without eager ProcessBlock detail HTML', () => {
    const block = functionBlock(uiSrc, 'function buildVirtualHistoryItems');

    assert.ok(block.includes('data-tool-log="${rawToolLog}"'),
        'assistant history rows must carry raw tool_log in a lazy dataset');
    assert.ok(block.includes('? escapeHtml(m.tool_log)'),
        'tool_log is already JSON text and must only be HTML-escaped');
    assert.ok(!block.includes('JSON.stringify(m.tool_log)'),
        'tool_log must not be double-stringified');
    assert.ok(!block.includes('buildProcessBlockHtml(toProcessSteps(tools), true)'),
        'history item construction must not eagerly render ProcessBlock details');
});

test('registerVirtualScrollCallbacks renders markdown and tool_log only after mount', () => {
    const block = functionBlock(uiSrc, 'function registerVirtualScrollCallbacks');

    assert.ok(block.includes('const rawToolLog = body?.dataset.toolLog ||'),
        'lazy render must read stored tool_log from the mounted agent body');
    assert.ok(block.includes('parseToolLog(rawToolLog)'),
        'lazy render must parse the mounted raw tool_log');
    assert.ok(block.includes('buildProcessBlockHtml(toProcessSteps(tools), true)'),
        'lazy render must build ProcessBlock HTML after mount');
    assert.ok(block.includes('delete body.dataset.toolLog'),
        'lazy render must drop raw tool_log after rendering');
    assert.ok(block.includes('el.innerHTML = raw ? renderMarkdown(raw) :'),
        'lazy render must render markdown after mount');
    assert.ok(!block.includes('vs.updateItemHtml(idx, msgEl.outerHTML)'),
        'lazy render must not write rendered outerHTML back to VirtualScroll items');
});
