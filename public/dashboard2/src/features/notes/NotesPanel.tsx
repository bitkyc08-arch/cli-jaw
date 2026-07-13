// 071 — Notes SidePane tab with file tree + editor
import { ChevronDown, ChevronRight, FilePlus, FolderPlus, Save, Trash2 } from '@lucide/icons';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useAppScope } from '../../state/scope.tsx';
import { Icon } from '../../shell/Icon.tsx';
import './notes.css';

interface NotesPanelProps {
    active: boolean;
}

interface NoteEntry {
    name: string;
    path: string;
    type: 'file' | 'directory';
    children?: NoteEntry[];
}

export function NotesPanel({ active }: NotesPanelProps): JSX.Element {
    const { selected } = useAppScope();
    const port = selected?.port ?? null;
    const [tree, setTree] = useState<NoteEntry[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [content, setContent] = useState('');
    const [dirty, setDirty] = useState(false);
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
    const [loading, setLoading] = useState(false);
    const [mode, setMode] = useState<'edit' | 'preview'>('edit');
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Fetch note tree
    const fetchTree = useCallback(async () => {
        if (!port) return;
        try {
            const res = await fetch(`/i/${port}/api/notes/tree`);
            if (res.ok) {
                const data = await res.json() as { tree?: NoteEntry[] };
                setTree(data.tree ?? []);
            }
        } catch { /* offline */ }
    }, [port]);

    // Fetch note content
    const fetchNote = useCallback(async (path: string) => {
        if (!port) return;
        setLoading(true);
        try {
            const res = await fetch(`/i/${port}/api/notes/${encodeURIComponent(path)}`);
            if (res.ok) {
                const data = await res.json() as { content?: string };
                setContent(data.content ?? '');
                setDirty(false);
            }
        } catch { /* offline */ }
        setLoading(false);
    }, [port]);

    // Save note
    const saveNote = useCallback(async () => {
        if (!port || !selectedPath) return;
        try {
            await fetch(`/i/${port}/api/notes/${encodeURIComponent(selectedPath)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
            });
            setDirty(false);
        } catch { /* offline */ }
    }, [port, selectedPath, content]);

    // Load tree on mount / port change (only when active)
    useEffect(() => {
        if (active && port) void fetchTree();
    }, [active, port, fetchTree]);

    // Load note on selection change
    useEffect(() => {
        if (selectedPath) void fetchNote(selectedPath);
    }, [selectedPath, fetchNote]);

    // Keyboard: Cmd+S to save
    useEffect(() => {
        if (!active) return;
        const handler = (e: KeyboardEvent): void => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's' && dirty) {
                e.preventDefault();
                void saveNote();
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [active, dirty, saveNote]);

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
                    onClick={() => {
                        if (entry.type === 'directory') toggleDir(entry.path);
                        else setSelectedPath(entry.path);
                    }}
                >
                    {entry.type === 'directory' ? (
                        <Icon icon={expandedDirs.has(entry.path) ? ChevronDown : ChevronRight} size={12} />
                    ) : (
                        <span className="d2-notes-tree-dot" />
                    )}
                    <span className="d2-notes-tree-name">{entry.name}</span>
                </button>
                {entry.type === 'directory' && expandedDirs.has(entry.path) && entry.children
                    ? renderTree(entry.children, depth + 1)
                    : null}
            </div>
        ));

    if (!port) {
        return (
            <div className="d2-feature-panel d2-notes-panel">
                <div className="d2-feature-panel-placeholder">
                    <h3>Notes</h3>
                    <p>Select a session to view notes</p>
                </div>
            </div>
        );
    }

    return (
        <div className="d2-feature-panel d2-notes-panel">
            <div className="d2-notes-sidebar">
                <div className="d2-notes-sidebar-header">
                    <span className="d2-notes-sidebar-title">Notes</span>
                    <button className="d2-notes-icon-btn" type="button" title="New note" onClick={() => {
                        const name = prompt('Note name:');
                        if (name) {
                            setSelectedPath(name.endsWith('.md') ? name : `${name}.md`);
                            setContent('');
                            setDirty(true);
                        }
                    }}>
                        <Icon icon={FilePlus} size={14} />
                    </button>
                </div>
                <div className="d2-notes-tree">
                    {tree.length > 0 ? renderTree(tree) : (
                        <div className="d2-notes-tree-empty">No notes yet</div>
                    )}
                </div>
            </div>

            <div className="d2-notes-editor-area">
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
                                    disabled={!dirty}
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
