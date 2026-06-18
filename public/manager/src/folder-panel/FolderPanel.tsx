import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDesktop, type FolderBridgeApi } from '../panels/desktop-bridge';
import type { NotesTreeEntry } from '../notes/notes-types';
import { copyText } from '../clipboard/copy-text';
import { createElectronFolderSource, createNotesVaultFolderSource, type FolderPanelEntry } from './folder-sources';
import { FolderActionRow } from './FolderActionRow';
import { FolderPanelOverlays } from './FolderPanelOverlays';
import { FolderPanelToolbar } from './FolderPanelToolbar';
import { FolderWorktreeOpsDialog } from './FolderWorktreeOpsDialog';
import { FolderPanelTree } from './FolderPanelTree';
import { dropCachedBranches, isDescendantPath, parentPath, relativeFolderPath } from './folder-panel-state';
import { compatibleFolderPanelSession, folderPanelSessionFromState, snapshotToChildrenCache, type FolderPanelSessionState } from './folder-panel-session';
import { folderShortcutAction } from './folder-shortcuts';
import { runWorktreeOperation as runWorktreeOperationClient } from './folder-worktree-ops-client';
import type { GitWorktreeOperation } from './folder-worktree-types';
import { useFolderGitStatus } from './use-folder-git-status';
import { useGitWorktrees } from './use-git-worktrees';
import { useFolderChord } from './use-folder-chord';
import { useFolderSelection, type FolderDragSelection } from './use-folder-selection';
import './folder-panel.css';

function getFolderBridge(): FolderBridgeApi | null {
    return getDesktop()?.folder ?? null;
}

type FolderPanelProps = {
    selectedFilePath?: string | null | undefined;
    externalRootPath?: string | null | undefined;
    repoRootPath?: string | null | undefined;
    gitRefreshVersion?: number | undefined;
    notesTree?: NotesTreeEntry[] | undefined;
    notesRoot?: string | null | undefined;
    onRootChange?: ((path: string | null) => void) | undefined;
    onRepoRootChange?: ((path: string | null) => void) | undefined;
    onGitRefresh?: (() => void) | undefined;
    onPreviewFile?: ((path: string) => void) | undefined;
    sessionState?: FolderPanelSessionState | null | undefined;
    onSessionStateChange?: ((state: FolderPanelSessionState) => void) | undefined;
};

export function FolderPanel(props: FolderPanelProps) {
    const bridge = getFolderBridge();
    const repoRootPath = props.repoRootPath ?? null;
    const gitRefreshVersion = props.gitRefreshVersion ?? 0;
    const onGitRefresh = props.onGitRefresh;
    const onRepoRootChange = props.onRepoRootChange;
    const initialRootResolvedRef = useRef(false);
    const source = useMemo(() => bridge ? createElectronFolderSource(bridge) : createNotesVaultFolderSource(props.notesTree ?? [], props.notesRoot ?? null), [bridge, props.notesRoot, props.notesTree]);
    const initialSession = useMemo(() => compatibleFolderPanelSession(props.sessionState ?? null, props.externalRootPath ?? null), [props.externalRootPath, props.sessionState]);
    const [rootPath, setRootPath] = useState<string | null>(() => initialSession?.rootPath ?? null);
    const [entries, setEntries] = useState<FolderPanelEntry[]>(() => initialSession?.entries ?? []);
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialSession?.expandedPaths ?? []));
    const [childrenCache, setChildrenCache] = useState<Map<string, FolderPanelEntry[]>>(() => (
        initialSession ? snapshotToChildrenCache(initialSession.childrenCache) : new Map()
    ));
    const [error, setError] = useState<string | null>(null);
    const [unavailableRoot, setUnavailableRoot] = useState<{ path: string; error: string } | null>(null);
    const [dragSelection, setDragSelection] = useState<FolderDragSelection | null>(null);
    const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
    const [pendingMove, setPendingMove] = useState<{ source: FolderPanelEntry; target: FolderPanelEntry } | null>(null);
    const [isMoving, setIsMoving] = useState(false);
    const [skipInternalMoveConfirm, setSkipInternalMoveConfirm] = useState(false);
    const [skipMoveConfirmChecked, setSkipMoveConfirmChecked] = useState(false);
    const [actionStatus, setActionStatus] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<{ entry: FolderPanelEntry; x: number; y: number } | null>(null);
    const [gitRefreshToken, setGitRefreshToken] = useState(0);
    const [worktreeOpsOpen, setWorktreeOpsOpen] = useState(false);
    const [worktreeOperationBusy, setWorktreeOperationBusy] = useState(false);
    const treeRef = useRef<HTMLDivElement | null>(null);
    const { folderChordActive, startFolderChord, cancelFolderChord } = useFolderChord();
    const folderSelection = useFolderSelection({
        entries,
        childrenCache,
        expanded,
        initialSelection: initialSession?.selection,
        onPreviewFile: props.onPreviewFile,
    });
    const selectedEntry = folderSelection.selectedEntry;
    const selectedEntries = folderSelection.selectedEntries;

    useEffect(() => {
        props.onSessionStateChange?.(folderPanelSessionFromState({
            rootPath,
            entries,
            expanded,
            childrenCache,
            selection: folderSelection.selection,
        }));
    }, [childrenCache, entries, expanded, folderSelection.selection, props.onSessionStateChange, rootPath]);

    const loadDir = useCallback(async (dirPath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
        try {
            const nextEntries = await source.listDir(dirPath);
            setEntries(nextEntries);
            setError(null);
            setUnavailableRoot(current => current?.path === dirPath ? null : current);
            return { ok: true };
        } catch (err) {
            const message = (err as Error).message;
            setError(message);
            return { ok: false, error: message };
        }
    }, [source]);

    const openFolderRoot = useCallback(async (
        nextRoot: string,
        options: { registerGitWorktree?: boolean; repoRoot?: string | null } = {},
    ) => {
        try {
            if (options.registerGitWorktree) {
                if (!rootPath) throw new Error('Current folder root required');
                await source.registerGitWorktreeRoot?.(rootPath, options.repoRoot ?? undefined, nextRoot);
            }
            if (rootPath && source.unwatchDir) void source.unwatchDir(rootPath);
            props.onRootChange?.(nextRoot);
            setRootPath(nextRoot);
            setExpanded(new Set());
            setChildrenCache(new Map());
            setEntries([]);
            folderSelection.resetSelection();
            setError(null);
            setUnavailableRoot(null);
            const loaded = await loadDir(nextRoot);
            if (!loaded.ok) setUnavailableRoot({ path: nextRoot, error: loaded.error });
            setGitRefreshToken(token => token + 1);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [folderSelection, loadDir, props, rootPath, source]);

    const loadChildren = useCallback(async (dirPath: string, options: { force?: boolean } = {}) => {
        if (!options.force && childrenCache.has(dirPath)) return;
        try {
            const nextEntries = await source.listDir(dirPath);
            setChildrenCache(prev => new Map(prev).set(dirPath, nextEntries));
        } catch (err) {
            setError((err as Error).message);
        }
    }, [childrenCache, source]);

    const toggleExpand = useCallback((entryPath: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(entryPath)) {
                next.delete(entryPath);
            } else {
                next.add(entryPath);
                void loadChildren(entryPath);
            }
            return next;
        });
    }, [loadChildren]);

    const pickFolder = useCallback(async () => {
        if (!source.pickRoot) return;
        try {
            const picked = await source.pickRoot();
            if (picked) await openFolderRoot(picked);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [openFolderRoot, source]);

    const clearUnavailableRoot = useCallback(() => {
        props.onRootChange?.(null);
        setRootPath(null);
        setEntries([]);
        folderSelection.resetSelection();
        setUnavailableRoot(null);
        setError(null);
    }, [folderSelection, props]);

    useEffect(() => {
        if (initialRootResolvedRef.current || rootPath !== null || props.externalRootPath) return;
        let cancelled = false;
        void (async () => {
            const nextRoot = await source.getInitialRoot();
            if (cancelled) return;
            initialRootResolvedRef.current = true;
            setRootPath(nextRoot);
            if (nextRoot !== null) await loadDir(nextRoot);
        })();
        return () => { cancelled = true; };
    }, [loadDir, props.externalRootPath, rootPath, source]);

    useEffect(() => {
        const externalRoot = props.externalRootPath;
        if (!externalRoot || externalRoot === rootPath) return;
        void openFolderRoot(externalRoot);
    }, [openFolderRoot, props.externalRootPath, rootPath]);

    const gitStatus = useFolderGitStatus({
        rootPath,
        repoRoot: repoRootPath,
        enabled: source.kind === 'electron-folder',
        refreshToken: gitRefreshToken + gitRefreshVersion,
    });
    const worktreeState = useGitWorktrees({
        folderPanelRoot: rootPath,
        repoRoot: repoRootPath ?? gitStatus.repoRoot,
        enabled: source.kind === 'electron-folder' && gitStatus.available,
        refreshToken: gitRefreshToken + gitRefreshVersion,
    });

    useEffect(() => {
        if (gitStatus.repoRoot && gitStatus.repoRoot !== repoRootPath) onRepoRootChange?.(gitStatus.repoRoot);
    }, [gitStatus.repoRoot, onRepoRootChange, repoRootPath]);

    const refreshVisibleTree = useCallback(async () => {
        if (rootPath === null) return;
        const expandedPaths = Array.from(expanded);
        await loadDir(rootPath);
        for (const path of expandedPaths) await loadChildren(path, { force: true });
        setGitRefreshToken(token => token + 1);
        onGitRefresh?.();
        worktreeState.refresh();
    }, [expanded, loadChildren, loadDir, onGitRefresh, rootPath, worktreeState]);

    useEffect(() => {
        if (!source.watchDir || !source.onDirChange || rootPath === null) return;
        void (async () => {
            const result = await source.watchDir?.(rootPath);
            if (result && !result.ok) setActionStatus(`Watch disabled: ${result.error ?? 'failed to watch directory'}`);
        })();
        const unsub = source.onDirChange(() => { void refreshVisibleTree(); });
        return () => {
            unsub();
            void source.unwatchDir?.(rootPath);
        };
    }, [refreshVisibleTree, rootPath, source]);

    const canUseNativeActions = source.kind === 'electron-folder';
    const canMutateEntries = Boolean(source.createFile && source.createFolder && source.renamePath);

    const refreshAfterMove = useCallback(async (sourcePath: string, targetPath: string) => {
        if (!rootPath) return;
        const sourceParent = parentPath(sourcePath);
        setChildrenCache(prev => dropCachedBranches(prev, [sourceParent, targetPath]));
        await loadDir(rootPath);
        if (expanded.has(sourceParent)) await loadChildren(sourceParent, { force: true });
        if (expanded.has(targetPath)) await loadChildren(targetPath, { force: true });
        setGitRefreshToken(token => token + 1);
    }, [expanded, loadChildren, loadDir, rootPath]);

    const refreshAfterMutation = useCallback(async (parentDirectory: string, focusPath: string | null, extraDroppedPaths: string[] = []) => {
        if (!rootPath) return;
        setChildrenCache(prev => dropCachedBranches(prev, [parentDirectory, ...extraDroppedPaths]));
        await loadDir(rootPath);
        if (expanded.has(parentDirectory)) await loadChildren(parentDirectory, { force: true });
        setGitRefreshToken(token => token + 1);
        onGitRefresh?.();
        if (focusPath) folderSelection.selectOnlyPath(focusPath);
    }, [expanded, folderSelection, loadChildren, loadDir, onGitRefresh, rootPath]);

    const executeMove = useCallback(async (move: { source: FolderPanelEntry; target: FolderPanelEntry }) => {
        if (!source.movePath) return;
        setIsMoving(true);
        try {
            const result = await source.movePath(move.source.path, move.target.path);
            const movedPath = result.moved?.to ?? move.source.path;
            folderSelection.selectOnlyPath(movedPath);
            setActionStatus(`Moved ${move.source.name}`);
            setPendingMove(null);
            await refreshAfterMove(move.source.path, move.target.path);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsMoving(false);
        }
    }, [folderSelection, refreshAfterMove, source]);

    const requestMove = useCallback((sourceEntry: FolderPanelEntry, targetEntry: FolderPanelEntry) => {
        if (!source.movePath || sourceEntry.path === targetEntry.path) return;
        if (sourceEntry.kind === 'directory' && isDescendantPath(sourceEntry.path, targetEntry.path)) return;
        const move = { source: sourceEntry, target: targetEntry };
        if (skipInternalMoveConfirm) {
            void executeMove(move);
            return;
        }
        setSkipMoveConfirmChecked(false);
        setPendingMove(move);
    }, [executeMove, skipInternalMoveConfirm, source.movePath]);

    const mutationParentDirectory = useCallback((): string | null => {
        if (!rootPath) return null;
        if (!selectedEntry) return rootPath;
        return selectedEntry.kind === 'directory' ? selectedEntry.path : parentPath(selectedEntry.path);
    }, [rootPath, selectedEntry]);

    const createEntry = useCallback(async (kind: 'file' | 'directory') => {
        const parentDirectory = mutationParentDirectory();
        if (!parentDirectory) return;
        const create = kind === 'file' ? source.createFile : source.createFolder;
        if (!create) return;
        const label = kind === 'file' ? 'New file name' : 'New folder name';
        const name = window.prompt(label);
        if (!name) return;
        try {
            const result = await create(parentDirectory, name);
            const entry = result.entry;
            if (kind === 'directory' && selectedEntry?.path === parentDirectory) {
                setExpanded(prev => new Set(prev).add(parentDirectory));
            }
            setActionStatus(kind === 'file' ? 'Created file' : 'Created folder');
            setError(null);
            await refreshAfterMutation(parentDirectory, entry?.path ?? null);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [mutationParentDirectory, refreshAfterMutation, selectedEntry?.path, source]);

    const renameSelectedEntry = useCallback(async () => {
        if (!selectedEntry || !source.renamePath) return;
        const name = window.prompt('Rename to', selectedEntry.name);
        if (!name || name === selectedEntry.name) return;
        try {
            const result = await source.renamePath(selectedEntry.path, name);
            const parentDirectory = parentPath(selectedEntry.path);
            setActionStatus('Renamed');
            setError(null);
            await refreshAfterMutation(parentDirectory, result.entry?.path ?? null, [selectedEntry.path]);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [refreshAfterMutation, selectedEntry, source]);

    const selectEntry = useCallback((entry: FolderPanelEntry, options?: { range?: boolean; toggle?: boolean }) => {
        folderSelection.selectEntry(entry, options);
        setContextMenu(null);
    }, [folderSelection]);

    const toggleEntryExpansion = useCallback((entry: FolderPanelEntry) => {
        folderSelection.selectEntry(entry, { preview: false });
        setContextMenu(null);
        if (entry.kind === 'directory') toggleExpand(entry.path);
    }, [folderSelection, toggleExpand]);

    const copyEntryPath = useCallback(async (entry: FolderPanelEntry, kind: 'absolute' | 'relative') => {
        const value = kind === 'relative' ? relativeFolderPath(rootPath, entry.path) : entry.path;
        const result = await copyText(value);
        if (result.ok) {
            folderSelection.selectOnlyPath(entry.path);
            setActionStatus(kind === 'relative' ? 'Copied relative path' : 'Copied path');
            setError(null);
        } else {
            setError(result.error ?? 'Failed to copy path');
        }
    }, [folderSelection, rootPath]);

    const revealEntryPath = useCallback(async (entry: FolderPanelEntry) => {
        if (!source.revealPath) return;
        try {
            await source.revealPath(entry.path);
            folderSelection.selectOnlyPath(entry.path);
            setActionStatus(entry.kind === 'directory' ? 'Opened folder in Finder' : 'Revealed file in Finder');
            setError(null);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [folderSelection, source]);

    const copySelectedPath = useCallback(async (kind: 'absolute' | 'relative') => {
        if (selectedEntries.length === 0) return;
        const value = selectedEntries
            .map(entry => kind === 'relative' ? relativeFolderPath(rootPath, entry.path) : entry.path)
            .join('\n');
        const result = await copyText(value);
        if (result.ok) {
            setActionStatus(kind === 'relative' ? 'Copied relative paths' : 'Copied paths');
            setError(null);
        } else {
            setError(result.error ?? 'Failed to copy paths');
        }
    }, [rootPath, selectedEntries]);

    const revealSelectedPath = useCallback(async () => {
        if (!selectedEntry) return;
        await revealEntryPath(selectedEntry);
    }, [revealEntryPath, selectedEntry]);

    const openWorktreeRoot = useCallback(async (path: string) => {
        await openFolderRoot(path, { registerGitWorktree: true, repoRoot: worktreeState.repoRoot });
    }, [openFolderRoot, worktreeState.repoRoot]);

    const copyWorktreePath = useCallback(async (path: string) => {
        const result = await copyText(path);
        if (result.ok) {
            setActionStatus('Copied worktree path');
            setError(null);
        } else {
            setError(result.error ?? 'Failed to copy worktree path');
        }
    }, []);

    const revealWorktreePath = useCallback(async (path: string) => {
        if (!rootPath || !source.registerGitWorktreeRoot || !source.revealPath) return;
        try {
            await source.registerGitWorktreeRoot(rootPath, worktreeState.repoRoot ?? undefined, path);
            await source.revealPath(path);
            setActionStatus('Opened worktree in Finder');
            setError(null);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [rootPath, source, worktreeState.repoRoot]);

    const runWorktreeOperation = useCallback(async (operation: GitWorktreeOperation) => {
        if (!rootPath) return;
        setWorktreeOperationBusy(true);
        try {
            const result = await runWorktreeOperationClient({
                folderPanelRoot: rootPath,
                repoRoot: worktreeState.repoRoot,
                operation,
                confirmed: true,
            });
            if (!result.ok) throw new Error(result.error ?? 'Git operation failed');
            setActionStatus(result.preview?.label ?? 'Git worktree operation completed');
            setError(null);
            setWorktreeOpsOpen(false);
            worktreeState.refresh();
            setGitRefreshToken(token => token + 1);
            if (rootPath !== null) await refreshVisibleTree();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setWorktreeOperationBusy(false);
        }
    }, [refreshVisibleTree, rootPath, worktreeState]);

    const handleEntryKeyDown = useCallback((event: React.KeyboardEvent, entry: FolderPanelEntry) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            folderSelection.moveKeyboardSelection(event.key === 'ArrowDown' ? 'down' : 'up', event.shiftKey);
            return;
        }
        const action = folderShortcutAction(event, { chordActive: folderChordActive });
        if (action) {
            event.preventDefault();
            event.stopPropagation();
            if (action === 'start-chord') startFolderChord();
            if (action === 'cancel-chord') cancelFolderChord();
            const useSelection = folderSelection.selectedPaths.has(entry.path);
            if (action === 'copy-path') { cancelFolderChord(); void (useSelection ? copySelectedPath('absolute') : copyEntryPath(entry, 'absolute')); }
            if (action === 'copy-relative-path') { cancelFolderChord(); void (useSelection ? copySelectedPath('relative') : copyEntryPath(entry, 'relative')); }
            if (action === 'reveal-path') { cancelFolderChord(); void (useSelection ? revealSelectedPath() : revealEntryPath(entry)); }
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            if (entry.kind === 'directory') toggleEntryExpansion(entry);
            else selectEntry(entry);
            return;
        }
        if (event.key === ' ') {
            event.preventDefault();
            selectEntry(entry);
        }
    }, [cancelFolderChord, copyEntryPath, copySelectedPath, folderChordActive, folderSelection, revealEntryPath, revealSelectedPath, selectEntry, startFolderChord, toggleEntryExpansion]);

    useEffect(() => {
        const focusedPath = folderSelection.selection.focusedPath;
        if (!focusedPath) return;
        const buttons = treeRef.current?.querySelectorAll<HTMLButtonElement>('.folder-entry-btn[data-folder-path]');
        const nextButton = Array.from(buttons ?? []).find(button => button.dataset['folderPath'] === focusedPath);
        nextButton?.focus();
    }, [folderSelection.selection.focusedPath]);

    useEffect(() => {
        if (!contextMenu) return;
        const close = () => setContextMenu(null);
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setContextMenu(null);
        };
        window.addEventListener('pointerdown', close);
        window.addEventListener('keydown', closeOnEscape);
        return () => {
            window.removeEventListener('pointerdown', close);
            window.removeEventListener('keydown', closeOnEscape);
        };
    }, [contextMenu]);

    return (
        <div className="folder-panel">
            <FolderPanelToolbar
                canPickRoot={source.canPickRoot}
                label={source.label}
                rootPath={rootPath}
                onPickFolder={() => void pickFolder()}
                onRefresh={() => { if (rootPath !== null) void refreshVisibleTree(); }}
                gitSummary={source.kind === 'electron-folder' ? gitStatus : undefined}
                worktreeSummary={source.kind === 'electron-folder' ? worktreeState : undefined}
                onOpenWorktree={path => void openWorktreeRoot(path)}
                onCopyWorktreePath={path => void copyWorktreePath(path)}
                onRevealWorktreePath={path => void revealWorktreePath(path)}
                onOpenWorktreeOps={() => setWorktreeOpsOpen(true)}
            />
            {rootPath !== null && (
                <FolderActionRow
                    hasSelection={Boolean(selectedEntry)}
                    canReveal={Boolean(source.revealPath)}
                    onCopyPath={() => void copySelectedPath('absolute')}
                    onCopyRelativePath={() => void copySelectedPath('relative')}
                    onReveal={() => void revealSelectedPath()}
                    canMutate={canMutateEntries}
                    onCreateFile={() => void createEntry('file')}
                    onCreateFolder={() => void createEntry('directory')}
                    onRename={() => void renameSelectedEntry()}
                />
            )}
            {error && <div className="folder-error">{error}</div>}
            {actionStatus && !error && <div className="folder-status">{actionStatus}</div>}
            {folderChordActive && <div className="folder-shortcut-hint">Folder shortcut: press P to copy path or R to reveal</div>}
            {worktreeOpsOpen && rootPath !== null && (
                <FolderWorktreeOpsDialog
                    folderPanelRoot={rootPath}
                    repoRoot={worktreeState.repoRoot}
                    worktrees={worktreeState.worktrees}
                    busy={worktreeOperationBusy}
                    onRun={operation => void runWorktreeOperation(operation)}
                    onClose={() => setWorktreeOpsOpen(false)}
                />
            )}
            <FolderPanelTree
                treeRef={treeRef}
                rootPath={rootPath}
                error={error}
                entries={entries}
                expanded={expanded}
                childrenCache={childrenCache}
                folderSelection={folderSelection}
                decorationsByPath={gitStatus.decorationsByPath}
                dropTargetPath={dropTargetPath}
                dragSelection={dragSelection}
                canUseNativeActions={canUseNativeActions}
                sourceKind={source.kind}
                unavailableRoot={unavailableRoot}
                setDragSelection={setDragSelection}
                setDropTargetPath={setDropTargetPath}
                requestMove={requestMove}
                handleEntryKeyDown={handleEntryKeyDown}
                selectEntry={selectEntry}
                toggleEntryExpansion={toggleEntryExpansion}
                openContextMenu={(entry, x, y) => {
                    if (!folderSelection.selectedPaths.has(entry.path)) folderSelection.selectOnlyPath(entry.path);
                    setContextMenu({ entry, x, y });
                }}
                onPickFolder={() => void pickFolder()}
                onClearUnavailableRoot={clearUnavailableRoot}
            />
            <FolderPanelOverlays
                pendingMove={pendingMove}
                contextMenu={contextMenu}
                isMoving={isMoving}
                skipMoveConfirmChecked={skipMoveConfirmChecked}
                canReveal={Boolean(source.revealPath)}
                canRefresh={Boolean(rootPath)}
                canMutate={canMutateEntries}
                onSkipMoveConfirmCheckedChange={setSkipMoveConfirmChecked}
                onCancelMove={() => setPendingMove(null)}
                onConfirmMove={() => {
                    if (!pendingMove) return;
                    if (skipMoveConfirmChecked) setSkipInternalMoveConfirm(true);
                    void executeMove(pendingMove);
                }}
                onCopyContextPath={() => { setContextMenu(null); void copySelectedPath('absolute'); }}
                onCopyContextRelativePath={() => { setContextMenu(null); void copySelectedPath('relative'); }}
                onRevealContextPath={() => { setContextMenu(null); void revealSelectedPath(); }}
                onRefreshContext={() => { setContextMenu(null); void refreshVisibleTree(); }}
                onCreateContextFile={() => { setContextMenu(null); void createEntry('file'); }}
                onCreateContextFolder={() => { setContextMenu(null); void createEntry('directory'); }}
                onRenameContextPath={() => { setContextMenu(null); void renameSelectedEntry(); }}
            />
        </div>
    );
}
