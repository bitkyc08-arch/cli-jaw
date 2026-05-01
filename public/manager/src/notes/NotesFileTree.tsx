import { useCallback, useEffect, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { NotesTreeEntry } from './notes-types';

type NotesTrashItem = { path: string; kind: NotesTreeEntry['kind'] };

type NotesFileTreeProps = {
    entries: NotesTreeEntry[];
    selectedPath: string | null;
    selectedFolderPath: string | null;
    dirtyPath: string | null;
    loading: boolean;
    width: number;
    notesRoot: string | null;
    onSelectPath: (path: string) => void;
    onSelectFolder: (path: string | null) => void;
    onMovePath: (from: string, toFolder: string | null) => void;
    onRenamePath: (path: string, kind: NotesTreeEntry['kind']) => void;
    onTrashPath: (path: string, kind: NotesTreeEntry['kind']) => void;
    onTrashPaths: (items: NotesTrashItem[]) => void;
    onCreateNote: () => void;
    onCreateFolder: () => void;
    onRefresh: () => void;
};

function TreeChevron({ expanded }: { expanded: boolean }) {
    return (
        <svg viewBox="0 0 16 16" aria-hidden="true" className="notes-tree-chevron">
            <path d={expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function FolderIcon({ open }: { open: boolean }) {
    return (
        <svg viewBox="0 0 18 18" aria-hidden="true" className="notes-tree-icon">
            <path d="M2.5 5.2h5.1l1.2 1.5h6.7v6.7a1.4 1.4 0 0 1-1.4 1.4H3.9a1.4 1.4 0 0 1-1.4-1.4V5.2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d={open ? 'M2.8 7.1h12.7' : 'M2.8 5.2h4.8'} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

function FileIcon() {
    return (
        <svg viewBox="0 0 18 18" aria-hidden="true" className="notes-tree-icon">
            <path d="M5 2.8h5.2L13.5 6v9.2H5V2.8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M10.2 2.8V6h3.3M6.9 9h4.4M6.9 11.5h3.3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

function NewNoteIcon() {
    return (
        <svg viewBox="0 0 18 18" aria-hidden="true" className="notes-tree-action-icon">
            <path d="M5 2.8h5.2L13.5 6v9.2H5V2.8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M9.2 8.1v4.2M7.1 10.2h4.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

function NewFolderIcon() {
    return (
        <svg viewBox="0 0 18 18" aria-hidden="true" className="notes-tree-action-icon">
            <path d="M2.5 5.2h5.1l1.2 1.5h6.7v6.7a1.4 1.4 0 0 1-1.4 1.4H3.9a1.4 1.4 0 0 1-1.4-1.4V5.2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M9 8.3v4M7 10.3h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

function RefreshIcon() {
    return (
        <svg viewBox="0 0 18 18" aria-hidden="true" className="notes-tree-action-icon">
            <path d="M14.2 6.3A5.5 5.5 0 0 0 4 5.2L3 6.6M3.8 11.7A5.5 5.5 0 0 0 14 12.8l1-1.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 3.5v3.1h3.1M15 14.5v-3.1h-3.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function PencilIcon() {
    return (
        <svg viewBox="0 0 18 18" aria-hidden="true" className="notes-tree-action-icon">
            <path d="M4 12.8 3.5 15l2.2-.5 7.7-7.7-1.7-1.7L4 12.8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="m10.9 5.9 1.7 1.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

function notePathFromDrag(event: DragEvent): string | null {
    return event.dataTransfer.getData('application/x-cli-jaw-note-path') || event.dataTransfer.getData('text/plain') || null;
}

function hasNotePathDrag(event: DragEvent): boolean {
    return Array.from(event.dataTransfer.types).some(type => type === 'application/x-cli-jaw-note-path' || type === 'text/plain');
}

function flattenEntries(entries: NotesTreeEntry[], expandedFolders: Set<string>): string[] {
    const result: string[] = [];
    for (const entry of entries) {
        result.push(entry.path);
        if (entry.kind === 'folder' && expandedFolders.has(entry.path) && entry.children) {
            result.push(...flattenEntries(entry.children, expandedFolders));
        }
    }
    return result;
}

function collectPathKinds(entries: NotesTreeEntry[], target: Map<string, NotesTreeEntry['kind']>): void {
    for (const entry of entries) {
        target.set(entry.path, entry.kind);
        if (entry.kind === 'folder' && entry.children) collectPathKinds(entry.children, target);
    }
}

function buildTrashItems(
    paths: Iterable<string>,
    pathKindLookup: Map<string, NotesTreeEntry['kind']>,
): NotesTrashItem[] {
    const items: NotesTrashItem[] = [];
    for (const path of paths) {
        const kind = pathKindLookup.get(path);
        if (kind) items.push({ path, kind });
    }
    return items;
}

function rangeSelect(flatPaths: string[], anchor: string, target: string): Set<string> {
    const anchorIndex = flatPaths.indexOf(anchor);
    const targetIndex = flatPaths.indexOf(target);
    if (anchorIndex === -1 || targetIndex === -1) return new Set([target]);
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return new Set(flatPaths.slice(start, end + 1));
}

function handleTreeKey(
    event: KeyboardEvent,
    entry: NotesTreeEntry,
    options: {
        toggleFolder?: (path: string) => void;
        onSelectPath: (path: string) => void;
        onSelectFolder?: (path: string | null) => void;
        onRenamePath: (path: string, kind: NotesTreeEntry['kind']) => void;
        onTrashPath: (path: string, kind: NotesTreeEntry['kind']) => void;
        onTrashPaths: (items: NotesTrashItem[]) => void;
        multiSelected: Set<string>;
        pathKindLookup: Map<string, NotesTreeEntry['kind']>;
    },
): void {
    if (event.key === 'F2') {
        event.preventDefault();
        options.onRenamePath(entry.path, entry.kind);
        return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        if (options.multiSelected.size > 1 && options.multiSelected.has(entry.path)) {
            const items = buildTrashItems(options.multiSelected, options.pathKindLookup);
            if (items.length > 0) options.onTrashPaths(items);
            return;
        }
        options.onTrashPath(entry.path, entry.kind);
        return;
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        if (entry.kind === 'folder') {
            options.onSelectFolder?.(entry.path);
            options.toggleFolder?.(entry.path);
            return;
        }
        options.onSelectPath(entry.path);
    }
}

function renderEntry(
    entry: NotesTreeEntry,
    props: NotesFileTreeProps,
    expandedFolders: Set<string>,
    toggleFolder: (path: string) => void,
    dropTargetPath: string | null,
    setDropTargetPath: (path: string | null) => void,
    multiSelected: Set<string>,
    pathKindLookup: Map<string, NotesTreeEntry['kind']>,
    onEntryClick: (path: string, event: MouseEvent) => void,
) {
    const selected = entry.path === props.selectedPath;
    const isMultiSelected = multiSelected.has(entry.path);
    if (entry.kind === 'folder') {
        const expanded = expandedFolders.has(entry.path);
        const folderSelected = entry.path === props.selectedFolderPath;
        const children = entry.children || [];
        return (
            <li key={entry.path} className="notes-tree-folder">
                <div className={`notes-tree-folder-row ${folderSelected ? 'is-folder-selected' : ''} ${dropTargetPath === entry.path ? 'is-drop-target' : ''} ${isMultiSelected ? 'is-multi-selected' : ''}`}>
                    <button
                        type="button"
                        className="notes-tree-folder-button"
                        aria-expanded={expanded}
                        onClick={(event) => {
                            if (event.shiftKey || event.metaKey || event.ctrlKey) {
                                onEntryClick(entry.path, event);
                                return;
                            }
                            props.onSelectFolder(entry.path);
                            toggleFolder(entry.path);
                        }}
                        onDragOver={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setDropTargetPath(entry.path);
                        }}
                        onDragLeave={(event) => {
                            event.stopPropagation();
                            setDropTargetPath(null);
                        }}
                        onDrop={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const draggedPath = notePathFromDrag(event);
                            setDropTargetPath(null);
                            if (draggedPath) props.onMovePath(draggedPath, entry.path);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'ArrowRight' && !expanded) {
                                event.preventDefault();
                                toggleFolder(entry.path);
                                return;
                            }
                            if (event.key === 'ArrowLeft' && expanded) {
                                event.preventDefault();
                                toggleFolder(entry.path);
                                return;
                            }
                            handleTreeKey(event, entry, {
                                toggleFolder,
                                onSelectPath: props.onSelectPath,
                                onSelectFolder: props.onSelectFolder,
                                onRenamePath: props.onRenamePath,
                                onTrashPath: props.onTrashPath,
                                onTrashPaths: props.onTrashPaths,
                                multiSelected,
                                pathKindLookup,
                            });
                        }}
                    >
                        <TreeChevron expanded={expanded} />
                        <FolderIcon open={expanded} />
                        <span>{entry.name}</span>
                    </button>
                    <button
                        type="button"
                        className="notes-tree-inline-action"
                        title="Rename folder"
                        aria-label={`Rename folder ${entry.name}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            props.onRenamePath(entry.path, entry.kind);
                        }}
                    >
                        <PencilIcon />
                    </button>
                </div>
                {expanded && children.length > 0 && (
                    <ul>{children.map(child => renderEntry(child, props, expandedFolders, toggleFolder, dropTargetPath, setDropTargetPath, multiSelected, pathKindLookup, onEntryClick))}</ul>
                )}
            </li>
        );
    }
    const dirty = entry.path === props.dirtyPath;
    return (
        <li key={entry.path}>
            <div className={`notes-tree-file-row ${selected ? 'is-selected' : ''} ${dirty ? 'is-dirty' : ''} ${isMultiSelected ? 'is-multi-selected' : ''}`}>
                <button
                    type="button"
                    className="notes-tree-file-button"
                    aria-current={selected ? 'page' : undefined}
                    draggable
                    onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('application/x-cli-jaw-note-path', entry.path);
                        event.dataTransfer.setData('text/plain', entry.path);
                    }}
                    onClick={(event) => {
                        if (event.shiftKey || event.metaKey || event.ctrlKey) {
                            onEntryClick(entry.path, event);
                            return;
                        }
                        props.onSelectPath(entry.path);
                    }}
                    onKeyDown={(event) => handleTreeKey(event, entry, {
                        onSelectPath: props.onSelectPath,
                        onRenamePath: props.onRenamePath,
                        onTrashPath: props.onTrashPath,
                        onTrashPaths: props.onTrashPaths,
                        multiSelected,
                        pathKindLookup,
                    })}
                >
                    <FileIcon />
                    <span>{entry.name}</span>
                    {dirty && <span className="notes-tree-dirty-dot" aria-label="Unsaved changes" />}
                </button>
                <button
                    type="button"
                    className="notes-tree-inline-action"
                    title="Rename"
                    aria-label={`Rename ${entry.name}`}
                    onClick={(event) => {
                        event.stopPropagation();
                        props.onRenamePath(entry.path, entry.kind);
                    }}
                >
                    <PencilIcon />
                </button>
            </div>
        </li>
    );
}

export function NotesFileTree(props: NotesFileTreeProps) {
    const style = { '--notes-tree-width': `${props.width}px` } as CSSProperties;
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
    const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
    const [multiSelected, setMultiSelected] = useState<Set<string>>(() => new Set());
    const [anchorPath, setAnchorPath] = useState<string | null>(null);

    function toggleFolder(path: string): void {
        setExpandedFolders(current => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }

    const flatPaths = flattenEntries(props.entries, expandedFolders);
    const pathKindLookup = (() => {
        const map = new Map<string, NotesTreeEntry['kind']>();
        collectPathKinds(props.entries, map);
        return map;
    })();

    function trashSelected(): void {
        if (multiSelected.size === 0) return;
        const items = buildTrashItems(multiSelected, pathKindLookup);
        if (items.length === 0) return;
        props.onTrashPaths(items);
    }

    const onEntryClick = useCallback((path: string, event: MouseEvent) => {
        if (event.shiftKey && anchorPath) {
            const range = rangeSelect(flatPaths, anchorPath, path);
            setMultiSelected(range);
        } else if (event.metaKey || event.ctrlKey) {
            setMultiSelected(prev => {
                const next = new Set(prev);
                if (next.size === 0 && props.selectedPath) next.add(props.selectedPath);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
            });
            setAnchorPath(path);
        }
    }, [anchorPath, flatPaths, props.selectedPath]);

    useEffect(() => {
        if (props.selectedPath) {
            setAnchorPath(props.selectedPath);
        }
    }, [props.selectedPath]);

    useEffect(() => {
        if (multiSelected.size === 0) return;
        setMultiSelected(prev => {
            let changed = false;
            const next = new Set<string>();
            for (const path of prev) {
                if (pathKindLookup.has(path)) next.add(path);
                else changed = true;
            }
            return changed ? next : prev;
        });
    }, [props.entries]);

    useEffect(() => {
        function handleCopyPath(event: globalThis.KeyboardEvent): void {
            if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'c') return;
            const root = props.notesRoot;
            if (!root) return;

            const paths = multiSelected.size > 0
                ? Array.from(multiSelected)
                : props.selectedPath ? [props.selectedPath] : [];
            if (paths.length === 0) return;

            event.preventDefault();
            const absolute = paths.map(p => `${root}/${p}`).join('\n');
            void navigator.clipboard.writeText(absolute);
        }

        window.addEventListener('keydown', handleCopyPath);
        return () => window.removeEventListener('keydown', handleCopyPath);
    }, [multiSelected, props.selectedPath, props.notesRoot]);

    return (
        <aside
            className={`notes-tree ${dropTargetPath === null ? 'is-root-drop-target' : ''}`}
            style={style}
            onDragOver={(event) => {
                if (!hasNotePathDrag(event)) return;
                event.preventDefault();
                setDropTargetPath(null);
            }}
            onDrop={(event) => {
                const draggedPath = notePathFromDrag(event);
                if (!draggedPath) return;
                event.preventDefault();
                props.onMovePath(draggedPath, null);
            }}
        >
            <div className="notes-tree-header">
                <strong>Notes</strong>
                <div className="notes-tree-actions">
                    <button type="button" onClick={props.onCreateNote} title="New note" aria-label="New note"><NewNoteIcon /></button>
                    <button type="button" onClick={props.onCreateFolder} title="New folder" aria-label="New folder"><NewFolderIcon /></button>
                    <button type="button" onClick={props.onRefresh} disabled={props.loading} title="Refresh notes" aria-label="Refresh notes"><RefreshIcon /></button>
                </div>
            </div>
            {multiSelected.size > 0 && (
                <div className="notes-tree-selection-info">
                    {multiSelected.size} selected
                    <button
                        type="button"
                        className="notes-tree-selection-delete"
                        onClick={trashSelected}
                        disabled={multiSelected.size === 0}
                    >Delete</button>
                    <button type="button" className="notes-tree-clear-selection" onClick={() => setMultiSelected(new Set())}>Clear</button>
                </div>
            )}
            {props.loading && <div className="notes-tree-state">Loading notes...</div>}
            {!props.loading && props.entries.length === 0 && <div className="notes-tree-state">No notes or folders</div>}
            {!props.loading && props.entries.length > 0 && (
                <ul className="notes-tree-list">{props.entries.map(entry => renderEntry(entry, props, expandedFolders, toggleFolder, dropTargetPath, setDropTargetPath, multiSelected, pathKindLookup, onEntryClick))}</ul>
            )}
        </aside>
    );
}
