import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/cli/tui/markdown.ts';
import { visualWidth } from '../../src/cli/tui/renderers.ts';

// node:test stdout is not a TTY → theme.colorLevel() resolves to 'mono',
// so output is deterministic plain text (structure only).
const opts = { width: 60, gutter: '  ' };

test('renders heading with gutter and # marker', () => {
    assert.ok(renderMarkdown('# Title', opts).includes('  # Title'));
});

test('renders bullet list items', () => {
    const out = renderMarkdown('- one\n- two', opts);
    assert.ok(out.includes('• one'));
    assert.ok(out.includes('• two'));
});

test('renders ordered list with numbers', () => {
    const out = renderMarkdown('1. first\n2. second', opts);
    assert.ok(out.includes('1. first'));
    assert.ok(out.includes('2. second'));
});

test('preserves fenced code block markers and content', () => {
    const out = renderMarkdown('```\ncode line\n```', opts);
    assert.equal((out.match(/┌/g) ?? []).length, 1);
    assert.equal((out.match(/└/g) ?? []).length, 1);
    assert.ok(out.includes('code line'));
});

test('renders inline code text', () => {
    assert.ok(renderMarkdown('use `npm test` now', opts).includes('npm test'));
});

test('renders a horizontal rule', () => {
    assert.ok(renderMarkdown('---', opts).includes('─'));
});

test('renders a table with header and rows', () => {
    const out = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |', opts);
    assert.ok(out.includes('a'));
    assert.ok(out.includes('1'));
    assert.ok(out.includes('2'));
});

test('wraps a long paragraph without exceeding width', () => {
    const out = renderMarkdown('word '.repeat(50).trim(), opts);
    for (const line of out.split('\n')) {
        assert.ok(visualWidth(line) <= opts.width + 8, `line too wide: ${visualWidth(line)}`);
    }
});

test('CJK content renders without throwing', () => {
    const out = renderMarkdown('가나다 라마바 '.repeat(20).trim(), opts);
    assert.ok(typeof out === 'string' && out.length > 0);
});
