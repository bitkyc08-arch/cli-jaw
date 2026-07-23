import { LoaderCircle, Trash2, X } from '@lucide/icons';
import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX, type KeyboardEvent } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import type { ScheduleGroup, ScheduleWorkInput, ScheduleWorkItem } from './schedule-api-adapter.ts';

interface ScheduleWorkEditorProps {
    item: ScheduleWorkItem | null;
    busy: boolean;
    onClose(): void;
    onSave(input: ScheduleWorkInput): Promise<void>;
    onDelete?(item: ScheduleWorkItem): Promise<void>;
}

const GROUPS: Array<{ id: ScheduleGroup; label: string }> = [
    { id: 'today', label: 'Today' },
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'recurring', label: 'Recurring' },
    { id: 'blocked', label: 'Blocked' },
];

function toLocal(value: string | null): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function fromLocal(value: string): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function ScheduleWorkEditor({ item, busy, onClose, onSave, onDelete }: ScheduleWorkEditorProps): JSX.Element {
    const formRef = useRef<HTMLFormElement>(null);
    const [title, setTitle] = useState(item?.title ?? '');
    const [group, setGroup] = useState<ScheduleGroup>(item?.group ?? 'upcoming');
    const [cron, setCron] = useState(item?.cron ?? '');
    const [runAt, setRunAt] = useState(toLocal(item?.runAt ?? null));
    const [targetPort, setTargetPort] = useState(item?.targetPort?.toString() ?? '');
    const [payload, setPayload] = useState(item?.payload ?? '');
    const [enabled, setEnabled] = useState(item?.enabled ?? true);

    useEffect(() => {
        setTitle(item?.title ?? '');
        setGroup(item?.group ?? 'upcoming');
        setCron(item?.cron ?? '');
        setRunAt(toLocal(item?.runAt ?? null));
        setTargetPort(item?.targetPort?.toString() ?? '');
        setPayload(item?.payload ?? '');
        setEnabled(item?.enabled ?? true);
    }, [item]);

    const normalizedTargetPort = targetPort ? Number(targetPort) : null;
    const input = useMemo<ScheduleWorkInput>(() => ({
        title: title.trim(),
        group,
        cron: cron.trim() || null,
        runAt: fromLocal(runAt),
        targetPort: normalizedTargetPort,
        payload: payload.trim() || null,
        enabled,
    }), [cron, enabled, group, normalizedTargetPort, payload, runAt, title]);
    const validPort = normalizedTargetPort === null || (Number.isInteger(normalizedTargetPort) && normalizedTargetPort > 0);
    const changed = item === null || input.title !== item.title || input.group !== item.group
        || input.cron !== item.cron || input.runAt !== item.runAt || input.targetPort !== item.targetPort
        || input.payload !== item.payload || input.enabled !== item.enabled;

    const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
        if (event.key === 'Escape') {
            if (!busy) onClose();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...(formRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
        ) ?? [])];
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

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        if (!input.title || !validPort || !changed || busy) return;
        await onSave(input);
    };

    const titleId = item ? 'd2-schedule-edit-title' : 'd2-schedule-create-title';
    return (
        <div className="d2-reminder-edit-scrim" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !changed && !busy) onClose();
        }}>
            <section className="d2-reminder-edit d2-schedule-editor" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
                <form ref={formRef} onSubmit={(event) => void submit(event)} onKeyDown={handleKeyDown}>
                    <header><strong id={titleId}>{item ? 'Edit scheduled work' : 'New scheduled work'}</strong><button type="button" onClick={onClose} disabled={busy} aria-label="Close schedule editor"><Icon icon={X} size={15} /></button></header>
                    <label><span>Title</span><input autoFocus required maxLength={500} value={title} onChange={(event) => setTitle(event.currentTarget.value)} disabled={busy} /></label>
                    <div className="d2-reminder-edit-grid">
                        <label><span>Group</span><select value={group} onChange={(event) => setGroup(event.currentTarget.value as ScheduleGroup)} disabled={busy}>{GROUPS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
                        <label><span>Target port</span><input type="number" min="1" step="1" value={targetPort} onChange={(event) => setTargetPort(event.currentTarget.value)} aria-invalid={!validPort} disabled={busy} /></label>
                    </div>
                    <div className="d2-reminder-edit-grid">
                        <label><span>Run at</span><input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.currentTarget.value)} disabled={busy} /></label>
                        <label><span>Cron</span><input value={cron} onChange={(event) => setCron(event.currentTarget.value)} placeholder="0 9 * * 1-5" disabled={busy} /></label>
                    </div>
                    <label><span>Payload</span><textarea rows={4} value={payload} onChange={(event) => setPayload(event.currentTarget.value)} disabled={busy} /></label>
                    <label className="d2-schedule-enabled-field"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} disabled={busy} /><span>Enabled</span></label>
                    {!validPort ? <p className="d2-schedule-field-error" role="alert">Target port must be a positive whole number.</p> : null}
                    <footer>
                        {item && onDelete ? <button type="button" className="d2-schedule-delete" disabled={busy} onClick={() => { if (window.confirm(`Delete "${item.title}"?`)) void onDelete(item); }}><Icon icon={Trash2} size={14} />Delete</button> : null}
                        <span className="d2-schedule-editor-spacer" />
                        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
                        <button className="d2-reminders-primary" type="submit" disabled={busy || !input.title || !validPort || !changed}>{busy ? <Icon icon={LoaderCircle} size={14} /> : null}{busy ? 'Saving' : item ? 'Save' : 'Add'}</button>
                    </footer>
                </form>
            </section>
        </div>
    );
}
