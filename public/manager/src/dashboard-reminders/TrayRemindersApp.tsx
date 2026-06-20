import { useMemo } from 'react';
import { getDesktop } from '../panels/desktop-bridge';
import type { DashboardReminder } from './reminders-api';
import { useRemindersFeed } from './useRemindersFeed';
import {
    buildTrayTriageSections,
    type TrayReminderSectionId,
} from './reminders-view-model';

const SECTION_TITLES: Record<TrayReminderSectionId, string> = {
    overdue: 'Overdue',
    priority: 'Priority',
    today: 'Today',
};

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
    window.open('/?sidebar=reminders', 'cli-jaw-dashboard', 'noopener,noreferrer');
}

function TrayReminderRow(props: { item: DashboardReminder; section: TrayReminderSectionId }) {
    return (
        <li className="tray-reminders-row" data-section={props.section} data-priority={props.item.priority}>
            <span className="tray-reminders-row-main">
                <b>{props.item.title}</b>
                <small>{reminderMeta(props.item)}</small>
            </span>
            {props.item.priority === 'high' ? <span className="tray-reminders-priority-pill">High</span> : null}
        </li>
    );
}

function TrayReminderSection(props: {
    id: TrayReminderSectionId;
    items: DashboardReminder[];
}) {
    return (
        <section className="tray-reminders-section" data-section={props.id}>
            <header>
                <h2>{SECTION_TITLES[props.id]}</h2>
                <span>{props.items.length}</span>
            </header>
            <ol>
                {props.items.map(item => <TrayReminderRow key={item.id} item={item} section={props.id} />)}
                {props.items.length === 0 ? <li className="tray-reminders-empty-row">No reminders</li> : null}
            </ol>
        </section>
    );
}

export function TrayRemindersApp() {
    const feed = useRemindersFeed({ active: true });
    const now = useMemo(() => new Date(), [feed.items]);
    const sections = useMemo(
        () => buildTrayTriageSections(feed.items, now),
        [feed.items, now],
    );
    const todayCount = Math.max(0, sections.badgeCount - sections.overdue.length);
    const hasVisibleItems = sections.overdue.length > 0 || sections.priority.length > 0 || sections.today.length > 0;

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
                <TrayReminderSection id="overdue" items={sections.overdue} />
                <TrayReminderSection id="priority" items={sections.priority} />
                <TrayReminderSection id="today" items={sections.today} />
            </div>
            <footer className="tray-reminders-footer">
                <span>{sections.upcomingCount} upcoming</span>
                <button type="button" onClick={openDashboard}>Open Dashboard</button>
            </footer>
        </main>
    );
}
