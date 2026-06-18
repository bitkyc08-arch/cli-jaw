import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FolderBridgeApi } from '../../public/manager/src/panels/desktop-bridge.js';
import { createElectronFolderSource, createNotesVaultFolderSource } from '../../public/manager/src/folder-panel/folder-sources.js';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('FolderPanel wires native move, copy, reveal, and confirmation actions', () => {
    const panel = read('public/manager/src/folder-panel/FolderPanel.tsx');
    const rows = read('public/manager/src/folder-panel/FolderTreeRows.tsx');
    const moveConfirm = read('public/manager/src/folder-panel/FolderMoveConfirmDialog.tsx');

    assert.ok(panel.includes("import { copyText } from '../clipboard/copy-text'"), 'FolderPanel must use the shared copyText helper');
    assert.ok(rows.includes('draggable={props.canUseNativeActions}'), 'FolderPanel rows must become draggable in Electron mode');
    assert.ok(panel.includes('const [pendingMove'), 'FolderPanel must store pending move confirmation state');
    assert.ok(panel.includes('skipInternalMoveConfirm'), 'FolderPanel must support session-local skip confirmation state');
    assert.ok(moveConfirm.includes('className="folder-move-confirm"'), 'FolderPanel must render a move confirmation surface');
    assert.ok(panel.includes('source.movePath'), 'FolderPanel must call the source move path API');
    assert.ok(panel.includes('source.revealPath'), 'FolderPanel must call the source reveal path API');
    assert.ok(panel.includes("import { useFolderSelection"), 'FolderPanel must delegate selection ownership to the selection hook');
    assert.ok(panel.includes('onPreviewFile,'), 'file preview behavior must be wired into the selection hook');
    assert.ok(panel.includes('const toggleEntryExpansion = useCallback'), 'directory expansion must be a separate helper');
    assert.ok(rows.includes('props.selectEntry(entry, { range: event.shiftKey, toggle: isPlatformToggleClick(event) })'), 'row click must pass multi-select modifiers without expanding');
    assert.ok(rows.includes('props.toggleEntryExpansion(entry)'), 'row disclosure/double-click must expand separately');
    assert.ok(panel.includes('<FolderPanelTree'), 'FolderPanel must delegate tree rendering to the extracted component');
});

test('FolderPanel uses arrow and double-click for directory expansion', () => {
    const panel = read('public/manager/src/folder-panel/FolderPanel.tsx');
    const rows = read('public/manager/src/folder-panel/FolderTreeRows.tsx');

    assert.ok(rows.includes('folder-entry-disclosure'), 'directory rows must expose a dedicated disclosure target');
    assert.ok(rows.includes('onDoubleClick'), 'directory rows must support double-click expansion');
    assert.ok(rows.includes('event.stopPropagation()'), 'disclosure activation must not also trigger row selection bubbling');
    assert.ok(panel.includes("if (event.key === 'Enter')"), 'keyboard Enter must keep explicit row activation');
    assert.ok(panel.includes("if (entry.kind === 'directory') toggleEntryExpansion(entry)"), 'Enter must expand directories through the same helper');
    assert.ok(panel.includes('else selectEntry(entry)'), 'Enter must preview files through the selection helper');
});

test('FolderPanel separates preview selection from local action selection', () => {
    const panel = read('public/manager/src/folder-panel/FolderPanel.tsx');
    const rows = read('public/manager/src/folder-panel/FolderTreeRows.tsx');

    const tree = read('public/manager/src/folder-panel/FolderPanelTree.tsx');
    assert.ok(rows.includes('props.selectedPaths.has(entry.path)'), 'local action selection must use selectedPaths');
    assert.ok(
        rows.includes('aria-selected={props.selectedPaths.has(entry.path)}'),
        'aria-selected must expose local multi-selection state',
    );
    assert.ok(rows.includes("'is-selected'"), 'local selection must use a separate CSS class');
    assert.ok(tree.includes('aria-multiselectable="true"'), 'tree must advertise multi-selection semantics');
});

test('FolderPanel starts from explicit initial root policy instead of project roots', () => {
    const panel = read('public/manager/src/folder-panel/FolderPanel.tsx');
    const sources = read('public/manager/src/folder-panel/folder-sources.ts');

    assert.ok(panel.includes('source.getInitialRoot()'), 'FolderPanel must use the source initial-root policy');
    assert.equal(panel.includes('source.getDefaultRoot()'), false, 'FolderPanel must not call getDefaultRoot on mount');
    assert.equal(panel.includes('projectDirs'), false, 'FolderPanel must not import or mutate projectDirs');
    assert.ok(panel.includes('props.onRootChange?.(authorizedRoot)'), 'manual and persisted roots must sync the authorized parent external root state through the shared opener');
    assert.ok(panel.includes('try {'), 'manual Open Folder must guard async picker failures');
    assert.ok(panel.includes('setError((err as Error).message)'), 'manual Open Folder must surface non-cancel picker failures in the panel');
    assert.ok(panel.includes('rootPath !== null &&'), 'empty root state must keep the action row hidden until a root exists');
    assert.ok(sources.includes("result.error === 'cancelled'"), 'Electron source must normalize picker cancellation into a null result');
    assert.ok(sources.includes('getInitialRoot: async () => null'), 'Electron source must start with an empty root');
    assert.ok(sources.includes("getInitialRoot: async () => ''"), 'notes-vault source must keep its virtual notes root');
});

test('FolderPanel uses an in-panel mutation dialog instead of browser prompts', () => {
    const panel = read('public/manager/src/folder-panel/FolderPanel.tsx');
    const mutations = read('public/manager/src/folder-panel/use-folder-mutations.ts');
    const overlays = read('public/manager/src/folder-panel/FolderPanelOverlays.tsx');
    const dialog = read('public/manager/src/folder-panel/FolderMutationDialog.tsx');

    assert.equal(panel.includes('window.prompt'), false, 'FolderPanel must not rely on browser prompt dialogs for Electron file mutations');
    assert.ok(panel.includes("import { useFolderMutations } from './use-folder-mutations'"), 'FolderPanel must delegate mutation state to the mutation hook');
    assert.ok(mutations.includes('const [mutationDialog'), 'mutation hook must own file mutation dialog state');
    assert.ok(mutations.includes('requestCreateEntry'), 'mutation hook must open the mutation dialog for create actions');
    assert.ok(mutations.includes('requestRenameSelectedEntry'), 'mutation hook must open the mutation dialog for rename actions');
    assert.ok(mutations.includes('submitMutation'), 'mutation hook must submit create and rename actions through one visible dialog path');
    assert.ok(mutations.includes('renamedPreviewPath'), 'mutation hook must translate the open document preview when a selected file or parent directory is renamed');
    assert.ok(mutations.includes('onPreviewFile?.(nextPreviewPath)'), 'rename must move the DocPanel preview to the new file path');
    assert.ok(overlays.includes('FolderMutationDialog'), 'FolderPanel overlays must render the mutation dialog');
    assert.ok(dialog.includes('role="dialog"'), 'mutation dialog must expose native dialog semantics');
    assert.ok(dialog.includes('autoFocus'), 'mutation dialog must focus the entry name input');
});

test('electron folder source treats picker cancellation as a non-error', async () => {
    const bridge = mockFolderBridge(async () => ({ ok: false, error: 'cancelled' }));
    const source = createElectronFolderSource(bridge);

    await assert.doesNotReject(async () => {
        assert.equal(await source.pickRoot?.(), null);
    });
});

test('electron folder source still rejects real picker failures', async () => {
    const bridge = mockFolderBridge(async () => ({ ok: false, error: 'permission denied' }));
    const source = createElectronFolderSource(bridge);

    await assert.rejects(
        async () => source.pickRoot?.(),
        /permission denied/,
    );
});

test('folder panel CSS exposes selected, drop target, drag, action, and confirm states', () => {
    const css = read('public/manager/src/folder-panel/folder-panel.css');
    const actionRow = read('public/manager/src/folder-panel/FolderActionRow.tsx');

    for (const selector of [
        '.folder-entry.is-selected',
        '.folder-entry.is-drop-target',
        '.folder-entry.is-dragging',
        '.folder-action-row',
        '.folder-action-btn',
        '.folder-entry-disclosure',
        '.folder-unavailable',
        '.folder-shortcut-hint',
        '.folder-move-confirm',
        '.folder-move-confirm__actions',
        '.folder-status',
        '.folder-mutation-dialog',
    ]) {
        assert.ok(css.includes(selector), `folder panel CSS must include ${selector}`);
    }
    assert.ok(actionRow.includes('className="folder-action-row"'), 'action row component must keep the compact action surface');
});

test('notes-vault folder source remains read-only for native filesystem actions', () => {
    const source = createNotesVaultFolderSource([], 'notes');

    assert.equal(source.kind, 'notes-vault');
    assert.equal(source.canPickRoot, false);
    assert.equal(source.movePath, undefined);
    assert.equal(source.createFile, undefined);
    assert.equal(source.createFolder, undefined);
    assert.equal(source.renamePath, undefined);
    assert.equal(source.revealPath, undefined);
});

function mockFolderBridge(pickFolder: FolderBridgeApi['pickFolder']): FolderBridgeApi {
    return {
        getDefaultRoot: async () => ({ ok: true, path: '/tmp' }),
        pickFolder,
        listDir: async () => ({ ok: true, entries: [] }),
        readFile: async () => ({ ok: true, content: '' }),
        movePath: async () => ({ ok: true }),
        createFile: async (_parentDirectory, name) => ({ ok: true, entry: { name, path: `/tmp/${name}`, kind: 'file', size: 0 } }),
        createFolder: async (_parentDirectory, name) => ({ ok: true, entry: { name, path: `/tmp/${name}`, kind: 'directory', size: 0 } }),
        renamePath: async (_sourcePath, name) => ({ ok: true, entry: { name, path: `/tmp/${name}`, kind: 'file', size: 0 } }),
        revealPath: async () => ({ ok: true }),
        watchDir: async () => ({ ok: true }),
        unwatchDir: async () => ({ ok: true }),
        onDirChange: () => () => undefined,
    };
}
