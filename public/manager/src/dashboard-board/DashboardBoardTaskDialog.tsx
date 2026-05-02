import { useEffect, useState, type FormEvent } from 'react';
import type { DashboardTaskPatch } from './board-api';

export type BoardTaskDialogCard = {
    id: string;
    title: string;
    summary: string | null;
    detail: string | null;
};

type Props = {
    card: BoardTaskDialogCard | null;
    busy: boolean;
    onClose: () => void;
    onSave: (id: string, patch: DashboardTaskPatch) => void;
};

export function DashboardBoardTaskDialog(props: Props) {
    const [title, setTitle] = useState('');
    const [summary, setSummary] = useState('');
    const [detail, setDetail] = useState('');

    useEffect(() => {
        setTitle(props.card?.title ?? '');
        setSummary(props.card?.summary ?? '');
        setDetail(props.card?.detail ?? '');
    }, [props.card]);

    if (!props.card) return null;

    function submit(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        if (!props.card) return;
        const nextTitle = title.trim();
        if (!nextTitle) return;
        props.onSave(props.card.id, {
            title: nextTitle,
            summary,
            detail,
        });
    }

    return (
        <div
            className="dashboard-board-dialog-backdrop"
            role="presentation"
            onMouseDown={event => {
                if (event.target === event.currentTarget) props.onClose();
            }}
        >
            <form
                className="dashboard-board-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="dashboard-board-dialog-title"
                onSubmit={submit}
                onKeyDown={event => {
                    if (event.key === 'Escape') props.onClose();
                }}
            >
                <header className="dashboard-board-dialog-header">
                    <div>
                        <p className="dashboard-board-dialog-kicker">Kanban block</p>
                        <h3 id="dashboard-board-dialog-title">Edit card</h3>
                    </div>
                    <button
                        type="button"
                        className="dashboard-board-dialog-icon-button"
                        onClick={props.onClose}
                        aria-label="Close card editor"
                    >×</button>
                </header>
                <label className="dashboard-board-dialog-field">
                    <span>Title</span>
                    <input
                        autoFocus
                        type="text"
                        value={title}
                        onChange={event => setTitle(event.currentTarget.value)}
                        maxLength={500}
                        required
                    />
                </label>
                <label className="dashboard-board-dialog-field">
                    <span>One-line note</span>
                    <input
                        type="text"
                        value={summary}
                        onChange={event => setSummary(event.currentTarget.value)}
                        maxLength={500}
                        placeholder="Short visible memo for the card"
                    />
                </label>
                <label className="dashboard-board-dialog-field">
                    <span>Details</span>
                    <textarea
                        value={detail}
                        onChange={event => setDetail(event.currentTarget.value)}
                        maxLength={20000}
                        rows={10}
                        placeholder="Write Markdown here. It is stored as raw text for now."
                    />
                </label>
                <footer className="dashboard-board-dialog-footer">
                    <span className="dashboard-board-dialog-storage">Markdown</span>
                    <div className="dashboard-board-dialog-actions">
                        <button type="button" onClick={props.onClose}>Cancel</button>
                        <button type="submit" disabled={props.busy || !title.trim()}>Save</button>
                    </div>
                </footer>
            </form>
        </div>
    );
}
