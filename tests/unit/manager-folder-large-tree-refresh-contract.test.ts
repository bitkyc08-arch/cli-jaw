import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const refreshHookSource = readFileSync('public/manager/src/folder-panel/use-folder-visible-refresh.ts', 'utf8');
const folderPanelSource = readFileSync('public/manager/src/folder-panel/FolderPanel.tsx', 'utf8');

test('large expanded folder refresh has a bounded branch budget', () => {
    assert.ok(refreshHookSource.includes('MAX_EXPANDED_REFRESH_BRANCHES'), 'refresh hook must cap expanded branch refresh work');
    assert.ok(refreshHookSource.includes('.slice(0, MAX_EXPANDED_REFRESH_BRANCHES)'), 'expanded branch refresh must slice to the budget');
    assert.ok(refreshHookSource.includes('skippedCount'), 'refresh hook must compute skipped overflow branches');
    assert.ok(refreshHookSource.includes('overflow branches skipped'), 'overflow budget must be visible in status copy');
});

test('move and mutation refresh only invalidate affected cached branches before visible refresh', () => {
    assert.ok(folderPanelSource.includes('dropCachedBranches(prev, [sourceParent, targetPath])'), 'move refresh must drop affected source and target branches');
    assert.ok(folderPanelSource.includes("refreshVisibleTree('move', { extraPaths: [sourceParent, targetPath] })"), 'move refresh must reload affected visible branches through the hook');
    assert.ok(folderPanelSource.includes('dropCachedBranches(prev, [parentDirectory, ...extraDroppedPaths])'), 'mutation refresh must drop affected parent and renamed branch cache');
    assert.ok(folderPanelSource.includes("refreshVisibleTree('mutation', { extraPaths: [parentDirectory] })"), 'mutation refresh must reload the affected parent through the hook');
});

test('FolderPanel refresh stays separate from project, terminal, iframe, and Electron rebuild scopes', () => {
    assert.equal(folderPanelSource.includes('projectDirs'), false, 'FolderPanel refresh must not mutate projectDirs');
    assert.equal(folderPanelSource.includes('terminal'), false, 'FolderPanel refresh must not mutate terminal cwd');
    assert.equal(folderPanelSource.includes('iframe'), false, 'FolderPanel refresh must not mutate preview iframe state');
    assert.equal(folderPanelSource.includes('electron:dist:mac'), false, 'FolderPanel refresh must not trigger Electron packaging');
});
