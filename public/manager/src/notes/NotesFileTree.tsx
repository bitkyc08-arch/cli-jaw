import { useState, type CSSProperties, type DragEvent } from 'react';
import type { NotesTreeEntry } from './notes-types';

type NotesFileTreeProps = {
    entries: NotesTreeEntry[];
    selectedPath: string | null;
    selectedFolderPath: string | null;
    dirtyPath: string | null;
    loading: boolean;
    width: number;
    onSelectPath: (path: string) => void;
    onSelectFolder: (path: string | null) => void;
    onMovePath: (from: string, toFolder: string | null) => void;
    onRenamePath: (path: string, kind: NotesTreeEntry['kind']) => void;
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

function renderEntry(
    entry: NotesTreeEntry,
    props: NotesFileTreeProps,
    expandedFolders: Set<string>,
    toggleFolder: (path: string) => void,
    dropTargetPath: string | null,
    setDropTargetPath: (path: string | null) => void,
) {
    const selected = entry.path === props.selectedPath;
    if (entry.kind === 'folder') {
        const expanded = expandedFolders.has(entry.path);
        const folderSelected = entry.path === props.selectedFolderPath;
        const children = entry.children || [];
        return (
            <li key={entry.path} className="notes-tree-folder">
                <div className={`notes-tree-folder-row ${folderSelected ? 'is-folder-selected' : ''} ${dropTargetPath === entry.path ? 'is-drop-target' : ''}`}>
                    <button
                        type="button"
                        className="notes-tree-folder-button"
                        aria-expanded={expanded}
                        onClick={() => {
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
                        onClick={() => props.onRenamePath(entry.path, entry.kind)}
                    >
                        <PencilIcon />
                    </button>
                </div>
                {expanded && children.length > 0 && (
                    <ul>{children.map(child => renderEntry(child, props, expandedFolders, toggleFolder, dropTargetPath, setDropTargetPath))}</ul>
                )}
            </li>
        );
    }
    const dirty = entry.path === props.dirtyPath;
    return (
        <li key={entry.path}>
            <div className={`notes-tree-file-row ${selected ? 'is-selected' : ''} ${dirty ? 'is-dirty' : ''}`}>
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
                    onClick={() => props.onSelectPath(entry.path)}
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
                    onClick={() => props.onRenamePath(entry.path, entry.kind)}
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

    function toggleFolder(path: string): void {
        setExpandedFolders(current => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }

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
            {props.loading && <div className="notes-tree-state">Loading notes...</div>}
            {!props.loading && props.entries.length === 0 && <div className="notes-tree-state">No notes or folders</div>}
            {!props.loading && props.entries.length > 0 && (
                <ul className="notes-tree-list">{props.entries.map(entry => renderEntry(entry, props, expandedFolders, toggleFolder, dropTargetPath, setDropTargetPath))}</ul>
            )}
        </aside>
    );
}
