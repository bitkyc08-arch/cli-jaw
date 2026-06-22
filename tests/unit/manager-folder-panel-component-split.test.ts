import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('FolderPanel delegates toolbar and recursive row rendering to focused components', () => {
    const panel = read('public/manager/src/folder-panel/FolderPanel.tsx');
    const toolbar = read('public/manager/src/folder-panel/FolderPanelToolbar.tsx');
    const tree = read('public/manager/src/folder-panel/FolderPanelTree.tsx');
    const rows = read('public/manager/src/folder-panel/FolderTreeRows.tsx');

    assert.ok(panel.includes("import { FolderPanelToolbar } from './FolderPanelToolbar'"), 'FolderPanel must import FolderPanelToolbar');
    assert.ok(panel.includes("import { FolderPanelTree } from './FolderPanelTree'"), 'FolderPanel must import FolderPanelTree');
    assert.ok(panel.includes('<FolderPanelToolbar'), 'FolderPanel must render the toolbar component');
    assert.ok(panel.includes('<FolderPanelTree'), 'FolderPanel must render the tree component');
    assert.ok(tree.includes('<FolderTreeRows'), 'FolderPanelTree must render the row component');
    assert.ok(toolbar.includes('Open Folder'), 'toolbar owns the empty-root open-folder action');
    assert.ok(rows.includes('export function FolderTreeRows'), 'recursive row rendering must live outside FolderPanel');
    assert.equal(panel.includes('function renderEntries'), false, 'FolderPanel must not keep recursive row rendering inline');
});

test('FolderPanel remains below the file-size limit after the split', () => {
    const panelLines = read('public/manager/src/folder-panel/FolderPanel.tsx').split('\n').length;

    assert.ok(panelLines <= 500, `FolderPanel.tsx must stay at or below 500 lines, got ${panelLines}`);
});

test('folder panel shared helpers and types have canonical owners', () => {
    const panel = read('public/manager/src/folder-panel/FolderPanel.tsx');
    const state = read('public/manager/src/folder-panel/folder-panel-state.ts');
    const types = read('public/manager/src/folder-panel/folder-panel-types.ts');
    const sources = read('public/manager/src/folder-panel/folder-sources.ts');

    assert.ok(state.includes('export function parentPath'), 'parentPath must live in folder-panel-state');
    assert.ok(state.includes('export function isDescendantPath'), 'isDescendantPath must live in folder-panel-state');
    assert.ok(state.includes('export function relativeFolderPath'), 'relativeFolderPath must live in folder-panel-state');
    assert.ok(state.includes('export function dropCachedBranches'), 'cache invalidation helper must live in folder-panel-state');
    assert.ok(types.includes('export type FolderPanelEntry'), 'FolderPanelEntry must live in folder-panel-types');
    assert.ok(sources.includes("} from './folder-panel-types'"), 'folder-sources must re-export moved types for compatibility');
    assert.equal(panel.includes('function parentPath'), false, 'FolderPanel must not keep path helpers inline');
});
