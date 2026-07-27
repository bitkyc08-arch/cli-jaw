import {
    AlertCircle,
    Bell,
    Check,
    ChevronDown,
    Clock3,
    LoaderCircle,
    Pencil,
    Plus,
    RefreshCw,
    X,
} from '@lucide/icons';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { useAppScope } from '../../state/scope.tsx';
import { createReminder, listReminders, updateReminder } from './reminders-api-adapter.ts';
import { ReminderEditPopover } from './ReminderEditPopover.tsx';
import { dateScore, fullDate, relativeTime } from './reminders-time.ts';
import type { Reminder, ReminderPriority, UpdateReminderInput } from './reminders-types.ts';
import './reminders.css';

export interface RemindersCoreProps {
    variant: 'panel' | 'tray';
    active: boolean;
}

interface RemindersCoreStateProps extends RemindersCoreProps {
    linkedInstance?: string;
}

const POLL_INTERVAL_MS = 30_000;

function reminderTime(item: Reminder): string | null {
    return item.remindAt ?? item.dueAt;
}

function localDateTimeValue(date: Date): string {
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function defaultDueValue(): string {
    const due = new Date(Date.now() + 60 * 60_000);
    due.setSeconds(0, 0);
    return localDateTimeValue(due);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

interface ReminderCardProps {
    item: Reminder;
    busy: boolean;
    variant: RemindersCoreProps['variant'];
    onComplete(item: Reminder): void;
    onSnooze(item: Reminder): void;
    onEdit(item: Reminder): void;
    onDragStart(item: Reminder): void;
    onDragEnter(item: Reminder): void;
    onDragEnd(): void;
    onDrop(item: Reminder): void;
    dragging: boolean;
    dropTarget: boolean;
}

function ReminderCard({ item, busy, variant, onComplete, onSnooze, onEdit, onDragStart, onDragEnter, onDragEnd, onDrop, dragging, dropTarget }: ReminderCardProps): JSX.Element {
    const due = reminderTime(item);
    const overdue = item.status !== 'done' && dateScore(due) < Date.now();
    const className = variant === 'tray' ? 'd2-reminders-card d2-tray-reminder-card' : 'd2-reminders-card';
    return (
        <li
            className={className}
            data-priority={item.priority}
            data-overdue={overdue}
            data-dragging={dragging}
            data-drop-target={dropTarget}
            draggable={variant === 'panel' && item.status !== 'done' && !busy}
            onClick={() => onEdit(item)}
            onDragStart={() => onDragStart(item)}
            onDragEnter={() => onDragEnter(item)}
            onDragEnd={onDragEnd}
            onDragOver={(event) => { if (variant === 'panel') event.preventDefault(); }}
            onDrop={(event) => { event.preventDefault(); onDrop(item); }}
        >
            <span className="d2-reminders-priority" aria-label={`${item.priority} priority`} title={`${item.priority} priority`} />
            <span className="d2-reminders-card-copy">
                <strong title={item.title}>{item.title}</strong>
                <time dateTime={due ?? undefined} title={fullDate(due)}>{relativeTime(due)}</time>
            </span>
            {item.status !== 'done' ? (
                <span className="d2-reminders-card-actions">
                    {/* M3/M4 — the card click opens the editor, but a keyboard
                        user needs a real button to reach it (the li cannot be
                        role=button with nested buttons inside). */}
                    <button type="button" onClick={(event) => { event.stopPropagation(); onEdit(item); }} disabled={busy} aria-label={`Edit ${item.title}`} title="Edit">
                        <Icon icon={Pencil} size={14} />
                    </button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); onComplete(item); }} disabled={busy} aria-label={`Complete ${item.title}`} title="Complete">
                        <Icon icon={Check} size={14} />
                    </button>
                    {variant === 'panel' ? (
                        <button type="button" onClick={(event) => { event.stopPropagation(); onSnooze(item); }} disabled={busy} aria-label={`Snooze ${item.title} for one hour`} title="Snooze 1 hour">
                            <Icon icon={Clock3} size={14} />
                        </button>
                    ) : null}
                </span>
            ) : null}
        </li>
    );
}

function RemindersCoreState({ variant, active, linkedInstance }: RemindersCoreStateProps): JSX.Element {
    const [reminders, setReminders] = useState<Reminder[]>([]);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [mutationError, setMutationError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [showCompleted, setShowCompleted] = useState(false);
    const [title, setTitle] = useState('');
    const [dueValue, setDueValue] = useState(defaultDueValue);
    const [priority, setPriority] = useState<ReminderPriority>('normal');
    const [creating, setCreating] = useState(false);
    const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
    const [editingItem, setEditingItem] = useState<Reminder | null>(null);
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);

    const load = useCallback(async (showLoading: boolean, signal?: AbortSignal): Promise<void> => {
        if (showLoading) setLoading(true);
        try {
            const items = await listReminders(signal);
            if (signal?.aborted) return;
            setReminders(items);
            setLoadError(null);
        } catch (error) {
            if (signal?.aborted) return;
            setLoadError(errorMessage(error));
        } finally {
            if (showLoading && !signal?.aborted) setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!active) return undefined;
        let controller: AbortController | null = null;
        let timer: number | undefined;
        const stop = (): void => {
            if (timer !== undefined) window.clearInterval(timer);
            timer = undefined;
            controller?.abort();
            controller = null;
        };
        const refresh = (showLoading: boolean): void => {
            controller?.abort();
            controller = new AbortController();
            void load(showLoading, controller.signal);
        };
        const start = (showLoading: boolean): void => {
            if (document.hidden) return;
            refresh(showLoading);
            timer = window.setInterval(() => refresh(false), POLL_INTERVAL_MS);
        };
        const onVisibilityChange = (): void => {
            stop();
            if (!document.hidden) start(true);
        };
        start(true);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            stop();
        };
    }, [active, load]);

    const activeReminders = useMemo(() => {
        const activeItems = reminders.filter((item) => item.status !== 'done');
        const byTime = [...activeItems].sort((left, right) => dateScore(reminderTime(left)) - dateScore(reminderTime(right)));
        const fallbackRank = new Map(byTime.map((item, index) => [item.id, (index + 1) * 1000]));
        return activeItems.sort((left, right) => (left.manualRank ?? fallbackRank.get(left.id)!) - (right.manualRank ?? fallbackRank.get(right.id)!));
    }, [reminders]);
    const completedReminders = useMemo(() => reminders
        .filter((item) => item.status === 'done')
        .sort((left, right) => dateScore(right.sourceUpdatedAt) - dateScore(left.sourceUpdatedAt)), [reminders]);

    const withBusyItem = useCallback(async (id: string, action: () => Promise<void>): Promise<void> => {
        setBusyIds((current) => new Set(current).add(id));
        setMutationError(null);
        try {
            await action();
        } catch (error) {
            setMutationError(errorMessage(error));
        } finally {
            setBusyIds((current) => {
                const next = new Set(current);
                next.delete(id);
                return next;
            });
        }
    }, []);

    const handleCreate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        const trimmedTitle = title.trim();
        const due = variant === 'panel' ? new Date(dueValue) : null;
        if (!trimmedTitle || (due && Number.isNaN(due.getTime()))) return;
        setCreating(true);
        setMutationError(null);
        try {
            const dueAt = due?.toISOString();
            const item = await createReminder({
                title: trimmedTitle,
                status: 'open',
                priority: variant === 'tray' ? 'normal' : priority,
                ...(dueAt === undefined ? {} : { dueAt, remindAt: dueAt }),
                ...(linkedInstance === undefined ? {} : { linkedInstance }),
            });
            setReminders((current) => [item, ...current.filter((entry) => entry.id !== item.id)]);
            setTitle('');
            if (variant === 'panel') {
                setDueValue(defaultDueValue());
                setPriority('normal');
                setShowForm(false);
            }
        } catch (error) {
            setMutationError(errorMessage(error));
        } finally {
            setCreating(false);
        }
    };

    const handleComplete = (item: Reminder): void => {
        void withBusyItem(item.id, async () => {
            const updated = await updateReminder(item.id, { status: 'done' });
            setReminders((current) => current.map((entry) => entry.id === item.id ? updated : entry));
        });
    };

    const handleSnooze = (item: Reminder): void => {
        void withBusyItem(item.id, async () => {
            const currentTime = dateScore(reminderTime(item));
            const base = Math.max(Date.now(), currentTime === Number.MAX_SAFE_INTEGER ? Date.now() : currentTime);
            const updated = await updateReminder(item.id, { remindAt: new Date(base + 60 * 60_000).toISOString() });
            setReminders((current) => current.map((entry) => entry.id === item.id ? updated : entry));
        });
    };

    const handleSave = (id: string, patch: UpdateReminderInput): void => {
        void withBusyItem(id, async () => {
            const updated = await updateReminder(id, patch);
            setReminders((current) => current.map((entry) => entry.id === id ? updated : entry));
            setEditingItem(null);
        });
    };

    const handleDrop = (target: Reminder): void => {
        const draggedId = draggingId;
        setDraggingId(null);
        setDropTargetId(null);
        if (!draggedId || draggedId === target.id) return;
        const dragged = activeReminders.find((item) => item.id === draggedId);
        if (!dragged) return;
        const withoutDragged = activeReminders.filter((item) => item.id !== draggedId);
        const targetIndex = withoutDragged.findIndex((item) => item.id === target.id);
        if (targetIndex < 0) return;
        const previous = withoutDragged[targetIndex - 1];
        const previousRank = previous ? previous.manualRank ?? (targetIndex * 1000) : 0;
        const nextRank = target.manualRank ?? ((targetIndex + 1) * 1000);
        const manualRank = (previousRank + nextRank) / 2;
        const oldRank = dragged.manualRank;
        setReminders((current) => current.map((item) => item.id === draggedId ? { ...item, manualRank } : item));
        void updateReminder(draggedId, { manualRank }).then((updated) => {
            setReminders((current) => current.map((item) => item.id === draggedId ? updated : item));
        }).catch((error) => {
            setReminders((current) => current.map((item) => item.id === draggedId ? { ...item, manualRank: oldRank } : item));
            setMutationError(errorMessage(error));
        });
    };

    const renderReminderList = (items: Reminder[]): JSX.Element => (
        <ul className="d2-reminders-list">
            {items.map((item) => (
                <ReminderCard
                    key={item.id}
                    item={item}
                    busy={busyIds.has(item.id)}
                    variant={variant}
                    onComplete={handleComplete}
                    onSnooze={handleSnooze}
                    onEdit={setEditingItem}
                    onDragStart={(dragged) => { setDraggingId(dragged.id); setDropTargetId(null); }}
                    onDragEnter={(target) => { if (draggingId && draggingId !== target.id) setDropTargetId(target.id); }}
                    onDragEnd={() => { setDraggingId(null); setDropTargetId(null); }}
                    onDrop={handleDrop}
                    dragging={draggingId === item.id}
                    dropTarget={dropTargetId === item.id}
                />
            ))}
        </ul>
    );

    const createFormId = `d2-reminders-create-form-${variant}`;
    const activeTitleId = `d2-reminders-active-title-${variant}`;
    return (
        <div className={`d2-reminders-core d2-${variant}-reminders-core`} hidden={!active} aria-busy={loading}>
            {variant === 'tray' ? (
                <header className="d2-tray-reminders-header">
                    <span className="d2-tray-reminders-mark"><Icon icon={Bell} size={16} /></span>
                    <span>
                        <strong>Reminders</strong>
                        <small>{activeReminders.length} active</small>
                    </span>
                </header>
            ) : (
                <div className="d2-reminders-section-heading d2-reminders-core-heading">
                    <h2 id={activeTitleId}>Active Reminders</h2>
                    <span>{activeReminders.length}</span>
                    <button type="button" onClick={() => setShowForm((current) => !current)} aria-expanded={showForm} aria-controls={createFormId} aria-label={showForm ? 'Close new reminder form' : 'Create reminder'} title={showForm ? 'Close' : 'Create reminder'}>
                        <Icon icon={showForm ? X : Plus} size={14} />
                    </button>
                </div>
            )}

            {variant === 'tray' ? (
                <form className="d2-tray-quick-add" onSubmit={(event) => void handleCreate(event)}>
                    <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} placeholder="Quick add reminder" aria-label="Reminder title" disabled={creating} required />
                    <button type="submit" disabled={creating || !title.trim()} aria-label="Add reminder" title="Add reminder">
                        <Icon icon={creating ? LoaderCircle : Plus} size={15} />
                    </button>
                </form>
            ) : showForm ? (
                <form id={createFormId} className="d2-reminders-form" onSubmit={(event) => void handleCreate(event)}>
                    <label>
                        <span>Title</span>
                        <input autoFocus type="text" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} placeholder="Reminder title" disabled={creating} required />
                    </label>
                    <div className="d2-reminders-form-row">
                        <label>
                            <span>Due</span>
                            <input type="datetime-local" value={dueValue} onChange={(event) => setDueValue(event.target.value)} disabled={creating} required />
                        </label>
                        <label>
                            <span>Priority</span>
                            <select value={priority} onChange={(event) => setPriority(event.target.value as ReminderPriority)} disabled={creating}>
                                <option value="low">Low</option>
                                <option value="normal">Medium</option>
                                <option value="high">High</option>
                            </select>
                        </label>
                    </div>
                    <div className="d2-reminders-form-actions">
                        <button type="button" onClick={() => setShowForm(false)} disabled={creating}>Cancel</button>
                        <button className="d2-reminders-primary" type="submit" disabled={creating || !title.trim() || !dueValue}>
                            <Icon icon={creating ? LoaderCircle : Plus} size={14} />
                            <span>{creating ? 'Adding' : 'Add reminder'}</span>
                        </button>
                    </div>
                </form>
            ) : null}

            {mutationError ? <div className="d2-reminders-error" role="alert"><Icon icon={AlertCircle} size={14} /><span>{mutationError}</span></div> : null}
            {loading && reminders.length === 0 ? (
                <div className="d2-reminders-loading" role="status"><span className="d2-reminders-spinner"><Icon icon={LoaderCircle} size={16} /></span>Loading reminders...</div>
            ) : null}

            <section className={variant === 'tray' ? 'd2-reminders-section d2-tray-reminders-section' : 'd2-reminders-section'} aria-labelledby={activeTitleId}>
                {variant === 'tray' ? (
                    <div className="d2-reminders-section-heading">
                        <h2 id={activeTitleId}>Active</h2>
                        <span>{activeReminders.length}</span>
                    </div>
                ) : null}
                {loadError ? (
                    <div className="d2-reminders-error" role="alert">
                        <Icon icon={AlertCircle} size={14} />
                        <span>{loadError}</span>
                        <button type="button" onClick={() => void load(true)} title="Retry reminders" aria-label="Retry reminders"><Icon icon={RefreshCw} size={13} /></button>
                    </div>
                ) : activeReminders.length > 0 ? renderReminderList(activeReminders) : (
                    <p className="d2-reminders-empty">No active reminders.</p>
                )}
            </section>

            {variant === 'panel' ? (
                <section className="d2-reminders-section d2-reminders-completed" aria-labelledby="d2-reminders-completed-title">
                    <button className="d2-reminders-completed-toggle" type="button" onClick={() => setShowCompleted((current) => !current)} aria-expanded={showCompleted} aria-controls="d2-reminders-completed-list">
                        <span className={showCompleted ? 'd2-reminders-chevron is-open' : 'd2-reminders-chevron'}><Icon icon={ChevronDown} size={14} /></span>
                        <h2 id="d2-reminders-completed-title">Completed</h2>
                        <span>{completedReminders.length}</span>
                    </button>
                    {showCompleted ? (
                        <div id="d2-reminders-completed-list">
                            {completedReminders.length > 0 ? renderReminderList(completedReminders) : <p className="d2-reminders-empty">No completed reminders.</p>}
                        </div>
                    ) : null}
                </section>
            ) : null}
            {variant === 'panel' && editingItem ? (
                <ReminderEditPopover item={editingItem} busy={busyIds.has(editingItem.id)} onClose={() => setEditingItem(null)} onSave={handleSave} />
            ) : null}
        </div>
    );
}

function ScopedPanelRemindersCore({ active }: Pick<RemindersCoreProps, 'active'>): JSX.Element {
    const { selected } = useAppScope();
    const linkedInstance = selected ? String(selected.port) : undefined;
    return <RemindersCoreState variant="panel" active={active} {...(linkedInstance === undefined ? {} : { linkedInstance })} />;
}

export function RemindersCore({ variant, active }: RemindersCoreProps): JSX.Element {
    return variant === 'panel'
        ? <ScopedPanelRemindersCore active={active} />
        : <RemindersCoreState variant="tray" active={active} />;
}
