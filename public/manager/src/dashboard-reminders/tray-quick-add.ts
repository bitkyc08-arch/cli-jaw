import type { DashboardReminderCreateInput } from './reminders-api';

export type TrayQuickAddMode = 'inbox' | 'today' | 'tomorrow' | 'pick-date';

export type TrayQuickAddDraft = {
    title: string;
    mode: TrayQuickAddMode;
    timeValue?: string;
    dateTimeValue?: string;
};

export type TrayQuickAddBuildResult =
    | { ok: true; input: DashboardReminderCreateInput }
    | { ok: false; error: string };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

export function defaultTrayQuickAddTime(mode: Exclude<TrayQuickAddMode, 'inbox' | 'pick-date'>, now: Date): string {
    if (mode === 'tomorrow') return '09:00';
    const next = new Date(now);
    next.setHours(next.getHours() + 1, 0, 0, 0);
    if (next.getDate() !== now.getDate()) return '23:59';
    return `${pad(next.getHours())}:00`;
}

export function defaultTrayQuickAddDateTime(now: Date): string {
    const next = new Date(now);
    next.setHours(next.getHours() + 1, 0, 0, 0);
    return [
        next.getFullYear(),
        pad(next.getMonth() + 1),
        pad(next.getDate()),
    ].join('-') + `T${pad(next.getHours())}:00`;
}

function localDateAtTime(base: Date, dayOffset: number, timeValue: string | undefined): Date | null {
    const match = TIME_RE.exec(timeValue ?? '');
    if (!match) return null;
    const date = new Date(base);
    date.setDate(date.getDate() + dayOffset);
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return date;
}

function localDateTimeValue(value: string | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

export function buildTrayQuickAddInput(draft: TrayQuickAddDraft, now: Date): TrayQuickAddBuildResult {
    const title = draft.title.trim();
    if (!title) return { ok: false, error: 'Enter a reminder title.' };

    const base: DashboardReminderCreateInput = {
        title,
        status: 'open',
        priority: 'normal',
    };

    if (draft.mode === 'inbox') return { ok: true, input: base };

    const date = draft.mode === 'pick-date'
        ? localDateTimeValue(draft.dateTimeValue)
        : localDateAtTime(baseNow(now), draft.mode === 'tomorrow' ? 1 : 0, draft.timeValue);

    if (!date) {
        return {
            ok: false,
            error: draft.mode === 'pick-date' ? 'Pick a valid date and time.' : 'Pick a valid time.',
        };
    }

    const iso = date.toISOString();
    return {
        ok: true,
        input: {
            ...base,
            dueAt: iso,
            remindAt: iso,
        },
    };
}

function baseNow(now: Date): Date {
    return new Date(now.getTime());
}
