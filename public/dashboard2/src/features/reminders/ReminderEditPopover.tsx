import { LoaderCircle, X } from '@lucide/icons';
import { useEffect, useMemo, useState, type FormEvent, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { useModalA11y } from '../../shell/use-modal-a11y.ts';
import type { Reminder, ReminderPriority, ReminderStatus, UpdateReminderInput } from './reminders-types.ts';

interface ReminderEditPopoverProps {
    item: Reminder;
    busy: boolean;
    onClose(): void;
    onSave(id: string, patch: UpdateReminderInput): void;
}

function toLocal(value: string | null): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function ReminderEditPopover({ item, busy, onClose, onSave }: ReminderEditPopoverProps): JSX.Element {
    // M4 — popover: focus restore on close (no trap, no inert by design).
    useModalA11y(null);
    const [title, setTitle] = useState(item.title);
    const [notes, setNotes] = useState(item.notes);
    const [priority, setPriority] = useState<ReminderPriority>(item.priority);
    const [dueAt, setDueAt] = useState(toLocal(item.dueAt));
    const [status, setStatus] = useState<ReminderStatus>(item.status);

    // Escape is handled on the dialog element (bubble phase), NOT a document
    // listener: SidePane's document handler runs first and closes the panel
    // beneath any Escape it sees without defaultPrevented. Handling it here
    // marks the top layer as handled before document is reached.
    const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
        }
    };

    const changed = useMemo(() => title.trim() !== item.title || notes !== item.notes || priority !== item.priority || dueAt !== toLocal(item.dueAt) || status !== item.status, [dueAt, item, notes, priority, status, title]);

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        const trimmed = title.trim();
        if (!trimmed) return;
        const patch: UpdateReminderInput = {};
        if (trimmed !== item.title) patch.title = trimmed;
        if (notes !== item.notes) patch.notes = notes;
        if (priority !== item.priority) patch.priority = priority;
        if (status !== item.status) patch.status = status;
        if (dueAt !== toLocal(item.dueAt)) patch.dueAt = dueAt ? new Date(dueAt).toISOString() : null;
        if (Object.keys(patch).length === 0) { onClose(); return; }
        onSave(item.id, patch);
    };

    return (
        <div className="d2-reminder-edit-scrim" role="presentation" onMouseDown={onClose}>
            <section className="d2-reminder-edit" role="dialog" aria-modal="false" aria-label="Edit reminder" onMouseDown={(event) => event.stopPropagation()} onKeyDown={handleKeyDown}>
                <form onSubmit={submit}>
                    <header><strong>Edit reminder</strong><button type="button" onClick={onClose} aria-label="Close editor"><Icon icon={X} size={15} /></button></header>
                    <label><span>Title</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} required /></label>
                    <label><span>Notes</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} /></label>
                    <div className="d2-reminder-edit-grid">
                        <label><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value as ReminderPriority)}><option value="low">Low</option><option value="normal">Medium</option><option value="high">High</option></select></label>
                        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as ReminderStatus)}><option value="open">Open</option><option value="focused">Focused</option><option value="waiting">Waiting</option><option value="done">Done</option></select></label>
                    </div>
                    <label><span>Due</span><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
                    <footer><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="d2-reminders-primary" type="submit" disabled={busy || !title.trim() || !changed}>{busy ? <Icon icon={LoaderCircle} size={14} /> : null}{busy ? 'Saving' : 'Save'}</button></footer>
                </form>
            </section>
        </div>
    );
}
