import type { DashboardReminderCreateInput } from './reminders-api';

export type TrayQuickAddMode = 'important-urgent' | 'important' | 'urgent' | 'later';

export type TrayQuickAddDraft = {
    title: string;
    mode: TrayQuickAddMode;
    timeValue?: string;
};

export type TrayQuickAddBuildResult =
    | { ok: true; input: DashboardReminderCreateInput }
    | { ok: false; error: string };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

export function defaultTrayQuickAddTime(now: Date): string {
    const next = new Date(now);
    next.setHours(next.getHours() + 1, 0, 0, 0);
    if (next.getDate() !== now.getDate()) return '23:59';
    return `${pad(next.getHours())}:00`;
}

function localDateAtTime(base: Date, timeValue: string | undefined): Date | null {
    const match = TIME_RE.exec(timeValue ?? '');
    if (!match) return null;
    const date = new Date(base);
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return date;
}

export function buildTrayQuickAddInput(draft: TrayQuickAddDraft, now: Date): TrayQuickAddBuildResult {
    const title = draft.title.trim();
    if (!title) return { ok: false, error: 'Enter a reminder title.' };

    const base: DashboardReminderCreateInput = {
        title,
        status: 'open',
        priority: draft.mode === 'important' || draft.mode === 'important-urgent' ? 'high' : 'normal',
    };

    if (draft.mode !== 'important-urgent' && draft.mode !== 'urgent') {
        return { ok: true, input: base };
    }

    const date = localDateAtTime(baseNow(now), draft.timeValue);

    if (!date) {
        return { ok: false, error: 'Pick a valid time.' };
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
