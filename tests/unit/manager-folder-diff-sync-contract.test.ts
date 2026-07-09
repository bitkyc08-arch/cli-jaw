import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const routerSource = readFileSync('public/manager/src/SidebarRailRouter.tsx', 'utf8');
const diffPanelSource = readFileSync('public/manager/src/diff-panel/DiffPanel.tsx', 'utf8');
const folderPanelSource = readFileSync('public/manager/src/folder-panel/FolderPanel.tsx', 'utf8');
const previewSyncSource = readFileSync('public/manager/src/folder-panel/use-folder-preview-sync.ts', 'utf8');
const workbenchTypesSource = readFileSync('public/manager/src/workbench/workbench-resource-types.ts', 'utf8');
const workbenchStateSource = readFileSync('public/manager/src/workbench/useWorkbenchResourceState.ts', 'utf8');

test('right sidebar router passes shared workbench state into DiffPanel', () => {
    assert.ok(routerSource.includes('folderRootPath={files.folderRootPath ?? ctx.fallbackFolderRootPath}'), 'DiffPanel must receive the active Files tab folder root with registry fallback');
    assert.ok(routerSource.includes('repoRootPath={files.repoRootPath ?? null}'), 'DiffPanel must receive the active Files tab repo root');
    assert.ok(routerSource.includes("repoRootMode={files.repoRootMode ?? 'instance'}"), 'DiffPanel must receive active Files tab manual/follow repo mode');
    assert.ok(routerSource.includes('selectedFilePath={files.activeFilePath ?? null}'), 'DiffPanel must receive the active Files tab selected file');
    assert.ok(routerSource.includes('onRepoRootChange={(path, mode) => { if (refTab) ctx.onTabRepoRootChange(refTab.id, path, mode); }}'), 'DiffPanel must update only the active Files tab repo root');
    assert.ok(routerSource.includes('onFollowInstanceRepoRoot={path => ctx.onFollowInstanceRepoRoot(refTab?.id ?? null, path)}'), 'DiffPanel must be able to resume instance-following mode for the active Files tab');
    assert.ok(routerSource.includes('onPreviewFile={ctx.onOpenFileGlobal}'), 'DiffPanel file clicks must open/focus a Files tab and update its preview file');
    assert.ok(routerSource.includes('onGitRefresh={ctx.onGitRefresh}'), 'DiffPanel must be able to refresh shared git decorations after SCM actions');
    assert.ok(!routerSource.includes('onFolderRootChange={onFolderRootChange}'), 'DiffPanel must not receive the FolderPanel root mutator');
});

test('DiffPanel treats FolderPanel root as a first-class repo candidate', () => {
    assert.ok(diffPanelSource.includes('folderRootPath?: string | null'), 'DiffPanel props must expose FolderPanel root');
    assert.ok(diffPanelSource.includes('repoRootMode?: WorkbenchRepoRootMode'), 'DiffPanel props must expose manual/follow root mode');
    assert.ok(diffPanelSource.includes('selectedFilePath?: string | null'), 'DiffPanel props must expose selected FolderPanel file');
    assert.ok(diffPanelSource.includes('function folderRepoCandidate'), 'DiffPanel must label the FolderPanel root as a repo candidate');
    assert.ok(diffPanelSource.includes('candidates.unshift(folderRepoCandidate(folderRootPath))'), 'FolderPanel root must be preferred before instance/home candidates');
    assert.ok(diffPanelSource.includes('function instanceFollowRoot'), 'repo selection must compute instance/folder follow roots through one helper');
    assert.ok(diffPanelSource.includes("repoRootMode === 'manual'"), 'manual DiffPanel root must not be overwritten by FolderPanel root changes');
    assert.ok(diffPanelSource.includes("onRepoRootChange?.(nextRoot, 'instance')"), 'automatic repo sync must mark instance-following mode');
});

test('DiffPanel and FolderPanel synchronize files but keep root changes one-way', () => {
    assert.ok(diffPanelSource.includes('function absoluteDiffPath'), 'DiffPanel must convert repo-relative diff paths to absolute FolderPanel paths');
    assert.ok(diffPanelSource.includes('function relativeDiffPath'), 'DiffPanel must convert absolute FolderPanel paths to repo-relative diff paths');
    assert.ok(diffPanelSource.includes('onGitRefresh?: () => void'), 'DiffPanel props must expose the shared git refresh callback');
    assert.ok(!diffPanelSource.includes('props.onFolderRootChange?.(root)'), 'DiffPanel root changes must not update FolderPanel root');
    assert.ok(diffPanelSource.includes("onRepoRootChange?.(root, mode)"), 'DiffPanel root changes must update only repo root state with an explicit mode');
    assert.ok(diffPanelSource.includes('props.onPreviewFile?.(absolutePath)'), 'DiffPanel file clicks must update shared preview/folder selection');
    assert.ok(diffPanelSource.includes('relativeDiffPath(repoRoot, props.selectedFilePath ?? null)'), 'FolderPanel file selection must be able to select the matching diff item');
    assert.ok(diffPanelSource.includes('onClick={() => handleFileSelect(f.path)}'), 'diff file rows must route through the synchronized selection helper');
    assert.ok(diffPanelSource.includes('props.onGitRefresh?.()'), 'SCM operations must bump shared git decoration refresh after local reload');
});

test('Workbench repo root state preserves manual override until Follow Instance', () => {
    assert.ok(workbenchTypesSource.includes("export type WorkbenchRepoRootMode = 'instance' | 'manual'"), 'workbench resource types must name repo root mode');
    assert.ok(workbenchStateSource.includes("repoRootModeRef.current === 'manual'"), 'instance repo sync must be ignored while manual override is active');
    assert.ok(workbenchStateSource.includes('followInstanceRepoRoot'), 'workbench state must expose an explicit follow-instance reset action');
    assert.ok(diffPanelSource.includes('Follow Instance'), 'DiffPanel must expose the visible reset action label');
    assert.ok(diffPanelSource.includes('delete nextPinned[String(port)]'), 'Follow Instance must clear the pinned per-instance manual root');
});

test('FolderPanel root changes do not reuse stale or manual Diff repo roots', () => {
    const gitStatusBlock = folderPanelSource.slice(
        folderPanelSource.indexOf('const gitStatus = useFolderGitStatus({'),
        folderPanelSource.indexOf('const worktreeState = useGitWorktrees({'),
    );
    assert.ok(
        routerSource.includes("repoRootPath={repoRootMode === 'instance' ? files.repoRootPath ?? null : null}"),
        'FolderPanel must ignore manual Diff repo overrides and auto-detect its own root',
    );
    assert.ok(
        routerSource.includes("panelLayout.dispatch({ type: 'SET_FILES_TAB_ROOT', tabId, path })"),
        'FolderPanel root changes must update the active Files tab root rather than shared legacy root state',
    );
    assert.equal(
        gitStatusBlock.includes('repoRoot'),
        false,
        'FolderPanel git status must resolve from the folder root instead of passing stale shared repo roots',
    );
});

test('FolderPanel consumes shared selected file paths for visible-row synchronization', () => {
    assert.ok(folderPanelSource.includes('useFolderPreviewSync({'), 'FolderPanel must delegate preview-path sync to the dedicated hook');
    assert.ok(folderPanelSource.includes('selectedFilePath: props.selectedFilePath'), 'FolderPanel must pass the shared preview file path into the sync hook');
    assert.ok(previewSyncSource.includes('syncedPreviewPathRef'), 'preview-sync hook must track preview-path changes separately from local row selection');
    assert.ok(previewSyncSource.includes('if (!previewPathChanged && selectedPath) return;'), 'local row clicks must not be overwritten by an unchanged preview file path');
    assert.ok(previewSyncSource.includes('isDescendantPath(rootPath, previewPath)'), 'preview-sync hook must ignore preview files outside the current folder root');
    assert.ok(previewSyncSource.includes('visiblePaths.includes(previewPath)'), 'preview-sync hook must only select currently visible rows');
    assert.ok(previewSyncSource.includes('selectOnlyPath(previewPath)'), 'preview-sync hook must select the matching visible row');
});

test('DiffPanel file rows use native button selection with separate SCM actions', () => {
    assert.ok(diffPanelSource.includes('className="diff-file-select"'), 'diff file selection must use a native button target');
    assert.ok(!diffPanelSource.includes('role="button"'), 'diff file rows must not emulate buttons with div role=button');
    assert.ok(diffPanelSource.includes('className="diff-scm-inline-action"'), 'inline SCM action must remain a separate button');
});
