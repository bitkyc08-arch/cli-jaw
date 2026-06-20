export type TrayReminderDateItem = {
    status: string;
    dueAt: string | null;
};

export function parseTrayReminderDate(value: string | null): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

export function isTrayReminderOverdue(item: TrayReminderDateItem, now: Date): boolean {
    const due = parseTrayReminderDate(item.dueAt);
    return due !== null && due.getTime() < now.getTime();
}

export function isTrayReminderToday(item: TrayReminderDateItem, now: Date): boolean {
    const due = parseTrayReminderDate(item.dueAt);
    if (due === null) return false;
    return due.getFullYear() === now.getFullYear()
        && due.getMonth() === now.getMonth()
        && due.getDate() === now.getDate();
}

export function countTrayReminderBadgeItems(items: TrayReminderDateItem[], now: Date): number {
    return items.filter(item => (
        item.status !== 'done'
        && (isTrayReminderOverdue(item, now) || isTrayReminderToday(item, now))
    )).length;
}
