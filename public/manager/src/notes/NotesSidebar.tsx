import { useEffect, useState } from 'react';
import { createNoteFile, createNoteFolder, fetchNotesTree, renameNotePath } from './notes-api';
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

export function NotesSidebar(props: NotesSidebarProps) {
    const [tree, setTree] = useState<NotesTreeEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);

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

    return (
        <>
            {error && <section className="state error-state">{error}</section>}
            <NotesFileTree
                entries={tree}
                selectedPath={props.selectedPath}
                selectedFolderPath={selectedFolderPath}
                dirtyPath={props.dirtyPath}
                loading={loading}
                width={props.treeWidth}
                onSelectPath={props.onSelectedPathChange}
                onSelectFolder={setSelectedFolderPath}
                onMovePath={(from, toFolder) => void moveNote(from, toFolder)}
                onRenamePath={(path, kind) => void renamePath(path, kind)}
                onCreateNote={() => void createNote()}
                onCreateFolder={() => void createFolder()}
                onRefresh={() => void refreshTree()}
            />
        </>
    );
}
