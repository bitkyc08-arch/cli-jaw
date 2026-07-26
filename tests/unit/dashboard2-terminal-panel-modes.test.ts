// 260726 wp5a — the terminal panel declares which mode it is in.
//
// The panel is one element in two jobs: it hosts the xterm canvas, and it shows
// the messages that replace it. Those need opposite treatment — a terminal
// wants a hard black surface, a status message wants the themed one — and the
// first attempt told them apart by asking whether `.xterm` existed yet.
//
// That looked equivalent and was not. The runtime branch renders before
// terminal.open() attaches anything, so for one frame a live terminal matched
// the status rule; and a runtime panel with zero sessions never gets `.xterm`
// at all, so it would have stayed styled as a status screen forever.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

test('every state branch marks itself, and the runtime branch marks itself', () => {
    const source = read('public/dashboard2/src/shell/panels/TerminalPanel.tsx');

    // Each early return is a screen that replaces the terminal.
    const stateBranches = [...source.matchAll(/className="d2-terminal-panel([^"]*)"/g)]
        .map(m => m[1]!.trim());
    assert.ok(stateBranches.length >= 5, `expected the panel to render several branches, saw ${stateBranches.length}`);

    const unmarked = stateBranches.filter(mods => !/is-state|is-runtime/.test(mods));
    assert.deepEqual(unmarked, [], 'a branch that declares neither mode will be styled by whichever rule wins');

    assert.equal(
        stateBranches.filter(m => m.includes('is-runtime')).length,
        1,
        'exactly one branch hosts the terminal',
    );
});

test('the status styling keys on the declared mode, not on the canvas', () => {
    const css = read('public/dashboard2/src/styles/workbench-v4.css');

    assert.match(css, /\.d2-terminal-panel\.is-state\s*\{/, 'status styling must key on the declared mode');
    assert.doesNotMatch(
        css,
        /\.d2-terminal-panel:not\(:has\(\.xterm\)\)/,
        'keying on .xterm mis-styles the frame before terminal.open() and any runtime panel with no sessions',
    );
});

test('the runtime branch keeps a terminal-appropriate surface', () => {
    // The canvas needs its own near-black background; the fix must not have
    // handed the runtime branch the themed surface meant for status text.
    const source = read('public/dashboard2/src/shell/panels/TerminalPanel.tsx');
    const runtime = source.slice(source.indexOf('is-runtime'));
    assert.match(runtime.slice(0, 400), /background: '#0a0a0a'/, 'the terminal host keeps its own dark canvas');
});
