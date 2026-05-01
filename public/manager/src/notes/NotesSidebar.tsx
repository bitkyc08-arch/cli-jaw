import { useEffect, useState } from 'react';
import { createNoteFile, createNoteFolder, fetchNotesInfo, fetchNotesTree, renameNotePath, trashNotePath } from './notes-api';
import { NotesFileTree } from './NotesFileTree';
import type { NotesTreeEntry } from './notes-types';

type NotesSidebarProps = {
    selectedPath: string | null;
    dirtyPath: string | null;
    treeWidth: number;
    onSelectedPathChange: (path: string | null) => void;
};

function firstFile(entries: NotesTreeEntry[]): string | null {
    for (const entry of entries) {
        if (entry.kind === 'file') return entry.path;
        const child = firstFile(entry.children || []);
        if (child) return child;
    }
    return null;
}

function hasFile(entries: NotesTreeEntry[], path: string): boolean {
    for (const entry of entries) {
        if (entry.kind === 'file' && entry.path === path) return true;
        if (hasFile(entry.children || [], path)) return true;
    }
    return false;
}

function movePathToFolder(path: string, folderPath: string | null): string {
    const parts = path.split('/').filter(Boolean);
    const name = parts[parts.length - 1];
    if (!name) return path;
    return folderPath ? `${folderPath}/${name}` : name;
}

function pathName(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
}

function pathParent(path: string): string | null {
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 1) return null;
    return parts.slice(0, -1).join('/');
}

function renameTarget(path: string, value: string, kind: NotesTreeEntry['kind']): string {
    const nextName = kind === 'file' && !value.endsWith('.md') ? `${value}.md` : value;
    if (nextName.includes('/')) return nextName;
    const parent = pathParent(path);
    return parent ? `${parent}/${nextName}` : nextName;
}

function rebasePath(path: string | null, from: string, to: string): string | null {
    if (!path) return null;
    if (path === from) return to;
    return path.startsWith(`${from}/`) ? `${to}/${path.slice(from.length + 1)}` : path;
}

function pathContains(parent: string, child: string | null): boolean {
    if (!child) return false;
    return child === parent || child.startsWith(`${parent}/`);
}

function isDirtyTarget(path: string, kind: NotesTreeEntry['kind'], dirtyPath: string | null): boolean {
    if (!dirtyPath) return false;
    return kind === 'folder' ? pathContains(path, dirtyPath) : dirtyPath === path;
}

function trashConfirmMessage(path: string, kind: NotesTreeEntry['kind'], dirty: boolean): string {
    const label = kind === 'folder'
        ? `Move folder "${path}" and all child notes to trash?`
        : `Move note "${path}" to trash?`;
    return dirty ? `${label}\n\nThere are unsaved changes inside this target.` : label;
}

function batchTrashConfirmMessage(items: { path: string; kind: NotesTreeEntry['kind'] }[], dirty: boolean): string {
    const fileCount = items.filter(it => it.kind === 'file').length;
    const folderCount = items.length - fileCount;
    const parts: string[] = [];
    if (folderCount > 0) parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'}`);
    if (fileCount > 0) parts.push(`${fileCount} note${fileCount === 1 ? '' : 's'}`);
    const subject = parts.length > 0 ? parts.join(' + ') : `${items.length} items`;
    const label = `Move ${subject} to trash?`;
    return dirty ? `${label}\n\nThere are unsaved changes inside this selection.` : label;
}

export function NotesSidebar(props: NotesSidebarProps) {
    const [tree, setTree] = useState<NotesTreeEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
    const [notesRoot, setNotesRoot] = useState<string | null>(null);

    useEffect(() => {
        void fetchNotesInfo().then(info => setNotesRoot(info.root)).catch(() => {});
    }, []);

    async function refreshTree(selectPath = props.selectedPath): Promise<void> {
        setLoading(true);
        setError(null);
        try {
            const next = await fetchNotesTree();
            setTree(next);
            const nextSelected = selectPath && hasFile(next, selectPath) ? selectPath : firstFile(next);
            if (nextSelected !== props.selectedPath) props.onSelectedPathChange(nextSelected);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void refreshTree();
    }, []);

    async function createNote(): Promise<void> {
        const fallback = selectedFolderPath ? `${selectedFolderPath}/untitled.md` : 'untitled.md';
        const name = window.prompt('Note path', fallback);
        if (!name) return;
        try {
            setStatus(null);
            const created = await createNoteFile(name.endsWith('.md') ? name : `${name}.md`, '');
            props.onSelectedPathChange(created.path);
            await refreshTree(created.path);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function createFolder(): Promise<void> {
        const fallback = selectedFolderPath ? `${selectedFolderPath}/new-folder` : 'new-folder';
        const name = window.prompt('Folder path', fallback);
        if (!name) return;
        try {
            setStatus(null);
            const created = await createNoteFolder(name);
            setSelectedFolderPath(created.path);
            await refreshTree();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function moveNote(from: string, toFolder: string | null): Promise<void> {
        const to = movePathToFolder(from, toFolder);
        if (from === to) return;
        try {
            setStatus(null);
            const moved = await renameNotePath(from, to);
            if (props.selectedPath === from) props.onSelectedPathChange(moved.to);
            await refreshTree(moved.to);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function renamePath(path: string, kind: NotesTreeEntry['kind']): Promise<void> {
        const label = kind === 'folder' ? 'Rename folder' : 'Rename note';
        const nextPath = window.prompt(label, pathName(path));
        if (!nextPath) return;
        const target = renameTarget(path, nextPath, kind);
        if (target === path) return;
        try {
            setStatus(null);
            const renamed = await renameNotePath(path, target);
            const nextSelectedPath = rebasePath(props.selectedPath, renamed.from, renamed.to);
            const nextSelectedFolderPath = rebasePath(selectedFolderPath, renamed.from, renamed.to);
            if (nextSelectedFolderPath !== selectedFolderPath) setSelectedFolderPath(nextSelectedFolderPath);
            if (nextSelectedPath !== props.selectedPath) props.onSelectedPathChange(nextSelectedPath);
            await refreshTree(nextSelectedPath);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function trashPaths(items: { path: string; kind: NotesTreeEntry['kind'] }[]): Promise<void> {
        if (items.length === 0) return;
        if (items.length === 1) {
            await trashPath(items[0].path, items[0].kind);
            return;
        }
        const dirtyHit = items.some(item => isDirtyTarget(item.path, item.kind, props.dirtyPath));
        if (!window.confirm(batchTrashConfirmMessage(items, dirtyHit))) return;

        setStatus(null);
        let succeeded = 0;
        let selectedCleared = false;
        let folderCleared = false;
        let firstError: string | null = null;

        for (const item of items) {
            try {
                await trashNotePath(item.path, item.kind);
                succeeded += 1;
                if (!selectedCleared) {
                    const selectedHit = item.kind === 'folder'
                        ? pathContains(item.path, props.selectedPath)
                        : props.selectedPath === item.path;
                    if (selectedHit) selectedCleared = true;
                }
                if (!folderCleared && item.kind === 'folder' && pathContains(item.path, selectedFolderPath)) {
                    folderCleared = true;
                }
            } catch (err) {
                firstError = `Failed at ${item.path}: ${(err as Error).message}`;
                break;
            }
        }

        if (selectedCleared) props.onSelectedPathChange(null);
        if (folderCleared) setSelectedFolderPath(null);

        if (firstError) {
            setError(firstError);
            setStatus(succeeded > 0 ? `Moved ${succeeded} of ${items.length} to trash before stopping.` : null);
        } else {
            setStatus(`Moved ${succeeded} item${succeeded === 1 ? '' : 's'} to trash.`);
        }

        await refreshTree(selectedCleared ? null : props.selectedPath);
    }

    async function trashPath(path: string, kind: NotesTreeEntry['kind']): Promise<void> {
        const dirty = isDirtyTarget(path, kind, props.dirtyPath);
        if (!window.confirm(trashConfirmMessage(path, kind, dirty))) return;
        try {
            setStatus(null);
            const result = await trashNotePath(path, kind);
            const selectedWasInside = kind === 'folder'
                ? pathContains(path, props.selectedPath)
                : props.selectedPath === path;
            const folderWasInside = kind === 'folder'
                ? pathContains(path, selectedFolderPath)
                : false;

            if (selectedWasInside) props.onSelectedPathChange(null);
            if (folderWasInside) setSelectedFolderPath(null);

            const destination = result.deletedTo === 'os-trash' ? 'OS trash' : 'dashboard trash';
            const restoreHint = result.deletedTo === 'dashboard-trash' && result.restoreHint
                ? ` Restore from: ${result.restoreHint}`
                : '';
            setStatus(`Moved ${result.path} to ${destination}.${restoreHint}`);
            await refreshTree(selectedWasInside ? null : props.selectedPath);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    return (
        <>
            {error && <section className="state error-state">{error}</section>}
            {status && <section className="state notes-status-state">{status}</section>}
            <NotesFileTree
                entries={tree}
                selectedPath={props.selectedPath}
                selectedFolderPath={selectedFolderPath}
                dirtyPath={props.dirtyPath}
                loading={loading}
                width={props.treeWidth}
                notesRoot={notesRoot}
                onSelectPath={props.onSelectedPathChange}
                onSelectFolder={setSelectedFolderPath}
                onMovePath={(from, toFolder) => void moveNote(from, toFolder)}
                onRenamePath={(path, kind) => void renamePath(path, kind)}
                onTrashPath={(path, kind) => void trashPath(path, kind)}
                onTrashPaths={items => void trashPaths(items)}
                onCreateNote={() => void createNote()}
                onCreateFolder={() => void createFolder()}
                onRefresh={() => void refreshTree()}
            />
        </>
    );
}
