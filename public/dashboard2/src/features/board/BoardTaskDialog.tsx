import { LoaderCircle, Trash2, X } from '@lucide/icons';
import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX, type KeyboardEvent } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { useModalA11y } from '../../shell/use-modal-a11y.ts';
import { BOARD_LANES, type BoardLaneId, type BoardTask, type UpdateBoardTaskInput } from './board-types.ts';

export type BoardTaskDialogProps = {
    task: BoardTask | null;
    onClose: () => void;
    onSave: (id: string, input: UpdateBoardTaskInput) => Promise<void>;
    onDelete: (task: BoardTask) => Promise<void>;
    saving: boolean;
};

export function BoardTaskDialog({ task, onClose, onSave, onDelete, saving }: BoardTaskDialogProps): JSX.Element | null {
    const dialogRef = useRef<HTMLFormElement>(null);
    // M4 — modal: background inert + focus restore on close. The dialog
    // stays mounted with task=null, so the behavior keys on the open state.
    useModalA11y('.d2-board-dialog-backdrop', { inert: true, active: Boolean(task) });
    const [title, setTitle] = useState('');
    const [summary, setSummary] = useState('');
    const [detail, setDetail] = useState('');
    const [lane, setLane] = useState<BoardLaneId>('backlog');

    useEffect(() => {
        setTitle(task?.title ?? '');
        setSummary(task?.summary ?? '');
        setDetail(task?.detail ?? '');
        setLane(task?.status ?? 'backlog');
    }, [task]);

    const dirty = useMemo(() => task !== null && (
        title.trim() !== task.title
        || summary.trim() !== (task.summary ?? '')
        || detail.trim() !== (task.detail ?? '')
        || lane !== task.status
    ), [detail, lane, summary, task, title]);

    if (!task) return null;

    const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
        if (event.key === 'Escape') {
            // Mark the top layer as handled so SidePane does not close the
            // panel beneath the dialog.
            event.preventDefault();
            if (!saving) onClose();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
        ) ?? [])];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
        }
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        const nextTitle = title.trim();
        if (!nextTitle || !dirty || saving) return;
        await onSave(task.id, {
            title: nextTitle,
            summary: summary.trim() || null,
            detail: detail.trim() || null,
            status: lane,
        });
    };

    return (
        <div className="d2-board-dialog-backdrop" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !dirty && !saving) onClose();
        }}>
            <form ref={dialogRef} className="d2-board-dialog" role="dialog" aria-modal="true" aria-labelledby="d2-board-dialog-title" onSubmit={(event) => void handleSubmit(event)} onKeyDown={handleKeyDown}>
                <header className="d2-board-dialog-header">
                    <h2 id="d2-board-dialog-title">Edit task</h2>
                    <button type="button" onClick={onClose} disabled={saving} aria-label="Close task editor"><Icon icon={X} size={16} /></button>
                </header>
                <label className="d2-board-dialog-field"><span>Title</span><input autoFocus required maxLength={500} value={title} onChange={(event) => setTitle(event.currentTarget.value)} disabled={saving} /></label>
                <label className="d2-board-dialog-field"><span>Summary</span><textarea rows={2} maxLength={500} value={summary} onChange={(event) => setSummary(event.currentTarget.value)} disabled={saving} /></label>
                <label className="d2-board-dialog-field"><span>Details</span><textarea rows={7} maxLength={20000} value={detail} onChange={(event) => setDetail(event.currentTarget.value)} disabled={saving} /></label>
                <label className="d2-board-dialog-field"><span>Lane</span><select value={lane} onChange={(event) => setLane(event.currentTarget.value as BoardLaneId)} disabled={saving}>{BOARD_LANES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <footer className="d2-board-dialog-footer">
                    <button type="button" className="d2-board-dialog-delete" disabled={saving} onClick={() => { if (window.confirm(`Delete "${task.title}"?`)) void onDelete(task); }}><Icon icon={Trash2} size={14} />Delete</button>
                    <button type="submit" className="d2-board-dialog-save" disabled={saving || !dirty || !title.trim()}>{saving ? <Icon icon={LoaderCircle} size={14} /> : null}{saving ? 'Saving' : 'Save'}</button>
                </footer>
            </form>
        </div>
    );
}
