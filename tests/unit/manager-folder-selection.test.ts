import assert from 'node:assert/strict';
import test from 'node:test';
import {
    emptyFolderSelection,
    flattenVisibleFolderEntries,
    moveFolderKeyboardSelection,
    pruneFolderSelection,
    selectFolderPath,
    selectedEntriesInVisibleOrder,
} from '../../public/manager/src/folder-panel/folder-selection.js';
import type { FolderPanelEntry } from '../../public/manager/src/folder-panel/folder-sources.js';

const rootEntries: FolderPanelEntry[] = [
    { name: 'src', path: '/repo/src', kind: 'directory', size: 0 },
    { name: 'README.md', path: '/repo/README.md', kind: 'file', size: 10 },
];

const childEntries: FolderPanelEntry[] = [
    { name: 'a.ts', path: '/repo/src/a.ts', kind: 'file', size: 1 },
    { name: 'b.ts', path: '/repo/src/b.ts', kind: 'file', size: 1 },
];

function visiblePaths(expanded = true): string[] {
    const cache = new Map(expanded ? [['/repo/src', childEntries]] : []);
    return flattenVisibleFolderEntries(rootEntries, cache, expanded ? new Set(['/repo/src']) : new Set()).map(entry => entry.path);
}

test('folder selection flattening respects expansion state', () => {
    assert.deepEqual(visiblePaths(false), ['/repo/src', '/repo/README.md']);
    assert.deepEqual(visiblePaths(true), ['/repo/src', '/repo/src/a.ts', '/repo/src/b.ts', '/repo/README.md']);
});

test('folder selection supports single, toggle, and range selection', () => {
    const paths = visiblePaths();
    const single = selectFolderPath(emptyFolderSelection, '/repo/src/a.ts', paths);
    assert.deepEqual(single.selectedPaths, ['/repo/src/a.ts']);
    const toggled = selectFolderPath(single, '/repo/src/b.ts', paths, { toggle: true });
    assert.deepEqual(toggled.selectedPaths, ['/repo/src/a.ts', '/repo/src/b.ts']);
    const toggledOnly = selectFolderPath(single, '/repo/src/a.ts', paths, { toggle: true });
    assert.deepEqual(toggledOnly.selectedPaths, ['/repo/src/a.ts']);
    const ranged = selectFolderPath(single, '/repo/README.md', paths, { range: true });
    assert.deepEqual(ranged.selectedPaths, ['/repo/src/a.ts', '/repo/src/b.ts', '/repo/README.md']);
});

test('folder selection moves keyboard focus with and without range extension', () => {
    const paths = visiblePaths();
    const single = selectFolderPath(emptyFolderSelection, '/repo/src/a.ts', paths);
    assert.deepEqual(moveFolderKeyboardSelection(single, paths, 'down', false), {
        selectedPaths: ['/repo/src/b.ts'],
        focusedPath: '/repo/src/b.ts',
        anchorPath: '/repo/src/b.ts',
    });
    assert.deepEqual(moveFolderKeyboardSelection(single, paths, 'down', true), {
        selectedPaths: ['/repo/src/a.ts', '/repo/src/b.ts'],
        focusedPath: '/repo/src/b.ts',
        anchorPath: '/repo/src/a.ts',
    });
});

test('folder selection prunes hidden rows and preserves visible order', () => {
    const expandedPaths = visiblePaths();
    const selected = selectFolderPath(
        selectFolderPath(emptyFolderSelection, '/repo/src/a.ts', expandedPaths),
        '/repo/README.md',
        expandedPaths,
        { toggle: true },
    );
    const pruned = pruneFolderSelection(selected, visiblePaths(false));
    assert.deepEqual(pruned.selectedPaths, ['/repo/README.md']);
    const selectedSet = new Set(selected.selectedPaths);
    assert.deepEqual(
        selectedEntriesInVisibleOrder([...rootEntries, ...childEntries], selectedSet).map(entry => entry.path),
        ['/repo/README.md', '/repo/src/a.ts'],
    );
});
