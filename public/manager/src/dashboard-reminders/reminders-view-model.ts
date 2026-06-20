import type { DashboardReminder, DashboardReminderCreateInput, DashboardReminderPatchInput } from './reminders-api';
import type { RemindersView } from './DashboardRemindersSidebar';
import { compareManualPriority } from './reminder-order';

export type MatrixBucket = 'urgentImportant' | 'important' | 'waiting' | 'later';
export type TrayReminderSectionId = 'overdue' | 'priority' | 'today';

export type MatrixSection = {
    id: MatrixBucket;
    title: string;
    tone: 'red' | 'green' | 'amber' | 'blue';
};

export const MATRIX_SECTIONS: readonly MatrixSection[] = [
    { id: 'urgentImportant', title: 'Important and Urgent', tone: 'red' },
    { id: 'important', title: 'Important, Not Urgent', tone: 'green' },
    { id: 'waiting', title: 'Waiting / Delegated', tone: 'amber' },
    { id: 'later', title: 'Later', tone: 'blue' },
] as const;

export const MATRIX_DEFAULTS: Record<MatrixBucket, Pick<DashboardReminderCreateInput, 'listId' | 'status' | 'priority'>> = {
    urgentImportant: { listId: 'today', status: 'open', priority: 'high' },
    important: { listId: 'today', status: 'open', priority: 'normal' },
    waiting: { listId: 'waiting', status: 'waiting', priority: 'normal' },
    later: { listId: 'later', status: 'open', priority: 'low' },
};

export function matrixBucketToPatch(bucket: MatrixBucket): DashboardReminderPatchInput {
    return MATRIX_DEFAULTS[bucket];
}

export function resolveReminderMatrixBucket(item: DashboardReminder): MatrixBucket | null {
    if (item.status === 'done') return null;
    if (item.status === 'focused') return 'urgentImportant';
    if (item.status === 'waiting') return 'waiting';
    if (item.listId === 'later' || item.priority === 'low') return 'later';
    if (item.priority === 'high') return 'urgentImportant';
    return 'important';
}

export function matrixItems(bucket: MatrixBucket, items: DashboardReminder[]): DashboardReminder[] {
    return items.filter(item => resolveReminderMatrixBucket(item) === bucket).sort(compareManualPriority);
}

export function remindersForView(view: RemindersView, items: DashboardReminder[]): DashboardReminder[] {
    if (view === 'matrix') return items.filter(item => item.status !== 'done').sort(compareManualPriority);
    if (view === 'done') return items.filter(item => item.status === 'done').sort(compareManualPriority);
    if (view === 'focused') return matrixItems('urgentImportant', items);
    if (view === 'important') return matrixItems('important', items);
    if (view === 'waiting') return matrixItems('waiting', items);
    if (view === 'later') return matrixItems('later', items);
    return items.filter(item => item.status !== 'done').sort(compareManualPriority);
}

export function countRemindersView(view: RemindersView, items: DashboardReminder[]): number {
    return remindersForView(view, items).length;
}

export function rankTopPriorityItems(items: DashboardReminder[], limit = 3): DashboardReminder[] {
    return items
        .filter(item => item.status !== 'done')
        .sort(compareManualPriority)
        .slice(0, limit);
}

export interface TrayTriageSections {
    overdue: DashboardReminder[];
    priority: DashboardReminder[];
    today: DashboardReminder[];
    upcomingCount: number;
    badgeCount: number;
}

export function buildTrayTriageSections(
    items: DashboardReminder[],
    now: Date,
    todayCap = 3,
): TrayTriageSections {
    const active = items.filter(item => item.status !== 'done');
    const overdue = active
        .filter(item => {
            const due = parseReminderDate(item.dueAt);
            return due !== null && due.getTime() < now.getTime();
        })
        .sort(compareManualPriority);
    const overdueIds = new Set(overdue.map(item => item.id));
    const afterOverdue = active.filter(item => !overdueIds.has(item.id));
    const priority = rankTopPriorityItems(afterOverdue, 3);
    const shownIds = new Set([...overdue, ...priority].map(item => item.id));
    const todayAll = afterOverdue
        .filter(item => {
            const due = parseReminderDate(item.dueAt);
            return due !== null && isSameLocalDay(due, now);
        })
        .sort(compareManualPriority);
    const today = todayAll.filter(item => !shownIds.has(item.id)).slice(0, todayCap);
    for (const item of today) shownIds.add(item.id);
    return {
        overdue,
        priority,
        today,
        upcomingCount: active.filter(item => !shownIds.has(item.id)).length,
        badgeCount: overdue.length + todayAll.length,
    };
}

function parseReminderDate(value: string | null): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function isSameLocalDay(left: Date, right: Date): boolean {
    return left.getFullYear() === right.getFullYear()
        && left.getMonth() === right.getMonth()
        && left.getDate() === right.getDate();
}
