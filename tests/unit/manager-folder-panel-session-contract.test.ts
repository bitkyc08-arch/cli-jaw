import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function read(path: string): string {
    return readFileSync(path, 'utf8');
}

const sessionSource = read('public/manager/src/folder-panel/folder-panel-session.ts');
const folderPanelSource = read('public/manager/src/folder-panel/FolderPanel.tsx');
const folderSelectionSource = read('public/manager/src/folder-panel/use-folder-selection.ts');
const sidebarRouterSource = read('public/manager/src/SidebarRailRouter.tsx');
const folderPanelPropsSource = read('public/manager/src/folder-panel/folder-panel-props.ts');

test('FolderPanel session helper owns serializable same-session tree snapshots', () => {
    assert.ok(sessionSource.includes('export type FolderPanelSessionState'), 'session helper must export FolderPanelSessionState');
    assert.ok(sessionSource.includes('expandedPaths: string[]'), 'session state must serialize expanded paths');
    assert.ok(sessionSource.includes('FolderPanelChildrenCacheSnapshot'), 'session state must serialize child cache snapshots');
    assert.ok(sessionSource.includes('childrenCacheToSnapshot'), 'session helper must convert Map cache to snapshots');
    assert.ok(sessionSource.includes('snapshotToChildrenCache'), 'session helper must restore Map cache from snapshots');
    assert.ok(sessionSource.includes('folderPanelSessionFromState'), 'session helper must build snapshots from live FolderPanel state');
});

test('FolderPanel restores session state while preserving real root reset boundaries', () => {
    assert.ok(folderPanelPropsSource.includes('sessionState?: FolderPanelSessionState'), 'FolderPanel props must accept a session snapshot');
    assert.ok(folderPanelPropsSource.includes('onSessionStateChange?:'), 'FolderPanel props must emit session snapshots');
    assert.ok(folderPanelSource.includes('snapshotToChildrenCache(initialSession.childrenCache)'), 'FolderPanel must restore cached expanded children');
    assert.ok(folderPanelSource.includes('new Set(initialSession?.expandedPaths ?? [])'), 'FolderPanel must restore expanded paths');
    assert.ok(folderPanelSource.includes('initialSelection: initialSession?.selection'), 'FolderPanel must restore selection through useFolderSelection');
    assert.ok(folderPanelSource.includes('setExpanded(new Set())'), 'openFolderRoot must still reset expanded state on true root changes');
    assert.ok(folderPanelSource.includes('setChildrenCache(new Map())'), 'openFolderRoot must still reset cached children on true root changes');
    assert.ok(folderPanelSource.includes('folderSelection.resetSelection()'), 'openFolderRoot/clear root paths must still reset selection');
    assert.ok(folderPanelSource.includes('restoredRootLoadRef'), 'restored external roots must be reloaded through openFolderRoot at most once');
    assert.ok(folderPanelSource.includes('entries.length > 0 || restoredRootLoadRef.current === externalRoot'), 'empty restored sessions must authorize and reload the external root');
});

test('SidebarRailRouter owns FolderPanel session above right-panel mode remounts', () => {
    assert.ok(sidebarRouterSource.includes('useState<Record<string, FolderPanelSessionState | null>>'), 'SidebarRailRouter must own FolderPanel sessions per Files tab');
    assert.ok(sidebarRouterSource.includes('sessionState={ctx.folderSessions[tab.id] ?? null}'), 'FolderPanel must receive the router-owned session for its tab');
    assert.ok(sidebarRouterSource.includes('onSessionStateChange={state => ctx.onFolderSessionChange(tab.id, state)}'), 'FolderPanel must publish snapshots to the router by tab id');
    assert.ok(sidebarRouterSource.includes('setFolderSessions(current => (current[tabId] ? { ...current, [tabId]: null } : current))'), 'router must guard session state when a tab root changes');
    assert.ok(sidebarRouterSource.includes('const folderRoot = files.folderRootPath ?? ctx.fallbackFolderRootPath'), 'settings hydration must be only a fallback for tabs without their own root');
});

test('useFolderSelection can restore a serialized selection without changing current actions', () => {
    assert.ok(folderSelectionSource.includes('initialSelection?: FolderSelectionState'), 'selection hook must accept an initial selection');
    assert.ok(folderSelectionSource.includes('input.initialSelection ?? emptyFolderSelection'), 'selection hook must initialize from restored session or empty selection');
    assert.ok(folderSelectionSource.includes('selectEntry: (entry: FolderPanelEntry'), 'selection hook public actions must remain available');
    assert.ok(folderSelectionSource.includes('moveKeyboardSelection: (direction: SelectionDirection'), 'keyboard multi-select action must remain available');
});
