import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTuiDisplayMode } from '../../src/cli/tui/mode.ts';

test('resolveTuiDisplayMode defaults to fullscreen for TTY', () => {
    assert.equal(resolveTuiDisplayMode({ isTTY: true, rows: 24, term: 'xterm-256color' }), 'fullscreen');
});

test('resolveTuiDisplayMode honors --fullscreen flag', () => {
    assert.equal(resolveTuiDisplayMode({ fullscreenFlag: true, isTTY: true, rows: 24, term: 'xterm-256color' }), 'fullscreen');
});

test('resolveTuiDisplayMode --classic forces line', () => {
    assert.equal(resolveTuiDisplayMode({ classicFlag: true, fullscreenFlag: true, isTTY: true, rows: 24 }), 'line');
});

test('resolveTuiDisplayMode falls back for non-tty', () => {
    assert.equal(resolveTuiDisplayMode({ fullscreenFlag: true, isTTY: false }), 'line');
});
