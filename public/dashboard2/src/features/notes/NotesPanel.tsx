// 071 — Notes SidePane tab with file tree + editor
import { ChevronDown, ChevronRight, FilePlus, Save } from '@lucide/icons';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import './notes.css';

interface NotesPanelProps {
    active: boolean;
}

interface NoteEntry {
    name: string;
    path: string;
    kind: 'file' | 'folder';
    mtimeMs: number;
    size: number;
    children?: NoteEntry[];
}

interface NoteFile {
    path: string;
    name: string;
    content: string;
    revision: string;
    mtimeMs: number;
    size: number;
}

interface NoteRequestError {
    message: string;
    action: 'tree' | 'load' | 'save' | 'create';
}

const NOTES_API = '/api/dashboard/notes';

async function responseError(response: Response, fallback: string): Promise<Error> {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    return new Error(typeof payload?.error === 'string' ? payload.error : fallback);
}

export function NotesPanel({ active }: NotesPanelProps): JSX.Element {
    const [tree, setTree] = useState<NoteEntry[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [content, setContent] = useState('');
    const [revision, setRevision] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<NoteRequestError | null>(null);
    const [conflict, setConflict] = useState(false);
    const [mode, setMode] = useState<'edit' | 'preview'>('edit');
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Fetch note tree
    const fetchTree = useCallback(async () => {
        if (!active) return;
        try {
            const signal = abortRef.current?.signal;
            const response = await fetch(`${NOTES_API}/tree`, {
                cache: 'no-store',
                credentials: 'same-origin',
                ...(signal ? { signal } : {}),
            });
            if (!response.ok) throw await responseError(response, `Unable to load notes (${response.status})`);
            setTree(await response.json() as NoteEntry[]);
            setError((current) => current?.action === 'tree' ? null : current);
        } catch (treeError) {
            if (treeError instanceof DOMException && treeError.name === 'AbortError') return;
            setError({
                message: treeError instanceof Error ? treeError.message : 'Unable to load notes',
                action: 'tree',
            });
        }
    }, [active]);

    // Fetch note content
    const fetchNote = useCallback(async (path: string) => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`${NOTES_API}/file?path=${encodeURIComponent(path)}`, {
                cache: 'no-store',
                credentials: 'same-origin',
            });
            if (!response.ok) throw await responseError(response, `Unable to load note (${response.status})`);
            const note = await response.json() as NoteFile;
            setContent(note.content);
            setRevision(note.revision);
            setDirty(false);
            setConflict(false);
        } catch (noteError) {
            setError({
                message: noteError instanceof Error ? noteError.message : 'Unable to load note',
                action: 'load',
            });
        } finally {
            setLoading(false);
        }
    }, []);

    // Save note
    const saveNote = useCallback(async () => {
        if (!selectedPath || !revision || conflict) return;
        setError(null);
        try {
            const response = await fetch(`${NOTES_API}/file`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ path: selectedPath, content, baseRevision: revision }),
            });
            if (response.status === 409) {
                setConflict(true);
                return;
            }
            if (!response.ok) throw await responseError(response, `Unable to save note (${response.status})`);
            const note = await response.json() as NoteFile;
            setRevision(note.revision);
            setDirty(false);
        } catch (saveError) {
            setError({
                message: saveError instanceof Error ? saveError.message : 'Unable to save note',
                action: 'save',
            });
        }
    }, [conflict, content, revision, selectedPath]);

    const createNote = useCallback(async (): Promise<void> => {
        const name = prompt('Note name:');
        if (!name) return;
        const path = name.endsWith('.md') ? name : `${name}.md`;
        setError(null);
        try {
            const response = await fetch(`${NOTES_API}/file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ path, content: '' }),
            });
            if (!response.ok) throw await responseError(response, `Unable to create note (${response.status})`);
            const note = await response.json() as NoteFile;
            setSelectedPath(note.path);
            setContent(note.content);
            setRevision(note.revision);
            setDirty(false);
            setConflict(false);
            await fetchTree();
        } catch (createError) {
            setError({
                message: createError instanceof Error ? createError.message : 'Unable to create note',
                action: 'create',
            });
        }
    }, [fetchTree]);

    // Load tree on mount (only when active)
    useEffect(() => {
        abortRef.current?.abort();
        abortRef.current = new AbortController();
        if (active) void fetchTree();
        return () => { abortRef.current?.abort(); };
    }, [active, fetchTree]);

    // Load note on selection change
    useEffect(() => {
        if (active && selectedPath) void fetchNote(selectedPath);
    }, [active, selectedPath, fetchNote]);

    // Keyboard: Cmd+S to save
    useEffect(() => {
        if (!active) return;
        const handler = (e: KeyboardEvent): void => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's' && dirty && revision && !conflict) {
                e.preventDefault();
                void saveNote();
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [active, conflict, dirty, revision, saveNote]);

    const toggleDir = (path: string): void => {
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const renderTree = (entries: NoteEntry[], depth = 0): JSX.Element[] =>
        entries.map((entry) => (
            <div key={entry.path}>
                <button
                    className={`d2-notes-tree-item${selectedPath === entry.path ? ' active' : ''}`}
                    style={{ paddingLeft: `${12 + depth * 16}px` }}
                    type="button"
                    role="treeitem"
                    onClick={() => {
                        if (entry.kind === 'folder') toggleDir(entry.path);
                        else {
                            setConflict(false);
                            setError(null);
                            setSelectedPath(entry.path);
                        }
                    }}
                >
                    {entry.kind === 'folder' ? (
                        <Icon icon={expandedDirs.has(entry.path) ? ChevronDown : ChevronRight} size={12} />
                    ) : (
                        <span className="d2-notes-tree-dot" />
                    )}
                    <span className="d2-notes-tree-name">{entry.name}</span>
                </button>
                {entry.kind === 'folder' && expandedDirs.has(entry.path) && entry.children
                    ? renderTree(entry.children, depth + 1)
                    : null}
            </div>
        ));

    const retryError = (): void => {
        if (!error) return;
        if (error.action === 'tree') void fetchTree();
        else if (error.action === 'load' && selectedPath) void fetchNote(selectedPath);
        else if (error.action === 'save') void saveNote();
        else if (error.action === 'create') void createNote();
    };

    return (
        <div className="d2-feature-panel d2-notes-panel">
            <div className="d2-notes-sidebar">
                <div className="d2-notes-sidebar-header">
                    <span className="d2-notes-sidebar-title">Notes</span>
                    <button className="d2-notes-icon-btn" type="button" title="New note" onClick={() => void createNote()}>
                        <Icon icon={FilePlus} size={14} />
                    </button>
                </div>
                <div className="d2-notes-tree" role="tree">
                    {tree.length > 0 ? renderTree(tree) : (
                        <div className="d2-notes-tree-empty">No notes yet</div>
                    )}
                </div>
            </div>

            <div className="d2-notes-editor-area">
                {conflict && selectedPath ? (
                    <div className="d2-notes-conflict" role="alert">
                        <span>다른 곳에서 수정됨 — 다시 불러오기</span>
                        <button type="button" onClick={() => void fetchNote(selectedPath)}>Reload</button>
                    </div>
                ) : error ? (
                    <div className="d2-notes-error" role="alert">
                        <span>{error.message}</span>
                        <button type="button" onClick={retryError}>Retry</button>
                    </div>
                ) : null}
                {selectedPath ? (
                    <>
                        <div className="d2-notes-toolbar">
                            <span className="d2-notes-filename">
                                {selectedPath}{dirty ? ' *' : ''}
                            </span>
                            <div className="d2-notes-toolbar-actions">
                                <button
                                    className={`d2-notes-mode-btn${mode === 'edit' ? ' active' : ''}`}
                                    type="button"
                                    onClick={() => setMode('edit')}
                                >Edit</button>
                                <button
                                    className={`d2-notes-mode-btn${mode === 'preview' ? ' active' : ''}`}
                                    type="button"
                                    onClick={() => setMode('preview')}
                                >Preview</button>
                                <button
                                    className="d2-notes-icon-btn"
                                    type="button"
                                    title="Save (⌘S)"
                                    disabled={!dirty || conflict || revision === null}
                                    onClick={() => void saveNote()}
                                >
                                    <Icon icon={Save} size={14} />
                                </button>
                            </div>
                        </div>
                        <div className="d2-notes-content">
                            {loading ? (
                                <div className="d2-notes-loading">Loading...</div>
                            ) : mode === 'edit' ? (
                                <textarea
                                    ref={textareaRef}
                                    className="d2-notes-textarea"
                                    aria-label="Notes editor"
                                    value={content}
                                    onChange={(e) => { setContent(e.target.value); setDirty(true); }}
                                    spellCheck={false}
                                    placeholder="Start writing..."
                                />
                            ) : (
                                <div className="d2-notes-preview">
                                    <pre className="d2-notes-preview-text">{content}</pre>
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="d2-feature-panel-placeholder">
                        <h3>Select a note</h3>
                        <p>Choose a note from the sidebar or create a new one</p>
                    </div>
                )}
            </div>
        </div>
    );
}
