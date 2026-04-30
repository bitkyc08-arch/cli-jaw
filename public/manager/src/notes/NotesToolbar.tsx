import type { NotesViewMode } from './notes-types';
import { canSaveNote, noteDisplayName } from './note-revisions';

type NotesToolbarProps = {
    selectedPath: string | null;
    viewMode: NotesViewMode;
    dirty: boolean;
    saving: boolean;
    loading: boolean;
    conflict: boolean;
    onViewModeChange: (mode: NotesViewMode) => void;
    onSave: () => void;
    onReload: () => void;
};

const VIEW_MODES: NotesViewMode[] = ['raw', 'split', 'preview', 'settings'];

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
