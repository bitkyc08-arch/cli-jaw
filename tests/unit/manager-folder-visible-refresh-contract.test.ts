import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const folderPanelSource = readFileSync('public/manager/src/folder-panel/FolderPanel.tsx', 'utf8');
const refreshHookSource = readFileSync('public/manager/src/folder-panel/use-folder-visible-refresh.ts', 'utf8');

test('FolderPanel refresh reloads the visible expanded tree and git summaries', () => {
    assert.ok(folderPanelSource.includes("import { useFolderVisibleRefresh } from './use-folder-visible-refresh'"), 'FolderPanel must use the visible refresh hook');
    assert.ok(folderPanelSource.includes('const visibleRefresh = useFolderVisibleRefresh({'), 'FolderPanel must instantiate the refresh hook');
    assert.ok(folderPanelSource.includes("void refreshVisibleTree('manual')"), 'toolbar/context actions must call the hook refresh path');
    assert.ok(refreshHookSource.includes('export type FolderRefreshReason'), 'refresh hook must expose typed refresh reasons');
    assert.ok(refreshHookSource.includes('const expandedPaths = Array.from(new Set'), 'refresh must snapshot expanded and extra visible paths');
    assert.ok(refreshHookSource.includes('await loadDir(rootPath)'), 'refresh must reload the root entries');
    assert.ok(refreshHookSource.includes('await loadChildren(path, { force: true })'), 'refresh must force reload expanded child entries');
    assert.ok(refreshHookSource.includes('refreshWorktrees();'), 'refresh must also refresh git worktree summaries');
    assert.ok(refreshHookSource.includes('onGitRefresh?.();'), 'refresh must notify the shared diff/git refresh bus');
});

test('FolderPanel visible refresh reports status without replacing action errors', () => {
    assert.ok(folderPanelSource.includes('visibleRefresh.watchStatus'), 'watch failures must render through FolderPanel status');
    assert.ok(folderPanelSource.includes('visibleRefresh.refreshStatus'), 'coalesced refresh status must render through FolderPanel status');
    assert.ok(folderPanelSource.includes('!error'), 'refresh status must not hide errors');
});
