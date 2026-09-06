import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorScreenPos } from '../../src/cli/tui/renderers.js';
import { composeComposerBox } from '../../src/cli/tui/render/composer-box.js';
import { computeComposerVisualRows, redrawPromptLine } from '../../bin/commands/tui/renderer.js';
import { Screen } from '../../src/cli/tui/render/frame.js';
import { createTuiStore } from '../../src/cli/tui/store.js';
import { appendTextToComposer } from '../../src/cli/tui/composer.js';
import xterm from '@xterm/xterm';

const theme = { dimCode: '', resetCode: '', accentCode: '', boldCode: '',
    border: { topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+', horizontal: '-', vertical: '|' } };

test('invisible graphemes do not advance the classic or boxed cursor', () => {
    assert.equal(cursorScreenPos('\u200bA', 1, 4, 4, 20).col, 4);
    const box = composeComposerBox('\u200bA', 1, 20, 1, theme);
    assert.equal(box.cursor.col, 4);
});

test('oversized Hangul cluster has the same visible fallback and cursor advance', () => {
    const giant = 'ᄀ'.repeat(8);
    const box = composeComposerBox(giant, 1, 20, 1, theme);
    assert.match(box.rows[1]!, /^\| > \?/);
    assert.equal(box.cursor.col, 5);
    assert.equal(cursorScreenPos(giant, 1, 4, 4, 10).col, 5);
});

test('cursor before and after a wrapped wide cluster follows its visual row', () => {
    const value = 'a'.repeat(14) + '한';
    const before = composeComposerBox(value, 14, 20, 2, theme);
    const after = composeComposerBox(value, 15, 20, 2, theme);
    assert.deepEqual(before.cursor, { row: 1, col: 4 });
    assert.deepEqual(after.cursor, { row: 1, col: 6 });
    assert.equal(computeComposerVisualRows('한'.repeat(20), 9, '>>>>', '....'), 6);
});

test('CRLF editor text uses one visible line break without changing cursor units', () => {
    assert.deepEqual(cursorScreenPos('a\r\nb', 3, 4, 4, 20), { row: 1, col: 5, totalRows: 2 });
    const box = composeComposerBox('a\r\nb', 3, 20, 2, theme);
    assert.deepEqual(box.cursor, { row: 1, col: 5 });
    assert.ok(box.rows.every(row => !/[\r\n]/.test(row)));
});

test('actual Screen clipping retains the four-cell Unicode answer intact', () => {
    const oldCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const oldRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    const write = process.stdout.write;
    let output = '';
    Object.defineProperty(process.stdout, 'columns', { value: 4, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 10, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    const screen = new Screen();
    try {
        screen.enter();
        screen.render({ rows: ['A👩‍💻B'] });
        assert.ok(output.includes('A👩‍💻B'));
    } finally {
        screen.exit(); process.stdout.write = write;
        if (oldCols) Object.defineProperty(process.stdout, 'columns', oldCols); else delete process.stdout.columns;
        if (oldRows) Object.defineProperty(process.stdout, 'rows', oldRows); else delete process.stdout.rows;
    }
});

test('repeated classic redraw follows its explicit grapheme layout without erasing preceding output', async () => {
    const oldCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const original = process.stdout.write;
    let output = 'SENTINEL\r\n';
    Object.defineProperty(process.stdout, 'columns', { value: 20, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    const ctx = { displayMode: 'line' as const, requestFrame: null, store: createTuiStore(),
        promptPrefix: '  ❯ ', prevLineCount: 1, promptCursorRow: 0 };
    try {
        appendTextToComposer(ctx.store.composer, ('ᄀ'.repeat(6) + ' ').repeat(5));
        redrawPromptLine(ctx);
        redrawPromptLine(ctx);
    } finally {
        process.stdout.write = original;
        if (oldCols) Object.defineProperty(process.stdout, 'columns', oldCols); else Reflect.deleteProperty(process.stdout, 'columns');
    }
    const terminal = new xterm.Terminal({ cols: 20, rows: 24, allowProposedApi: true });
    try {
        await new Promise<void>(resolve => terminal.write(output.replace(/\r?\n/g, '\r\n'), resolve));
        assert.equal(terminal.buffer.active.getLine(0)?.translateToString(true), 'SENTINEL');
        assert.equal(terminal.buffer.active.cursorY, ctx.prevLineCount);
    } finally { terminal.dispose(); }
});
