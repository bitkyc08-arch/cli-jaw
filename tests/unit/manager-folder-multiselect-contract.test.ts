import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panel = readFileSync('public/manager/src/folder-panel/FolderPanel.tsx', 'utf8');
const tree = readFileSync('public/manager/src/folder-panel/FolderPanelTree.tsx', 'utf8');
const rows = readFileSync('public/manager/src/folder-panel/FolderTreeRows.tsx', 'utf8');
const dragPayload = readFileSync('public/manager/src/folder-panel/folder-drag-payload.ts', 'utf8');
const css = readFileSync('public/manager/src/folder-panel/folder-panel.css', 'utf8');

test('FolderPanel delegates multi-selection to the selection hook', () => {
    assert.ok(panel.includes("import { useFolderSelection"), 'FolderPanel must import the selection hook');
    assert.ok(panel.includes('folderSelection.moveKeyboardSelection'), 'FolderPanel must route keyboard range movement through the hook');
    assert.ok(panel.includes("copySelectedPath('absolute')"), 'context menu absolute copy must use the selected set');
    assert.ok(panel.includes('revealSelectedPath()'), 'context menu reveal must use the primary selected entry');
    assert.ok(tree.includes('aria-multiselectable="true"'), 'tree must expose multi-select semantics');
    assert.ok(tree.includes('folderSelection.selectedPaths'), 'tree must pass selected paths to rows');
});

test('FolderTreeRows renders multi-select state and drag primary contracts', () => {
    assert.ok(rows.includes('props.selectedPaths.has(entry.path)'), 'rows must render selected state from a selected path set');
    assert.ok(rows.includes('props.focusedPath === entry.path'), 'rows must render focused row state');
    assert.ok(rows.includes('props.getDragSelectionFor(entry)'), 'rows must ask the hook for drag selection');
    assert.ok(rows.includes('props.requestMove(props.dragSelection.primaryEntry, entry)'), 'moves must use the dragged primary entry');
    assert.equal(rows.includes('entries[0]'), false, 'rows must not use entries[0] as move primary');
});

test('folder drag payload and CSS support multi-selection', () => {
    assert.ok(dragPayload.includes('primaryPath'), 'drag payload must expose primary path metadata');
    assert.ok(dragPayload.includes('entries?:'), 'drag payload must expose multi-entry metadata');
    assert.ok(css.includes('.folder-entry.is-selected'), 'CSS must style selected rows');
    assert.ok(css.includes('.folder-entry.is-focused'), 'CSS must style focused rows independently');
});
