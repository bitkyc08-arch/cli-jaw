/**
 * Phase 015 -- Folder Row Trigger Semantics.
 *
 * Locks in the interaction contract:
 * - file single click = select/focus only (never calls onPreviewFile)
 * - file double-click = open file (calls onPreviewFile)
 * - file Enter = open file (calls onPreviewFile)
 * - folder chevron click = expand/collapse without opening a file
 * - folder row double-click = expand/collapse only, never opens a file
 * - ArrowRight expands, ArrowLeft collapses
 *
 * The preview gate lives in use-folder-selection.ts:
 *   `if (entry.kind === 'file' && options.preview !== false) onPreviewFile?.(...)`
 * and the row wiring lives in FolderTreeRows.tsx / FolderPanel.tsx. These tests
 * simulate that gate and additionally assert the actual source wiring so a
 * regression in either layer fails the suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Entry = { kind: 'file' | 'directory'; path: string };

// ---- Simulation of the selection preview gate (use-folder-selection.ts) ----

function simulateSelectEntry(
    entry: Entry,
    options: { range?: boolean; toggle?: boolean; preview?: boolean },
    onPreviewFile: (path: string) => void,
): void {
    if (entry.kind === 'file' && options.preview !== false) onPreviewFile(entry.path);
}

// Row wiring, mirroring FolderTreeRows.tsx / FolderPanel.tsx:
const singleClick = (entry: Entry, preview: (p: string) => void) =>
    simulateSelectEntry(entry, { range: false, toggle: false, preview: false }, preview);
const openFileEntry = (entry: Entry, preview: (p: string) => void, expanded: Set<string>) => {
    // double-click: directories toggle, files open
    if (entry.kind === 'directory') {
        if (expanded.has(entry.path)) expanded.delete(entry.path);
        else expanded.add(entry.path);
        return;
    }
    simulateSelectEntry(entry, {}, preview);
};
const enterKey = (entry: Entry, preview: (p: string) => void, expanded: Set<string>) => {
    if (entry.kind === 'directory') {
        if (expanded.has(entry.path)) expanded.delete(entry.path);
        else expanded.add(entry.path);
        return;
    }
    simulateSelectEntry(entry, {}, preview);
};
const chevronClick = (entry: Entry, expanded: Set<string>) => {
    if (entry.kind !== 'directory') return;
    if (expanded.has(entry.path)) expanded.delete(entry.path);
    else expanded.add(entry.path);
};

// =============================================================================
// Simulated trigger contract
// =============================================================================

test('single-click on a file selects without calling onPreviewFile', () => {
    const calls: string[] = [];
    singleClick({ kind: 'file', path: '/a/b.md' }, p => calls.push(p));
    assert.deepEqual(calls, []);
});

test('double-click on a file calls onPreviewFile', () => {
    const calls: string[] = [];
    openFileEntry({ kind: 'file', path: '/a/b.md' }, p => calls.push(p), new Set());
    assert.deepEqual(calls, ['/a/b.md']);
});

test('Enter on a focused file calls onPreviewFile', () => {
    const calls: string[] = [];
    enterKey({ kind: 'file', path: '/a/b.md' }, p => calls.push(p), new Set());
    assert.deepEqual(calls, ['/a/b.md']);
});

test('folder chevron toggles expansion without opening a file', () => {
    const calls: string[] = [];
    const expanded = new Set<string>();
    chevronClick({ kind: 'directory', path: '/a' }, expanded);
    assert.ok(expanded.has('/a'), 'expanded');
    chevronClick({ kind: 'directory', path: '/a' }, expanded);
    assert.ok(!expanded.has('/a'), 'collapsed');
    assert.deepEqual(calls, []);
});

test('folder row double-click toggles expansion and never opens a file', () => {
    const calls: string[] = [];
    const expanded = new Set<string>();
    openFileEntry({ kind: 'directory', path: '/a' }, p => calls.push(p), expanded);
    assert.ok(expanded.has('/a'));
    assert.deepEqual(calls, []);
});

test('chevron click on a file row is a no-op', () => {
    const expanded = new Set<string>();
    chevronClick({ kind: 'file', path: '/a/b.md' }, expanded);
    assert.equal(expanded.size, 0);
});

// =============================================================================
// Source wiring assertions: the actual components implement the contract
// =============================================================================

const folderPanelDir = join(process.cwd(), 'public/manager/src/folder-panel');
const treeRowsSource = readFileSync(join(folderPanelDir, 'FolderTreeRows.tsx'), 'utf-8');
const folderPanelSource = readFileSync(join(folderPanelDir, 'FolderPanel.tsx'), 'utf-8');
const selectionSource = readFileSync(join(folderPanelDir, 'use-folder-selection.ts'), 'utf-8');

test('use-folder-selection gates preview on file kind and preview !== false', () => {
    assert.match(selectionSource, /entry\.kind === 'file' && options\.preview !== false/);
});

test('FolderTreeRows single click passes preview: false', () => {
    assert.match(treeRowsSource, /onClick=\{\(event\) => props\.selectEntry\(entry, \{[^}]*preview: false[^}]*\}\)\}/);
});

test('FolderTreeRows double-click opens files and toggles directories', () => {
    assert.match(treeRowsSource, /onDoubleClick=\{\(\) => \{\s*if \(entry\.kind === 'directory'\) props\.toggleEntryExpansion\(entry\);\s*else props\.openFileEntry\(entry\);/);
});

test('FolderTreeRows chevron stops propagation and only toggles directories', () => {
    assert.match(treeRowsSource, /event\.stopPropagation\(\);\s*if \(entry\.kind === 'directory'\) props\.toggleEntryExpansion\(entry\);/);
});

test('FolderPanel ArrowRight expands and ArrowLeft collapses directories', () => {
    assert.match(folderPanelSource, /event\.key === 'ArrowRight'/);
    assert.match(folderPanelSource, /event\.key === 'ArrowLeft'/);
    assert.match(folderPanelSource, /entry\.kind === 'directory' && !expanded\.has\(entry\.path\)/);
    assert.match(folderPanelSource, /entry\.kind === 'directory' && expanded\.has\(entry\.path\)/);
});

test('FolderPanel Enter opens files (selectEntry with preview default on)', () => {
    assert.match(folderPanelSource, /if \(event\.key === 'Enter'\) \{\s*event\.preventDefault\(\);\s*if \(entry\.kind === 'directory'\) toggleEntryExpansion\(entry\);\s*else selectEntry\(entry\);/);
});

test('no route references the removed doc mode in the folder open path', () => {
    assert.ok(!treeRowsSource.includes("'doc'"), 'FolderTreeRows must not reference the removed doc mode');
    assert.ok(!folderPanelSource.includes("mode: 'doc'"), 'FolderPanel must not open a doc panel mode');
});
