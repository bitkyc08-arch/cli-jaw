import type {
    CreateReminderInput,
    Reminder,
    ScheduledItem,
    UpdateReminderInput,
} from './reminders-types.ts';

const REMINDERS_PATH = '/api/dashboard/reminders';
const SCHEDULE_PATH = '/api/dashboard/schedule/work';

type ListEnvelope<T> = {
    ok: true;
    items: T[];
};

type ItemEnvelope<T> = {
    ok: true;
    item: T;
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

function unwrapList<T>(payload: unknown): T[] {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid list response');
    const envelope = payload as Partial<ListEnvelope<T>>;
    if (envelope.ok !== true || !Array.isArray(envelope.items)) throw new Error('Invalid list response');
    return envelope.items;
}

function unwrapItem<T>(payload: unknown): T {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid item response');
    const envelope = payload as Partial<ItemEnvelope<T>>;
    if (envelope.ok !== true || envelope.item === undefined) throw new Error('Invalid item response');
    return envelope.item;
}

export async function listReminders(signal?: AbortSignal): Promise<Reminder[]> {
    const response = await fetch(REMINDERS_PATH, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...(signal === undefined ? {} : { signal }),
    });
    return unwrapList<Reminder>(await readJson(response));
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

export async function listScheduledItems(signal?: AbortSignal): Promise<ScheduledItem[]> {
    const response = await fetch(SCHEDULE_PATH, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...(signal === undefined ? {} : { signal }),
    });
    return unwrapList<ScheduledItem>(await readJson(response));
}
