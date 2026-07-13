import { type JSX } from 'react';

interface NotesPanelProps {
    active: boolean;
}

export function NotesPanel({ active }: NotesPanelProps): JSX.Element {
    return (
        <div className="d2-feature-panel d2-notes-panel" style={{ display: active ? undefined : 'none' }}>
            <div className="d2-feature-panel-placeholder">
                <span className="d2-feature-panel-icon">Note page</span>
                <h3>Notes</h3>
                <p>Notes editor will appear here</p>
            </div>
        </div>
    );
}
