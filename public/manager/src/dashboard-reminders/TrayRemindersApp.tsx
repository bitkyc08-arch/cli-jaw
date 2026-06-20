import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { getDesktop } from '../panels/desktop-bridge';
import type { DashboardReminder, DashboardReminderCreateInput } from './reminders-api';
import { useRemindersFeed } from './useRemindersFeed';
import {
    buildTrayTriageSections,
    type TrayReminderSectionId,
} from './reminders-view-model';
import {
    buildTrayQuickAddInput,
    defaultTrayQuickAddDateTime,
    defaultTrayQuickAddTime,
    type TrayQuickAddMode,
} from './tray-quick-add';

const SECTION_TITLES: Record<TrayReminderSectionId, string> = {
    overdue: 'Overdue',
    priority: 'Priority',
    today: 'Today',
};

const QUICK_ADD_MODES: Array<{ id: TrayQuickAddMode; label: string }> = [
    { id: 'inbox', label: 'Inbox' },
    { id: 'today', label: 'Today' },
    { id: 'tomorrow', label: 'Tomorrow' },
    { id: 'pick-date', label: 'Pick date' },
];

function formatWhen(value: string | null): string | null {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function reminderMeta(item: DashboardReminder): string {
    const parts: string[] = [item.priority];
    const dueAt = formatWhen(item.dueAt);
    const remindAt = formatWhen(item.remindAt);
    if (dueAt) parts.push(`due ${dueAt}`);
    if (remindAt) parts.push(`remind ${remindAt}`);
    return parts.join(' / ');
}

function openDashboard(): void {
    const bridge = getDesktop()?.trayReminders;
    if (bridge?.openDashboard) {
        bridge.openDashboard();
        return;
    }
    window.location.assign('/?sidebar=reminders');
}

function snoozeTime(option: string): string | null {
    const next = new Date();
    if (option === 'later-today') {
        next.setHours(next.getHours() + 3, 0, 0, 0);
        return next.toISOString();
    }
    if (option === 'tomorrow') {
        next.setDate(next.getDate() + 1);
        next.setHours(9, 0, 0, 0);
        return next.toISOString();
    }
    if (option === 'next-week') {
        next.setDate(next.getDate() + 7);
        next.setHours(9, 0, 0, 0);
        return next.toISOString();
    }
    return null;
}

function TrayReminderRow(props: {
    item: DashboardReminder;
    section: TrayReminderSectionId;
    busy: boolean;
    onMarkDone: (id: string) => void;
    onSnooze: (id: string, nextRemindAt: string) => void;
}) {
    return (
        <li className="tray-reminders-row" data-section={props.section} data-priority={props.item.priority}>
            <span className="tray-reminders-row-main">
                <b>{props.item.title}</b>
                <small>{reminderMeta(props.item)}</small>
            </span>
            <span className="tray-reminders-row-actions">
                {props.item.priority === 'high' ? <span className="tray-reminders-priority-pill">High</span> : null}
                <button type="button" aria-label="Mark done" onClick={() => props.onMarkDone(props.item.id)} disabled={props.busy}>Done</button>
                <select
                    aria-label="Snooze reminder"
                    value=""
                    disabled={props.busy}
                    onChange={event => {
                        const next = snoozeTime(event.target.value);
                        event.currentTarget.value = '';
                        if (next) props.onSnooze(props.item.id, next);
                    }}
                >
                    <option value="" disabled>Snooze</option>
                    <option value="later-today">Later today</option>
                    <option value="tomorrow">Tomorrow</option>
                    <option value="next-week">Next week</option>
                </select>
            </span>
        </li>
    );
}

function TrayReminderSection(props: {
    id: TrayReminderSectionId;
    items: DashboardReminder[];
    busy: boolean;
    onMarkDone: (id: string) => void;
    onSnooze: (id: string, nextRemindAt: string) => void;
}) {
    return (
        <section className="tray-reminders-section" data-section={props.id}>
            <header>
                <h2>{SECTION_TITLES[props.id]}</h2>
                <span>{props.items.length}</span>
            </header>
            <ol>
                {props.items.map(item => (
                    <TrayReminderRow
                        key={item.id}
                        item={item}
                        section={props.id}
                        busy={props.busy}
                        onMarkDone={props.onMarkDone}
                        onSnooze={props.onSnooze}
                    />
                ))}
                {props.items.length === 0 ? <li className="tray-reminders-empty-row">No reminders</li> : null}
            </ol>
        </section>
    );
}

function TrayReminderQuickAddComposer(props: {
    busy: boolean;
    onCreate: (input: DashboardReminderCreateInput) => Promise<void>;
}) {
    const initialNow = useMemo(() => new Date(), []);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [title, setTitle] = useState('');
    const [mode, setMode] = useState<TrayQuickAddMode>('inbox');
    const [timeValue, setTimeValue] = useState(defaultTrayQuickAddTime('today', initialNow));
    const [tomorrowTimeValue, setTomorrowTimeValue] = useState(defaultTrayQuickAddTime('tomorrow', initialNow));
    const [dateTimeValue, setDateTimeValue] = useState(defaultTrayQuickAddDateTime(initialNow));
    const [localError, setLocalError] = useState<string | null>(null);

    const activeTimeValue = mode === 'tomorrow' ? tomorrowTimeValue : timeValue;
    const draft = { title, mode, timeValue: activeTimeValue, dateTimeValue };
    const built = buildTrayQuickAddInput(draft, new Date());
    const canSubmit = built.ok && !props.busy;

    const submit = async (): Promise<void> => {
        const result = buildTrayQuickAddInput(draft, new Date());
        if (!result.ok) {
            setLocalError(result.error);
            return;
        }
        setLocalError(null);
        try {
            await props.onCreate(result.input);
            setTitle('');
            inputRef.current?.focus();
        } catch (err) {
            setLocalError((err as Error).message);
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key !== 'Escape') return;
        if (!title && !localError) return;
        event.preventDefault();
        setTitle('');
        setLocalError(null);
    };

    return (
        <section className="tray-reminders-composer" aria-label="Add reminder">
            <div className="tray-reminders-composer-modes" role="group" aria-label="Quick add mode">
                {QUICK_ADD_MODES.map(option => (
                    <button
                        key={option.id}
                        type="button"
                        aria-pressed={mode === option.id}
                        onClick={() => {
                            setMode(option.id);
                            setLocalError(null);
                        }}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
            <form
                className="tray-reminders-composer-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                }}
            >
                <input
                    ref={inputRef}
                    aria-label="Reminder title"
                    placeholder="Add reminder..."
                    value={title}
                    onChange={event => {
                        setTitle(event.target.value);
                        setLocalError(null);
                    }}
                    onKeyDown={onKeyDown}
                />
                <button type="submit" disabled={!canSubmit}>Add</button>
            </form>
            <div className="tray-reminders-composer-date-row" data-mode={mode}>
                {mode === 'today' ? (
                    <label>
                        <span>Today</span>
                        <input aria-label="Today reminder time" type="time" value={timeValue} onChange={event => setTimeValue(event.target.value)} />
                    </label>
                ) : null}
                {mode === 'tomorrow' ? (
                    <label>
                        <span>Tomorrow</span>
                        <input aria-label="Tomorrow reminder time" type="time" value={tomorrowTimeValue} onChange={event => setTomorrowTimeValue(event.target.value)} />
                    </label>
                ) : null}
                {mode === 'pick-date' ? (
                    <label>
                        <span>Pick date</span>
                        <input aria-label="Reminder date and time" type="datetime-local" value={dateTimeValue} onChange={event => setDateTimeValue(event.target.value)} />
                    </label>
                ) : <span aria-hidden="true" />}
            </div>
            {localError ? <p className="tray-reminders-composer-error">{localError}</p> : null}
        </section>
    );
}

export function TrayRemindersApp() {
    const feed = useRemindersFeed({ active: true, pollWhileActiveMs: 30000 });
    const now = useMemo(() => new Date(), [feed.items]);
    const sections = useMemo(
        () => buildTrayTriageSections(feed.items, now),
        [feed.items, now],
    );
    const todayCount = Math.max(0, sections.badgeCount - sections.overdue.length);
    const hasVisibleItems = sections.overdue.length > 0 || sections.priority.length > 0 || sections.today.length > 0;
    const markDone = (id: string): void => {
        void feed.markDone(id).then(() => feed.refresh());
    };
    const snooze = (id: string, nextRemindAt: string): void => {
        void feed.snooze(id, nextRemindAt).then(() => feed.refresh());
    };

    return (
        <main className="tray-reminders-app" aria-label="Tray reminders">
            <header className="tray-reminders-header">
                <span>
                    <b>Reminders</b>
                    <small>overdue {sections.overdue.length} / today {todayCount}</small>
                </span>
                <button type="button" className="tray-reminders-menu-button" aria-label="Open tray menu" onClick={() => getDesktop()?.trayReminders?.popUpMenu()}>
                    ...
                </button>
            </header>
            {feed.error ? <p className="tray-reminders-status" data-state="error">{feed.error}</p> : null}
            {feed.loading && feed.items.length === 0 ? <p className="tray-reminders-status">Loading reminders</p> : null}
            {!feed.loading && !feed.error && !hasVisibleItems ? <p className="tray-reminders-empty">No urgent reminders</p> : null}
            <div className="tray-reminders-sections">
                <TrayReminderSection id="overdue" items={sections.overdue} busy={feed.loading} onMarkDone={markDone} onSnooze={snooze} />
                <TrayReminderSection id="priority" items={sections.priority} busy={feed.loading} onMarkDone={markDone} onSnooze={snooze} />
                <TrayReminderSection id="today" items={sections.today} busy={feed.loading} onMarkDone={markDone} onSnooze={snooze} />
            </div>
            <TrayReminderQuickAddComposer busy={feed.loading} onCreate={(input) => feed.create(input).then(() => feed.refresh())} />
            <footer className="tray-reminders-footer">
                <span>{sections.upcomingCount} upcoming</span>
                <button type="button" onClick={openDashboard}>Open Dashboard</button>
            </footer>
        </main>
    );
}
