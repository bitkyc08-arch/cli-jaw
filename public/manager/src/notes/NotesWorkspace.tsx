import { useEffect } from 'react';
import { MarkdownEditor } from './MarkdownEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { NotesEmptyState } from './NotesEmptyState';
import { NotesToolbar } from './NotesToolbar';
import { useNoteDocument } from './useNoteDocument';
import type { NotesAuthoringMode, NotesViewMode } from './notes-types';

type NotesWorkspaceProps = {
    active: boolean;
    selectedPath: string | null;
    viewMode: NotesViewMode;
    authoringMode: NotesAuthoringMode;
    wordWrap: boolean;
    treeWidth: number;
    onSelectedPathChange: (path: string | null) => void;
    onDirtyPathChange: (path: string | null) => void;
    onViewModeChange: (mode: NotesViewMode) => void;
    onAuthoringModeChange: (mode: NotesAuthoringMode) => void;
    onWordWrapChange: (value: boolean) => void;
    onTreeWidthChange: (value: number) => void;
};

export function NotesWorkspace(props: NotesWorkspaceProps) {
    const document = useNoteDocument();

    useEffect(() => {
        if (!props.selectedPath) return;
        void document.load(props.selectedPath);
    }, [props.selectedPath]);

    useEffect(() => {
        props.onDirtyPathChange(document.dirty ? props.selectedPath : null);
    }, [document.dirty, props.selectedPath]);

    useEffect(() => {
        if (!props.active) return;
        function handleSaveShortcut(event: KeyboardEvent): void {
            if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
            event.preventDefault();
            void document.save();
        }

        window.addEventListener('keydown', handleSaveShortcut);
        return () => window.removeEventListener('keydown', handleSaveShortcut);
    }, [document.save, props.active]);

    const showEditor = props.viewMode === 'raw' || props.viewMode === 'split';
    const showPreview = props.viewMode === 'preview' || props.viewMode === 'split';

    return (
        <section className="notes-workspace" aria-label="Notes workspace">
            <main className={`notes-main notes-mode-${props.viewMode}`}>
                <NotesToolbar
                    selectedPath={props.selectedPath}
                    viewMode={props.viewMode}
                    authoringMode={props.authoringMode}
                    dirty={document.dirty}
                    saving={document.saving}
                    loading={document.loading}
                    conflict={Boolean(document.conflict)}
                    onViewModeChange={props.onViewModeChange}
                    onAuthoringModeChange={props.onAuthoringModeChange}
                    onSave={() => void document.save()}
                    onReload={() => void document.reloadFromDisk()}
                />
                {document.error && <section className="state error-state">{document.error}</section>}
                {document.conflict && (
                    <section className="notes-conflict">
                        <span>{document.conflict.message}</span>
                        <button type="button" onClick={() => void document.reloadFromDisk()}>Reload</button>
                        <button type="button" onClick={() => void document.overwrite()}>Overwrite</button>
                        <button type="button" onClick={document.clearConflict}>Keep local</button>
                    </section>
                )}
                {props.viewMode === 'settings' && (
                    <section className="notes-settings">
                        <label>
                            <input
                                type="checkbox"
                                checked={props.wordWrap}
                                onChange={event => props.onWordWrapChange(event.currentTarget.checked)}
                            />
                            Word wrap
                        </label>
                        <label>
                            Tree width
                            <input
                                type="range"
                                min="220"
                                max="420"
                                value={props.treeWidth}
                                onChange={event => props.onTreeWidthChange(Number(event.currentTarget.value))}
                            />
                        </label>
                    </section>
                )}
                {!props.selectedPath && props.viewMode !== 'settings' && <NotesEmptyState />}
                {props.selectedPath && props.viewMode !== 'settings' && (
                    <div className="notes-document-grid">
                        <div className="notes-editor-pane" hidden={!showEditor} aria-hidden={!showEditor}>
                            <MarkdownEditor active={props.active && showEditor} authoringMode={props.authoringMode} content={document.content} wordWrap={props.wordWrap} onChange={document.setContent} />
                        </div>
                        {showPreview && <MarkdownPreview markdown={document.content} />}
                    </div>
                )}
            </main>
        </section>
    );
}
