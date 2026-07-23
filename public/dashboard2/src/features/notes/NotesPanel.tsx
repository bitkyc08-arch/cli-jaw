import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import { useAppScope } from '../../state/scope';
import { NotesCommandPalette } from './NotesCommandPalette';
import { NotesEmptyState } from './NotesEmptyState';
import { NotesFileTree } from './NotesFileTree';
import { NotesFrontmatterStrip } from './NotesFrontmatterStrip';
import { NotesQuickSwitcher } from './NotesQuickSwitcher';
import { NotesToolbar } from './NotesToolbar';
import { NotesCommandProvider, useRegisterNoteCommands, type NoteCommand } from './notes-command-registry';
import type { NotesViewMode } from './notes-types';
import { MarkdownRenderer } from './rendering/MarkdownRenderer';
import { useNoteDocument } from './useNoteDocument';
import { useNoteSync } from './useNoteSync';
import { useNotesModel } from './useNotesModel';
import { createNoteFile, createNoteFolder, renameNotePath, trashNotePath } from './notes-api';
import './notes.css';

interface NotesPanelProps { active: boolean }
type SidebarMode = 'files' | 'search';
type EditorViewMode = 'edit' | 'split' | 'preview';

function wordCount(content: string): number {
    return content.trim() ? content.trim().split(/\s+/u).length : 0;
}

function NotesPanelContent({ active }: NotesPanelProps): JSX.Element {
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<EditorViewMode>('edit');
    const [dirtyPath, setDirtyPath] = useState<string | null>(null);
    const [sidebarMode, setSidebarMode] = useState<SidebarMode>('files');
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
    const [treeWidth, setTreeWidth] = useState(184);
    const [compactEditorOpen, setCompactEditorOpen] = useState(false);
    const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
    const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
    const [flashPath, setFlashPath] = useState<string | null>(null);
    const flashTimer = useRef<number | null>(null);
    const noteDocument = useNoteDocument();
    const scope = useAppScope();

    const confirmDirtyLeave = useCallback((nextPath?: string | null): boolean => {
        return !noteDocument.dirty || nextPath === selectedPath || window.confirm('Discard unsaved changes and leave this note?');
    }, [noteDocument.dirty, selectedPath]);
    const selectPath = useCallback((path: string): void => {
        if (!confirmDirtyLeave(path)) return;
        setSelectedPath(path);
        setCompactEditorOpen(true);
    }, [confirmDirtyLeave]);

    const model = useNotesModel({
        active,
        selectedPath,
        onSelectedPathChange: path => { if (!path || confirmDirtyLeave(path)) setSelectedPath(path); },
    });

    useEffect(() => {
        scope.registerLeaveGuard('notes', confirmDirtyLeave);
        scope.registerDirtyCheck('notes', () => noteDocument.dirty);
        return () => {
            scope.unregisterLeaveGuard('notes');
            scope.unregisterDirtyCheck('notes');
        };
    }, [confirmDirtyLeave, noteDocument.dirty, scope.registerDirtyCheck, scope.registerLeaveGuard, scope.unregisterDirtyCheck, scope.unregisterLeaveGuard]);

    useEffect(() => {
        const intent = scope.pendingNotesIntent;
        if (!active || !intent || !confirmDirtyLeave(intent.path)) return;
        const parts = intent.path.split('/').slice(0, -1);
        setExpandedDirs(new Set(parts.map((_, index) => parts.slice(0, index + 1).join('/'))));
        setSelectedPath(intent.path);
        setCompactEditorOpen(true);
        setFlashPath(intent.path);
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlashPath(null), 1600);
        void model.refresh(intent.path).finally(() => scope.consumeNotesIntent(intent.seq));
    }, [active, confirmDirtyLeave, model.refresh, scope.consumeNotesIntent, scope.pendingNotesIntent]);

    useEffect(() => () => {
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    }, []);

    const handleCreateFile = useCallback(async () => {
        const name = prompt('Note name:');
        if (!name) return;
        const path = name.endsWith('.md') ? name : `${name}.md`;
        await createNoteFile(path);
        setSelectedPath(path);
        void model.refresh(path);
    }, [model]);

    const handleCreateFolder = useCallback(async () => {
        const name = prompt('Folder name:');
        if (!name) return;
        await createNoteFolder(name);
        void model.refresh(selectedPath);
    }, [model, selectedPath]);

    const handleRename = useCallback(async (path: string) => {
        const parts = path.split('/');
        const current = parts[parts.length - 1] ?? path;
        const newName = prompt('Rename to:', current);
        if (!newName || newName === current) return;
        const newPath = parts.length > 1 ? [...parts.slice(0, -1), newName].join('/') : newName;
        await renameNotePath(path, newPath);
        if (selectedPath === path) setSelectedPath(newPath);
        void model.refresh(selectedPath === path ? newPath : selectedPath);
    }, [model, selectedPath]);

    const handleTrash = useCallback(async (path: string) => {
        if (!confirm(`Delete "${path.split('/').pop()}"?`)) return;
        await trashNotePath(path);
        if (selectedPath === path) setSelectedPath(null);
        void model.refresh(null);
    }, [model, selectedPath]);

    useEffect(() => { if (active && selectedPath) void noteDocument.load(selectedPath); }, [active, selectedPath, noteDocument.load]);
    useEffect(() => { setDirtyPath(noteDocument.dirty ? selectedPath : null); }, [noteDocument.dirty, selectedPath]);
    useEffect(() => {
        if (!active) return;
        const handler = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'o') {
                event.preventDefault(); setQuickSwitcherOpen(open => !open);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [active]);

    useNoteSync({
        active,
        onTreeChanged: () => void model.refresh(selectedPath),
        onFileChanged: path => {
            if (path === selectedPath && !noteDocument.dirty) void noteDocument.reloadFromDisk();
            void model.refresh(selectedPath);
        },
    });

    const commands = useMemo<NoteCommand[]>(() => [
        { id: 'notes:save', section: 'File', label: 'Save note', shortcut: 'Cmd+S', disabled: !selectedPath || !noteDocument.dirty || noteDocument.saving, run: () => void noteDocument.save() },
        { id: 'notes:open', section: 'File', label: 'Open note…', shortcut: 'Cmd+O', run: () => setQuickSwitcherOpen(true) },
        ...(['edit', 'split', 'preview'] as const).map<NoteCommand>(mode => ({ id: `notes:view-${mode}`, section: 'View', label: `Switch to ${mode} view`, disabled: !selectedPath, run: () => setViewMode(mode) })),
        { id: 'notes:refresh', section: 'File', label: 'Refresh notes', run: () => void model.refresh(selectedPath) },
    ], [model.refresh, noteDocument.dirty, noteDocument.save, noteDocument.saving, selectedPath]);
    useRegisterNoteCommands(commands, active);

    const metadata = model.index?.notes.find(note => note.path === selectedPath) ?? null;
    const preview = <MarkdownRenderer markdown={noteDocument.content} outgoing={selectedPath ? model.index?.outgoingLinks[selectedPath] : undefined} notes={model.index?.notes} onWikiLinkNavigate={selectPath} />;
    const resizeTree = (event: ReactPointerEvent<HTMLDivElement>): void => {
        const startX = event.clientX; const startWidth = treeWidth;
        event.currentTarget.setPointerCapture(event.pointerId);
        const move = (next: PointerEvent): void => setTreeWidth(Math.max(144, Math.min(280, startWidth + next.clientX - startX)));
        const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };

    return (
        <section className={`d2-feature-panel d2-notes-panel${compactEditorOpen ? ' is-compact-editor-open' : ''}`} style={{ '--notes-tree-width': `${treeWidth}px` } as CSSProperties} aria-label="Notes workspace">
            <aside className="d2-notes-sidebar" aria-label="Notes browser">
                <NotesFileTree tree={model.filteredTree} selectedPath={selectedPath} expandedDirs={expandedDirs} loading={model.loading} flashPath={flashPath} onSelect={selectPath} onToggleDir={path => setExpandedDirs(prev => { const n = new Set(prev); if (n.has(path)) n.delete(path); else n.add(path); return n; })} onCreateFile={() => void handleCreateFile()} onCreateFolder={() => void handleCreateFolder()} onRename={path => void handleRename(path)} onTrash={path => void handleTrash(path)} onRefresh={() => void model.refresh(selectedPath)} />
            </aside>
            <div className="d2-notes-divider" role="separator" aria-orientation="vertical" onPointerDown={resizeTree} />
            <main className="d2-notes-workspace">
                {selectedPath ? <>
                    <NotesToolbar selectedPath={selectedPath} viewMode={viewMode} dirty={noteDocument.dirty} saving={noteDocument.saving} wordCount={wordCount(noteDocument.content)} onViewModeChange={setViewMode} onSave={() => void noteDocument.save()} />
                    <NotesFrontmatterStrip content={noteDocument.content} />
                    {(noteDocument.error || model.error) ? <div className="d2-notes-notice is-error" role="alert"><span>{noteDocument.error || model.error}</span><button type="button" onClick={() => void (noteDocument.error ? noteDocument.reloadFromDisk() : model.refresh(selectedPath))}>Retry</button></div> : null}
                    {noteDocument.conflict ? <div className="d2-notes-notice is-conflict" role="alert"><span>This note changed on disk.</span><button type="button" onClick={() => void noteDocument.reloadFromDisk()}>Reload</button><button type="button" onClick={() => void noteDocument.overwrite()}>Overwrite</button></div> : null}
                    <div className={`d2-notes-content is-${viewMode}`} aria-busy={noteDocument.loading}>
                        {noteDocument.loading ? <div className="d2-notes-loading">Loading note…</div> : null}
                        {!noteDocument.loading && viewMode !== 'preview' ? <textarea className="d2-notes-textarea" aria-label={`Edit ${selectedPath}`} value={noteDocument.content} onChange={event => noteDocument.setContent(event.currentTarget.value)} spellCheck={false} /> : null}
                        {!noteDocument.loading && viewMode !== 'edit' ? <article className="d2-notes-preview" aria-label={`Preview ${selectedPath}`}>{preview}</article> : null}
                    </div>
                </> : <NotesEmptyState onCreateNote={() => void handleCreateFile()} />}
            </main>
            <NotesQuickSwitcher open={quickSwitcherOpen} notes={model.index?.notes ?? null} onClose={() => setQuickSwitcherOpen(false)} onSelect={path => { selectPath(path); setQuickSwitcherOpen(false); }} />
            <NotesCommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
        </section>
    );
}

export function NotesPanel(props: NotesPanelProps): JSX.Element {
    return <NotesCommandProvider><NotesPanelContent {...props} /></NotesCommandProvider>;
}
