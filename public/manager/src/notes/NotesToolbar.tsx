import type { NotesAuthoringMode, NotesViewMode } from './notes-types';
import { canSaveNote, noteDisplayName } from './note-revisions';

type NotesToolbarProps = {
    selectedPath: string | null;
    viewMode: NotesViewMode;
    authoringMode: NotesAuthoringMode;
    dirty: boolean;
    saving: boolean;
    loading: boolean;
    conflict: boolean;
    onViewModeChange: (mode: NotesViewMode) => void;
    onAuthoringModeChange: (mode: NotesAuthoringMode) => void;
    onSave: () => void;
    onReload: () => void;
};

const VIEW_MODES: NotesViewMode[] = ['raw', 'split', 'preview', 'settings'];
const AUTHORING_MODES: NotesAuthoringMode[] = ['plain', 'rich', 'wysiwyg'];

function authoringModeLabel(mode: NotesAuthoringMode): string {
    if (mode === 'plain') return 'Plain';
    if (mode === 'rich') return 'Rich';
    return 'WYSIWYG';
}

export function NotesToolbar(props: NotesToolbarProps) {
    return (
        <div className="notes-toolbar">
            <div className="notes-toolbar-title">
                <strong>{noteDisplayName(props.selectedPath)}</strong>
                <span>{props.conflict ? 'Conflict' : props.dirty ? 'Unsaved' : 'Saved'}</span>
            </div>
            <div className="notes-toolbar-actions">
                <div className="notes-view-tabs" role="tablist" aria-label="Notes view">
                    {VIEW_MODES.map(mode => (
                        <button
                            key={mode}
                            type="button"
                            role="tab"
                            aria-selected={props.viewMode === mode}
                            className={props.viewMode === mode ? 'is-active' : ''}
                            onClick={() => props.onViewModeChange(mode)}
                        >
                            {mode[0].toUpperCase() + mode.slice(1)}
                        </button>
                    ))}
                </div>
                <div className="notes-authoring-toggle" role="group" aria-label="Notes authoring mode">
                    {AUTHORING_MODES.map(mode => (
                        <button
                            key={mode}
                            type="button"
                            aria-pressed={props.authoringMode === mode}
                            className={props.authoringMode === mode ? 'is-active' : ''}
                            disabled={!props.selectedPath}
                            onClick={() => props.onAuthoringModeChange(mode)}
                        >
                            {authoringModeLabel(mode)}
                        </button>
                    ))}
                </div>
                <button type="button" onClick={props.onReload} disabled={!props.selectedPath || props.loading}>
                    Refresh
                </button>
                <button
                    type="button"
                    className="notes-save-button"
                    onClick={props.onSave}
                    disabled={!canSaveNote(props.selectedPath, props.dirty, props.saving)}
                >
                    {props.saving ? 'Saving' : 'Save'}
                </button>
            </div>
        </div>
    );
}
