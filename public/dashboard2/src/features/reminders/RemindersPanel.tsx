import {
    AlertCircle,
    CalendarClock,
    Check,
    ChevronDown,
    Clock3,
    LoaderCircle,
    Plus,
    RefreshCw,
    Trash2,
    X,
} from '@lucide/icons';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { useAppScope } from '../../state/scope.tsx';
import {
    createReminder,
    deleteReminder,
    listReminders,
    listScheduledItems,
    updateReminder,
} from './reminders-api-adapter.ts';
import type { Reminder, ReminderPriority, ScheduledItem } from './reminders-types.ts';
import './reminders.css';

interface RemindersPanelProps {
    active: boolean;
}

const POLL_INTERVAL_MS = 30_000;

function dateScore(value: string | null | undefined): number {
    if (!value) return Number.MAX_SAFE_INTEGER;
    const score = Date.parse(value);
    return Number.isFinite(score) ? score : Number.MAX_SAFE_INTEGER;
}

function reminderTime(item: Reminder): string | null {
    return item.remindAt ?? item.dueAt;
}

function relativeTime(value: string | null | undefined, now = Date.now()): string {
    const timestamp = dateScore(value);
    if (timestamp === Number.MAX_SAFE_INTEGER) return 'No due time';
    const delta = timestamp - now;
    const absolute = Math.abs(delta);
    if (absolute < 45_000) return 'now';
    const units: Array<[number, string]> = [
        [86_400_000, 'd'],
        [3_600_000, 'h'],
        [60_000, 'm'],
    ];
    const unit = units.find(([size]) => absolute >= size) ?? units[2]!;
    const amount = Math.max(1, Math.round(absolute / unit[0]));
    return delta > 0 ? `in ${amount}${unit[1]}` : `${amount}${unit[1]} ago`;
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

function fullDate(value: string | null | undefined): string {
    const timestamp = dateScore(value);
    if (timestamp === Number.MAX_SAFE_INTEGER) return 'No due time';
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(timestamp);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function ScheduleRow({ item }: { item: ScheduledItem }): JSX.Element {
    const nextTime = item.nextRunAt ?? item.runAt;
    const cadence = item.cron ? `Recurring · ${item.cron}` : item.group ?? 'Scheduled';
    return (
        <li className="d2-reminders-schedule-row" data-disabled={!item.enabled}>
            <span className="d2-reminders-schedule-icon"><Icon icon={CalendarClock} size={15} /></span>
            <span className="d2-reminders-card-copy">
                <strong title={item.title}>{item.title}</strong>
                <span>{item.enabled ? cadence : 'Paused'}{nextTime ? ` · ${relativeTime(nextTime)}` : ''}</span>
            </span>
            {nextTime ? <time dateTime={nextTime} title={fullDate(nextTime)}>{relativeTime(nextTime)}</time> : null}
        </li>
    );
}

interface ReminderCardProps {
    item: Reminder;
    busy: boolean;
    onComplete(item: Reminder): void;
    onSnooze(item: Reminder): void;
    onDelete(item: Reminder): void;
}

function ReminderCard({ item, busy, onComplete, onSnooze, onDelete }: ReminderCardProps): JSX.Element {
    const due = reminderTime(item);
    const overdue = item.status !== 'done' && dateScore(due) < Date.now();
    return (
        <li className="d2-reminders-card" data-priority={item.priority} data-overdue={overdue}>
            <span className="d2-reminders-priority" aria-label={`${item.priority} priority`} title={`${item.priority} priority`} />
            <span className="d2-reminders-card-copy">
                <strong title={item.title}>{item.title}</strong>
                <time dateTime={due ?? undefined} title={fullDate(due)}>{relativeTime(due)}</time>
            </span>
            <span className="d2-reminders-card-actions">
                {item.status !== 'done' ? (
                    <>
                        <button type="button" onClick={() => onComplete(item)} disabled={busy} aria-label={`Complete ${item.title}`} title="Complete">
                            <Icon icon={Check} size={14} />
                        </button>
                        <button type="button" onClick={() => onSnooze(item)} disabled={busy} aria-label={`Snooze ${item.title} for one hour`} title="Snooze 1 hour">
                            <Icon icon={Clock3} size={14} />
                        </button>
                    </>
                ) : null}
                <button className="d2-reminders-delete" type="button" onClick={() => onDelete(item)} disabled={busy} aria-label={`Delete ${item.title}`} title="Delete">
                    <Icon icon={Trash2} size={14} />
                </button>
            </span>
        </li>
    );
}

export function RemindersPanel({ active }: RemindersPanelProps): JSX.Element {
    const { selected } = useAppScope();
    const port = selected?.port;
    const [reminders, setReminders] = useState<Reminder[]>([]);
    const [scheduledItems, setScheduledItems] = useState<ScheduledItem[]>([]);
    const [remindersError, setRemindersError] = useState<string | null>(null);
    const [scheduleError, setScheduleError] = useState<string | null>(null);
    const [mutationError, setMutationError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [showCompleted, setShowCompleted] = useState(false);
    const [title, setTitle] = useState('');
    const [dueValue, setDueValue] = useState(defaultDueValue);
    const [priority, setPriority] = useState<ReminderPriority>('normal');
    const [creating, setCreating] = useState(false);
    const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

    const load = useCallback(async (showLoading: boolean, signal?: AbortSignal): Promise<void> => {
        if (showLoading) setLoading(true);
        const [reminderResult, scheduleResult] = await Promise.allSettled([
            listReminders(signal),
            listScheduledItems(signal),
        ]);
        if (signal?.aborted) return;
        if (reminderResult.status === 'fulfilled') {
            setReminders(reminderResult.value);
            setRemindersError(null);
        } else {
            setRemindersError(errorMessage(reminderResult.reason));
        }
        if (scheduleResult.status === 'fulfilled') {
            setScheduledItems(scheduleResult.value);
            setScheduleError(null);
        } else {
            setScheduleError(errorMessage(scheduleResult.reason));
        }
        if (showLoading) setLoading(false);
    }, []);

    useEffect(() => {
        if (!active) return undefined;
        const controller = new AbortController();
        void load(true, controller.signal);
        const timer = window.setInterval(() => {
            if (!document.hidden) void load(false, controller.signal);
        }, POLL_INTERVAL_MS);
        return () => {
            controller.abort();
            window.clearInterval(timer);
        };
    }, [active, load]);

    const activeReminders = useMemo(() => reminders
        .filter((item) => item.status !== 'done')
        .sort((left, right) => dateScore(reminderTime(left)) - dateScore(reminderTime(right))), [reminders]);
    const completedReminders = useMemo(() => reminders
        .filter((item) => item.status === 'done')
        .sort((left, right) => dateScore(right.sourceUpdatedAt) - dateScore(left.sourceUpdatedAt)), [reminders]);
    const sortedScheduledItems = useMemo(() => [...scheduledItems]
        .sort((left, right) => dateScore(left.nextRunAt ?? left.runAt) - dateScore(right.nextRunAt ?? right.runAt)), [scheduledItems]);

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
        const due = new Date(dueValue);
        if (!trimmedTitle || Number.isNaN(due.getTime())) return;
        setCreating(true);
        setMutationError(null);
        try {
            const dueAt = due.toISOString();
            const item = await createReminder({
                title: trimmedTitle,
                status: 'open',
                priority,
                dueAt,
                remindAt: dueAt,
                ...(port === undefined ? {} : { linkedInstance: String(port) }),
            });
            setReminders((current) => [item, ...current.filter((entry) => entry.id !== item.id)]);
            setTitle('');
            setDueValue(defaultDueValue());
            setPriority('normal');
            setShowForm(false);
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
            const base = Math.max(Date.now(), dateScore(reminderTime(item)) === Number.MAX_SAFE_INTEGER ? Date.now() : dateScore(reminderTime(item)));
            const updated = await updateReminder(item.id, { remindAt: new Date(base + 60 * 60_000).toISOString() });
            setReminders((current) => current.map((entry) => entry.id === item.id ? updated : entry));
        });
    };

    const handleDelete = (item: Reminder): void => {
        if (!window.confirm(`Delete “${item.title}”?`)) return;
        void withBusyItem(item.id, async () => {
            await deleteReminder(item.id);
            setReminders((current) => current.filter((entry) => entry.id !== item.id));
        });
    };

    const renderReminderList = (items: Reminder[]): JSX.Element => (
        <ul className="d2-reminders-list">
            {items.map((item) => (
                <ReminderCard
                    key={item.id}
                    item={item}
                    busy={busyIds.has(item.id)}
                    onComplete={handleComplete}
                    onSnooze={handleSnooze}
                    onDelete={handleDelete}
                />
            ))}
        </ul>
    );

    return (
        <div className="d2-feature-panel d2-reminders-panel" style={{ display: active ? undefined : 'none' }}>
            <header className="d2-reminders-toolbar">
                <div>
                    <strong>Reminders &amp; Schedule</strong>
                    <span>{activeReminders.length} active · {sortedScheduledItems.length} scheduled</span>
                </div>
                <button type="button" onClick={() => setShowForm((current) => !current)} aria-expanded={showForm} aria-controls="d2-reminders-create-form" aria-label={showForm ? 'Close new reminder form' : 'Create reminder'} title={showForm ? 'Close' : 'Create reminder'}>
                    <Icon icon={showForm ? X : Plus} size={16} />
                </button>
            </header>

            <div className="d2-reminders-scroll">
                {showForm ? (
                    <form id="d2-reminders-create-form" className="d2-reminders-form" onSubmit={(event) => void handleCreate(event)}>
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
                                {creating ? <Icon icon={LoaderCircle} size={14} /> : <Icon icon={Plus} size={14} />}
                                <span>{creating ? 'Adding' : 'Add reminder'}</span>
                            </button>
                        </div>
                    </form>
                ) : null}

                {mutationError ? <div className="d2-reminders-error" role="alert"><Icon icon={AlertCircle} size={14} /><span>{mutationError}</span></div> : null}

                {loading && reminders.length === 0 && scheduledItems.length === 0 ? (
                    <div className="d2-reminders-loading" role="status"><span className="d2-reminders-spinner"><Icon icon={LoaderCircle} size={16} /></span>Loading reminders...</div>
                ) : null}

                <section className="d2-reminders-section" aria-labelledby="d2-reminders-active-title">
                    <div className="d2-reminders-section-heading">
                        <h2 id="d2-reminders-active-title">Active Reminders</h2>
                        <span>{activeReminders.length}</span>
                    </div>
                    {remindersError ? (
                        <div className="d2-reminders-error" role="alert">
                            <Icon icon={AlertCircle} size={14} />
                            <span>{remindersError}</span>
                            <button type="button" onClick={() => void load(true)} title="Retry reminders"><Icon icon={RefreshCw} size={13} /></button>
                        </div>
                    ) : activeReminders.length > 0 ? renderReminderList(activeReminders) : (
                        <p className="d2-reminders-empty">No active reminders.</p>
                    )}
                </section>

                <section className="d2-reminders-section" aria-labelledby="d2-reminders-scheduled-title">
                    <div className="d2-reminders-section-heading">
                        <h2 id="d2-reminders-scheduled-title">Scheduled Tasks</h2>
                        <span>{sortedScheduledItems.length}</span>
                    </div>
                    {scheduleError ? (
                        <div className="d2-reminders-error" role="alert">
                            <Icon icon={AlertCircle} size={14} />
                            <span>{scheduleError}</span>
                            <button type="button" onClick={() => void load(true)} title="Retry schedule"><Icon icon={RefreshCw} size={13} /></button>
                        </div>
                    ) : sortedScheduledItems.length > 0 ? (
                        <ul className="d2-reminders-list">
                            {sortedScheduledItems.map((item) => <ScheduleRow key={item.id} item={item} />)}
                        </ul>
                    ) : (
                        <p className="d2-reminders-empty">No scheduled tasks.</p>
                    )}
                </section>

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
            </div>
        </div>
    );
}
