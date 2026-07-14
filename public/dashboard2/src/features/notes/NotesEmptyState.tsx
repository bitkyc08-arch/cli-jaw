import type { JSX } from 'react';

export type NotesEmptyStateProps = { onCreateNote?: () => void };

export function NotesEmptyState({ onCreateNote }: NotesEmptyStateProps): JSX.Element {
    return (
        <section className="d2-notes-empty-state">
            <h2>Select a note</h2>
            <p>Choose a note from the sidebar or create a new one</p>
            {onCreateNote ? <button type="button" onClick={onCreateNote}>Create note</button> : null}
        </section>
    );
}
