// 260725 wp1 — Notes palette shortcut contract.
//
// The migration contract fixes Cmd/Ctrl+P as the quick switcher and
// Cmd/Ctrl+Shift+P as the command palette (071_notes_card.md:266,
// 002.1_notes_feature.md:219-220). NotesPanel inlined Cmd+O instead, which left
// both helpers in notes-shortcuts.ts as dead code and gave the command palette
// no way to open at all. isCommandPaletteShortcut was also missing the
// palette-inside guard, so Cmd+Shift+P could stack a second modal on an open
// quick switcher.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import {
    isCommandPaletteShortcut,
    isQuickSwitcherShortcut,
} from '../../public/dashboard2/src/features/notes/notes-shortcuts.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

interface Chord { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; target?: EventTarget | null }
const chord = (input: Chord) => ({
    key: input.key,
    metaKey: Boolean(input.metaKey),
    ctrlKey: Boolean(input.ctrlKey),
    shiftKey: Boolean(input.shiftKey),
    altKey: Boolean(input.altKey),
    target: input.target ?? null,
});

test('R4/R5: the panel opens each palette from the contract chord, not from Cmd+O', () => {
    const panel = read('public/dashboard2/src/features/notes/NotesPanel.tsx');

    assert.ok(panel.includes('isQuickSwitcherShortcut'), 'the quick switcher must come from the shared helper');
    assert.ok(panel.includes('isCommandPaletteShortcut'), 'the command palette must be reachable at all');
    assert.ok(panel.includes('setCommandPaletteOpen'), 'and must actually be opened');

    // The inline Cmd+O condition is what made both helpers dead code.
    assert.equal(
        /event\.key\.toLowerCase\(\)\s*===\s*'o'/.test(panel),
        false,
        'the inline Cmd+O key check must be gone',
    );
});

test('R6: the advertised shortcut matches the key that actually works', () => {
    const panel = read('public/dashboard2/src/features/notes/NotesPanel.tsx');
    const openCommand = panel.match(/id: 'notes:open'[^}]*}/)?.[0] ?? '';

    assert.ok(openCommand, 'the notes:open command must exist');
    assert.ok(openCommand.includes("shortcut: 'Cmd+P'"), 'it must advertise Cmd+P, which is the chord the handler listens for');
    assert.equal(openCommand.includes("shortcut: 'Cmd+O'"), false, 'advertising Cmd+O would be a lie after the contract fix');
});

test('R7: both palettes carry the marker the guard looks for', () => {
    for (const file of [
        'public/dashboard2/src/features/notes/NotesQuickSwitcher.tsx',
        'public/dashboard2/src/features/notes/NotesCommandPalette.tsx',
    ]) {
        assert.ok(
            read(file).includes('data-notes-palette'),
            `${file} must be findable by isInsideNotesPalette, otherwise the guard silently never matches`,
        );
    }
});

test('R8/P5: neither palette shortcut fires from inside the other palette', () => {
    const dom = new JSDOM('<div data-notes-palette="switcher"><input id="switcher-input"></div>'
        + '<div data-notes-palette="command"><input id="command-input"></div>'
        + '<button id="outside">outside</button>');
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });

    const insideSwitcher = dom.window.document.getElementById('switcher-input')!;
    const insideCommand = dom.window.document.getElementById('command-input')!;
    const outside = dom.window.document.getElementById('outside')!;

    // Baseline: both chords work from ordinary content.
    assert.equal(isQuickSwitcherShortcut(chord({ key: 'p', metaKey: true, target: outside })), true);
    assert.equal(isCommandPaletteShortcut(chord({ key: 'p', metaKey: true, shiftKey: true, target: outside })), true);

    // R8: this is the direction that used to stack a second modal.
    assert.equal(
        isCommandPaletteShortcut(chord({ key: 'p', metaKey: true, shiftKey: true, target: insideSwitcher })),
        false,
        'Cmd+Shift+P inside the quick switcher must not open the command palette on top of it',
    );

    // P5: the direction the existing guard already covered.
    assert.equal(
        isQuickSwitcherShortcut(chord({ key: 'p', metaKey: true, target: insideCommand })),
        false,
        'Cmd+P inside the command palette must not open the quick switcher',
    );
});

test('P4: the two chords stay distinct so one cannot trigger the other', () => {
    const outsideTarget = null;
    assert.equal(isQuickSwitcherShortcut(chord({ key: 'p', metaKey: true, shiftKey: true, target: outsideTarget })), false,
        'adding Shift must switch to the palette, not fire both');
    assert.equal(isCommandPaletteShortcut(chord({ key: 'p', metaKey: true, target: outsideTarget })), false,
        'without Shift the palette must stay closed');
    assert.equal(isQuickSwitcherShortcut(chord({ key: 'p', altKey: true, metaKey: true, target: outsideTarget })), false,
        'Alt is not part of either chord');
});
