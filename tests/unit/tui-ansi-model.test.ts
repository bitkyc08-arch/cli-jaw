import test from 'node:test';
import assert from 'node:assert/strict';
import { AnsiTerminalModel } from './helpers/ansi-terminal-model.ts';

// Fidelity tests for the shared terminal model (260703 scrollback hardening).
// Real-terminal semantics verified empirically against @xterm/headless in the
// jawcode sibling repo: DECSTBM ignores bottom <= top, and 3J erases the saved
// lines while 2J touches only the visible screen.

test('DECSTBM ignores a 1-row region — CSI 1;1r + newline pushes nothing to scrollback', () => {
    const term = new AnsiTerminalModel(20, 4);
    term.write('row-1\r\nrow-2\r\nrow-3\r\nrow-4');
    term.write('\x1b[1;1r');
    term.write('\x1b[1;1H');
    term.write('\r\n');
    term.write('\x1b[r');
    assert.equal(term.scrollback.length, 0);
    // The newline only moved the cursor; row-1 is still on screen.
    assert.match(term.visibleText(), /row-1/);
});

test('DECSTBM with bottom > top scrolls the top row into scrollback', () => {
    const term = new AnsiTerminalModel(20, 4);
    term.write('row-1\r\nrow-2\r\nrow-3\r\nrow-4');
    term.write('\x1b[1;2r');
    term.write('\x1b[2;1H');
    term.write('\r\n');
    term.write('\x1b[r');
    assert.deepEqual(term.scrollback, ['row-1']);
});

test('2J clears the visible screen but keeps scrollback; 3J erases scrollback too', () => {
    const term = new AnsiTerminalModel(20, 2);
    term.write('a\r\nb\r\nc\r\nd');
    assert.equal(term.scrollback.length, 2);
    term.write('\x1b[2J\x1b[H');
    assert.equal(term.scrollback.length, 2);
    assert.equal(term.visibleText().trim(), '');
    term.write('\x1b[3J');
    assert.equal(term.scrollback.length, 0);
});

test('DL deletes lines within the region without touching scrollback', () => {
    const term = new AnsiTerminalModel(20, 5);
    term.write('r1\r\nr2\r\nr3\r\nr4\r\nr5');
    term.write('\x1b[1;4r');
    term.write('\x1b[1;1H');
    term.write('\x1b[2M');
    term.write('\x1b[r');
    assert.equal(term.scrollback.length, 0);
    assert.deepEqual(term.visibleText().split('\n'), ['r3', 'r4', '', '', 'r5']);
});
