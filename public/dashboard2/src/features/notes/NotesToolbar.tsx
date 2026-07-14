import { Columns2, Edit3, Eye, Save } from '@lucide/icons';
import type { JSX } from 'react';
import { Icon } from '../../shell/Icon';
import type { NotesViewMode } from './notes-types';

type ToolbarViewMode = Extract<NotesViewMode, 'raw' | 'split' | 'preview'>;

export type NotesToolbarProps = {
    selectedPath: string | null;
    viewMode: 'edit' | 'split' | 'preview';
    dirty: boolean;
    saving: boolean;
    wordCount: number;
    onViewModeChange: (mode: 'edit' | 'split' | 'preview') => void;
    onSave: () => void;
};

const MODES: Array<{ mode: NotesToolbarProps['viewMode']; label: string; icon: typeof Edit3 }> = [
    { mode: 'edit', label: 'Edit', icon: Edit3 },
    { mode: 'split', label: 'Split', icon: Columns2 },
    { mode: 'preview', label: 'Preview', icon: Eye },
];

export function NotesToolbar(props: NotesToolbarProps): JSX.Element {
    const filename = props.selectedPath?.split('/').pop() ?? 'No note selected';
    const compatibleViewMode: ToolbarViewMode = props.viewMode === 'edit' ? 'raw' : props.viewMode;

    return (
        <header className="d2-notes-toolbar" data-notes-view={compatibleViewMode}>
            <div className="d2-notes-toolbar-file" title={props.selectedPath ?? undefined}>
                <strong>{filename}</strong>
                {props.dirty ? <span className="d2-notes-dirty" aria-label="Unsaved changes">*</span> : null}
            </div>
            <div className="d2-notes-toolbar-actions">
                <div className="d2-notes-view-modes" role="group" aria-label="Note view mode">
                    {MODES.map(item => (
                        <button
                            key={item.mode}
                            type="button"
                            className={props.viewMode === item.mode ? 'active' : ''}
                            aria-pressed={props.viewMode === item.mode}
                            disabled={!props.selectedPath}
                            onClick={() => props.onViewModeChange(item.mode)}
                        >
                            <Icon icon={item.icon} size={14} />
                            <span>{item.label}</span>
                        </button>
                    ))}
                </div>
                <span className="d2-notes-word-count">{props.wordCount.toLocaleString()} words</span>
                <button
                    type="button"
                    className="d2-notes-save-button"
                    disabled={!props.dirty || props.saving}
                    onClick={props.onSave}
                >
                    <Icon icon={Save} size={14} />
                    {props.saving ? 'Saving…' : 'Save'}
                </button>
            </div>
        </header>
    );
}
