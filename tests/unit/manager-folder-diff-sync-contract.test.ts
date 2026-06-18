import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const routerSource = readFileSync('public/manager/src/SidebarRailRouter.tsx', 'utf8');
const diffPanelSource = readFileSync('public/manager/src/diff-panel/DiffPanel.tsx', 'utf8');
const folderPanelSource = readFileSync('public/manager/src/folder-panel/FolderPanel.tsx', 'utf8');

test('right sidebar router passes shared workbench state into DiffPanel', () => {
    assert.ok(routerSource.includes('folderRootPath={folderRootPath}'), 'DiffPanel must receive the right sidebar folder root');
    assert.ok(routerSource.includes('repoRootPath={repoRootPath}'), 'DiffPanel must receive the shared repo root');
    assert.ok(routerSource.includes('selectedFilePath={previewFilePath}'), 'DiffPanel must receive the right sidebar selected file');
    assert.ok(routerSource.includes('onRepoRootChange={onRepoRootChange}'), 'DiffPanel must update only the shared repo root');
    assert.ok(routerSource.includes('onPreviewFile={onPreviewFile}'), 'DiffPanel must be able to update the shared preview file');
    assert.ok(routerSource.includes('onGitRefresh={onGitRefresh}'), 'DiffPanel must be able to refresh shared git decorations after SCM actions');
    assert.ok(!routerSource.includes('onFolderRootChange={onFolderRootChange}'), 'DiffPanel must not receive the FolderPanel root mutator');
});

test('DiffPanel treats FolderPanel root as a first-class repo candidate', () => {
    assert.ok(diffPanelSource.includes('folderRootPath?: string | null'), 'DiffPanel props must expose FolderPanel root');
    assert.ok(diffPanelSource.includes('selectedFilePath?: string | null'), 'DiffPanel props must expose selected FolderPanel file');
    assert.ok(diffPanelSource.includes('function folderRepoCandidate'), 'DiffPanel must label the FolderPanel root as a repo candidate');
    assert.ok(diffPanelSource.includes('candidates.unshift(folderRepoCandidate(folderRootPath))'), 'FolderPanel root must be preferred before instance/home candidates');
    assert.ok(diffPanelSource.includes('const folderRoot = folderRootPath'), 'repo selection must inspect the shared FolderPanel root');
    assert.ok(diffPanelSource.includes('const nextRoot = folderRoot ?? requestedRoot'), 'FolderPanel root must override a stale valid DiffPanel root');
});

test('DiffPanel and FolderPanel synchronize files but keep root changes one-way', () => {
    assert.ok(diffPanelSource.includes('function absoluteDiffPath'), 'DiffPanel must convert repo-relative diff paths to absolute FolderPanel paths');
    assert.ok(diffPanelSource.includes('function relativeDiffPath'), 'DiffPanel must convert absolute FolderPanel paths to repo-relative diff paths');
    assert.ok(diffPanelSource.includes('onGitRefresh?: () => void'), 'DiffPanel props must expose the shared git refresh callback');
    assert.ok(!diffPanelSource.includes('props.onFolderRootChange?.(root)'), 'DiffPanel root changes must not update FolderPanel root');
    assert.ok(diffPanelSource.includes('props.onRepoRootChange?.(root)') || diffPanelSource.includes('onRepoRootChange?.(root)'), 'DiffPanel root changes must update only repo root state');
    assert.ok(diffPanelSource.includes('props.onPreviewFile?.(absolutePath)'), 'DiffPanel file clicks must update shared preview/folder selection');
    assert.ok(diffPanelSource.includes('relativeDiffPath(repoRoot, props.selectedFilePath ?? null)'), 'FolderPanel file selection must be able to select the matching diff item');
    assert.ok(diffPanelSource.includes('onClick={() => handleFileSelect(f.path)}'), 'diff file rows must route through the synchronized selection helper');
    assert.ok(diffPanelSource.includes('props.onGitRefresh?.()'), 'SCM operations must bump shared git decoration refresh after local reload');
});

test('FolderPanel consumes shared selected file paths for visible-row synchronization', () => {
    assert.ok(folderPanelSource.includes('const selectedPath = props.selectedFilePath'), 'FolderPanel must read the shared preview file path');
    assert.ok(folderPanelSource.includes('isDescendantPath(rootPath, selectedPath)'), 'FolderPanel must ignore selected files outside the current folder root');
    assert.ok(folderPanelSource.includes('folderSelection.visiblePaths.includes(selectedPath)'), 'FolderPanel must only select currently visible rows');
    assert.ok(folderPanelSource.includes('folderSelection.selectOnlyPath(selectedPath)'), 'FolderPanel must select the matching visible row');
});

test('DiffPanel file rows use native button selection with separate SCM actions', () => {
    assert.ok(diffPanelSource.includes('className="diff-file-select"'), 'diff file selection must use a native button target');
    assert.ok(!diffPanelSource.includes('role="button"'), 'diff file rows must not emulate buttons with div role=button');
    assert.ok(diffPanelSource.includes('className="diff-scm-inline-action"'), 'inline SCM action must remain a separate button');
});
