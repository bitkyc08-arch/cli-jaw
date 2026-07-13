import type {
    CreateReminderInput,
    Reminder,
    ScheduledItem,
    UpdateReminderInput,
} from './reminders-types.ts';

const REMINDERS_PATH = '/api/reminders';
const SCHEDULE_PATH = '/api/schedule';

type ListEnvelope<T> = {
    items?: T[];
    reminders?: T[];
    schedules?: T[];
};

async function readJson(response: Response): Promise<unknown> {
    if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null;
        const detail = payload?.error ?? payload?.message ?? response.statusText;
        throw new Error(detail || `Request failed (${response.status})`);
    }
    if (response.status === 204) return null;
    return await response.json();
}

function unwrapList<T>(payload: unknown, keys: ReadonlyArray<keyof ListEnvelope<T>>): T[] {
    if (Array.isArray(payload)) return payload as T[];
    if (!payload || typeof payload !== 'object') return [];
    const envelope = payload as ListEnvelope<T>;
    for (const key of keys) {
        const value = envelope[key];
        if (Array.isArray(value)) return value;
    }
    return [];
}

function unwrapItem<T>(payload: unknown): T {
    if (payload && typeof payload === 'object' && 'item' in payload) {
        return (payload as { item: T }).item;
    }
    return payload as T;
}

export async function listReminders(signal?: AbortSignal): Promise<Reminder[]> {
    const response = await fetch(REMINDERS_PATH, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
    });
    return unwrapList<Reminder>(await readJson(response), ['items', 'reminders']);
}

export async function createReminder(input: CreateReminderInput): Promise<Reminder> {
    const response = await fetch(REMINDERS_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
    });
    return unwrapItem<Reminder>(await readJson(response));
}

export async function updateReminder(id: string, input: UpdateReminderInput): Promise<Reminder> {
    const response = await fetch(`${REMINDERS_PATH}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
    });
    return unwrapItem<Reminder>(await readJson(response));
}

export async function deleteReminder(id: string): Promise<void> {
    const response = await fetch(`${REMINDERS_PATH}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
    });
    await readJson(response);
}

export async function listScheduledItems(signal?: AbortSignal): Promise<ScheduledItem[]> {
    const response = await fetch(SCHEDULE_PATH, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
    });
    return unwrapList<ScheduledItem>(await readJson(response), ['items', 'schedules']);
}
