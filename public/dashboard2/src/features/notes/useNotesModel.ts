import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchNotesIndex, fetchNotesInfo, fetchNotesTree } from './notes-api';
import type { NotesTreeEntry, NotesVaultIndexSnapshot } from './notes-types';
import { useNotesExternalSync } from './useNotesExternalSync';

export type NotesModelState = {
    tree: NotesTreeEntry[];
    filteredTree: NotesTreeEntry[];
    index: NotesVaultIndexSnapshot | null;
    loading: boolean;
    error: string | null;
    notesRoot: string | null;
    tagFilter: string | null;
    setTagFilter: (tag: string | null) => void;
    refresh: (selectPath?: string | null) => Promise<void>;
};

type UseNotesModelOptions = {
    active: boolean;
    selectedPath: string | null;
    onSelectedPathChange: (path: string | null) => void;
    onRefreshNeeded?: () => void;
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

function pruneTreeByPaths(entries: NotesTreeEntry[], allowed: Set<string>): NotesTreeEntry[] {
    const out: NotesTreeEntry[] = [];
    for (const entry of entries) {
        if (entry.kind === 'file') {
            if (allowed.has(entry.path)) out.push(entry);
            continue;
        }
        const children = pruneTreeByPaths(entry.children || [], allowed);
        if (children.length > 0) out.push({ ...entry, children });
    }
    return out;
}

export function useNotesModel(options: UseNotesModelOptions): NotesModelState {
    const [tree, setTree] = useState<NotesTreeEntry[]>([]);
    const [index, setIndex] = useState<NotesVaultIndexSnapshot | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notesRoot, setNotesRoot] = useState<string | null>(null);
    const [tagFilter, setTagFilter] = useState<string | null>(null);
    const requestIdRef = useRef(0);
    const selectedPathRef = useRef(options.selectedPath);
    const onSelectedPathChangeRef = useRef(options.onSelectedPathChange);
    const onRefreshNeededRef = useRef(options.onRefreshNeeded);

    selectedPathRef.current = options.selectedPath;
    onSelectedPathChangeRef.current = options.onSelectedPathChange;
    onRefreshNeededRef.current = options.onRefreshNeeded;

    useEffect(() => {
        if (!options.active || notesRoot) return;
        void fetchNotesInfo().then(info => setNotesRoot(info.root)).catch(() => {});
    }, [options.active, notesRoot]);

    const refresh = useCallback(async (selectPath = selectedPathRef.current): Promise<void> => {
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        setLoading(true);
        setError(null);
        try {
            const [nextTree, nextIndex] = await Promise.all([fetchNotesTree(), fetchNotesIndex()]);
            if (requestId !== requestIdRef.current) return;
            setTree(nextTree);
            setIndex(nextIndex);
            const nextSelected = selectPath && hasFile(nextTree, selectPath) ? selectPath : firstFile(nextTree);
            if (nextSelected !== selectedPathRef.current) onSelectedPathChangeRef.current(nextSelected);
        } catch (refreshError) {
            if (requestId === requestIdRef.current) {
                setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh notes');
            }
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, []);

    const handleExternalChange = useCallback(() => {
        onRefreshNeededRef.current?.();
        if (options.active) void refresh();
    }, [options.active, refresh]);

    useNotesExternalSync(options.active, handleExternalChange);

    useEffect(() => {
        if (options.active) void refresh();
    }, [options.active, refresh]);

    const filteredTree = useMemo(() => {
        if (!tagFilter || !index) return tree;
        const allowed = new Set<string>();
        for (const note of index.notes) {
            if (note.tags?.includes(tagFilter)) allowed.add(note.path);
        }
        return allowed.size === 0 ? [] : pruneTreeByPaths(tree, allowed);
    }, [tagFilter, tree, index]);

    return { tree, filteredTree, index, loading, error, notesRoot, tagFilter, setTagFilter, refresh };
}
