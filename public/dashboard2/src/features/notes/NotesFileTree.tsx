import { ChevronDown, ChevronRight, Edit3, FilePlus, FolderPlus, RefreshCw, Trash2 } from '@lucide/icons';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent } from 'react';
import { Icon } from '../../shell/Icon';
import type { NotesTreeEntry } from './notes-types';

export type NotesFileTreeProps = {
    tree: NotesTreeEntry[];
    selectedPath: string | null;
    expandedDirs: Set<string>;
    loading: boolean;
    flashPath?: string | null;
    onSelect: (path: string) => void;
    onToggleDir: (path: string) => void;
    onCreateFile: () => void;
    onCreateFolder: () => void;
    onRename: (path: string) => void;
    onTrash: (path: string) => void;
    onRefresh: () => void;
};

type VisibleEntry = { entry: NotesTreeEntry; depth: number; parentPath: string | null };

function flattenTree(
    entries: NotesTreeEntry[],
    expandedDirs: Set<string>,
    depth = 0,
    parentPath: string | null = null,
): VisibleEntry[] {
    const visible: VisibleEntry[] = [];
    for (const entry of entries) {
        visible.push({ entry, depth, parentPath });
        if (entry.kind === 'folder' && expandedDirs.has(entry.path)) {
            visible.push(...flattenTree(entry.children ?? [], expandedDirs, depth + 1, entry.path));
        }
    }
    return visible;
}

export function NotesFileTree(props: NotesFileTreeProps): JSX.Element {
    const visibleEntries = useMemo(
        () => flattenTree(props.tree, props.expandedDirs),
        [props.expandedDirs, props.tree],
    );
    const [focusedPath, setFocusedPath] = useState<string | null>(props.selectedPath);
    const itemRefs = useRef(new Map<string, HTMLElement>());

    useEffect(() => {
        if (focusedPath && visibleEntries.some(item => item.entry.path === focusedPath)) return;
        // The selected path may live inside a collapsed folder, so preferring
        // it unconditionally leaves the tree with NO tabbable entry point
        // (every visible treeitem at -1) — the M3 "daily unreachable" finding.
        const selectedVisible = props.selectedPath
            && visibleEntries.some(item => item.entry.path === props.selectedPath);
        setFocusedPath((selectedVisible ? props.selectedPath : null) ?? visibleEntries[0]?.entry.path ?? null);
    }, [focusedPath, props.selectedPath, visibleEntries]);

    function focusPath(path: string): void {
        setFocusedPath(path);
        requestAnimationFrame(() => itemRefs.current.get(path)?.focus());
    }

    function handleKeyDown(event: KeyboardEvent<HTMLElement>, item: VisibleEntry): void {
        const index = visibleEntries.findIndex(candidate => candidate.entry.path === item.entry.path);
        const { entry } = item;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const nextIndex = Math.max(0, Math.min(visibleEntries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
            const next = visibleEntries[nextIndex];
            if (next) focusPath(next.entry.path);
            return;
        }
        if (event.key === 'ArrowRight' && entry.kind === 'folder') {
            event.preventDefault();
            if (!props.expandedDirs.has(entry.path)) props.onToggleDir(entry.path);
            else if (entry.children?.[0]) focusPath(entry.children[0].path);
            return;
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            if (entry.kind === 'folder' && props.expandedDirs.has(entry.path)) props.onToggleDir(entry.path);
            else if (item.parentPath) focusPath(item.parentPath);
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (entry.kind === 'folder') props.onToggleDir(entry.path);
            else props.onSelect(entry.path);
        }
    }

    function renderEntry(item: VisibleEntry): JSX.Element {
        const { entry, depth } = item;
        const expanded = entry.kind === 'folder' && props.expandedDirs.has(entry.path);
        const selected = entry.kind === 'file' && props.selectedPath === entry.path;
        return (
            // The ROW is the treeitem: a tree's children must be treeitems,
            // and sibling action buttons broke that (axe aria-required-
            // children). The item activates on Enter/Space like a button.
            <div
                ref={node => { if (node) itemRefs.current.set(entry.path, node); else itemRefs.current.delete(entry.path); }}
                id={`d2-notes-ti-${entry.path}`}
                className={`d2-notes-tree-row d2-notes-tree-item${selected ? ' active' : ''}${props.flashPath === entry.path ? ' is-flashing' : ''}`}
                key={entry.path}
                role="treeitem"
                aria-expanded={entry.kind === 'folder' ? expanded : undefined}
                aria-selected={selected}
                data-notes-path={entry.path}
                tabIndex={focusedPath === entry.path ? 0 : -1}
                style={{ paddingInlineStart: `${depth * 16}px` } as CSSProperties}
                onFocus={(event) => {
                    // Only the row itself retargets the roving index: focusing a
                    // nested action button re-rendered mid-click and swallowed
                    // the click (the Icon svg is recreated every render).
                    if (event.target === event.currentTarget) setFocusedPath(entry.path);
                }}
                onKeyDown={(event) => {
                    if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                        event.preventDefault();
                        if (entry.kind === 'folder') props.onToggleDir(entry.path);
                        else props.onSelect(entry.path);
                        return;
                    }
                    handleKeyDown(event, item);
                }}
                onClick={() => entry.kind === 'folder' ? props.onToggleDir(entry.path) : props.onSelect(entry.path)}
            >
                <span className="d2-notes-tree-icon" aria-hidden="true">
                    {entry.kind === 'folder' ? <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} /> : <span className="d2-notes-file-dot" />}
                </span>
                <span className="d2-notes-tree-name">{entry.name}</span>
                <span className="d2-notes-tree-actions">
                    <button type="button" aria-label={`Rename ${entry.name}`} title="Rename" onClick={(event) => { event.stopPropagation(); props.onRename(entry.path); }}><Icon icon={Edit3} size={13} /></button>
                    <button type="button" aria-label={`Trash ${entry.name}`} title="Move to trash" onClick={(event) => { event.stopPropagation(); props.onTrash(entry.path); }}><Icon icon={Trash2} size={13} /></button>
                </span>
            </div>
        );
    }

    return (
        <section className="d2-notes-file-tree">
            <header className="d2-notes-tree-header">
                <strong>Notes</strong>
                <div className="d2-notes-tree-header-actions">
                    <button type="button" aria-label="Create note" title="Create note" onClick={props.onCreateFile}><Icon icon={FilePlus} size={15} /></button>
                    <button type="button" aria-label="Create folder" title="Create folder" onClick={props.onCreateFolder}><Icon icon={FolderPlus} size={15} /></button>
                    <button type="button" aria-label="Refresh notes" title="Refresh notes" disabled={props.loading} onClick={props.onRefresh}><Icon icon={RefreshCw} size={15} /></button>
                </div>
            </header>
            {/* The row action buttons are not treeitems and axe counts DOM
                descendants; aria-owns makes the tree own ONLY its treeitems
                (aria-required-children). */}
            <div className="d2-notes-tree" role="tree" aria-label="Notes files" aria-busy={props.loading} aria-owns={visibleEntries.map(item => `d2-notes-ti-${item.entry.path}`).join(' ')}>
                {props.loading ? <div className="d2-notes-tree-state" role="status">Loading notes…</div> : null}
                {!props.loading && visibleEntries.length === 0 ? <div className="d2-notes-tree-state">No notes yet</div> : null}
                {!props.loading ? visibleEntries.map(renderEntry) : null}
            </div>
        </section>
    );
}
