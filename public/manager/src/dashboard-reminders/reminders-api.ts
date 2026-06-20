export type DashboardReminderStatus = 'open' | 'focused' | 'waiting' | 'done';
export type DashboardReminderPriority = 'low' | 'normal' | 'high';
export type DashboardReminderNotificationStatus =
    | 'pending'
    | 'delivered'
    | 'no_channel'
    | 'failed'
    | 'invalid_remind_at';

export type DashboardReminder = {
    id: string;
    title: string;
    notes: string;
    listId: string;
    status: DashboardReminderStatus;
    priority: DashboardReminderPriority;
    manualRank: number | null;
    dueAt: string | null;
    remindAt: string | null;
    linkedInstance: string | null;
    subtasks: Array<{ id: string; title: string; done: boolean }>;
    source: 'dashboard';
    sourceCreatedAt: string;
    sourceUpdatedAt: string;
    mirroredAt: string;
    notificationStatus: DashboardReminderNotificationStatus;
    notificationAttemptedAt: string | null;
    notificationError: string | null;
    instanceId: string | null;
    messageId: string | null;
    turnIndex: number | null;
    port: number | null;
    threadKey: string | null;
    sourceText: string | null;
};

export type DashboardRemindersResponse = {
    ok: boolean;
    items?: DashboardReminder[];
};

export type DashboardReminderCreateInput = {
    title: string;
    notes?: string | null;
    listId?: string | null;
    status?: DashboardReminderStatus;
    priority?: DashboardReminderPriority;
    manualRank?: number | null;
    dueAt?: string | null;
    remindAt?: string | null;
    linkedInstance?: string | null;
};

export type DashboardReminderPatchInput = Partial<DashboardReminderCreateInput>;

const BASE = '/api/dashboard/reminders';

async function asJson<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status} ${body || res.statusText}`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        throw new Error('Reminders API is not available in the running dashboard server. Rebuild and restart the dashboard backend to enable sync.');
    }
    return await res.json() as T;
}

function normalizeReminder(item: DashboardReminder): DashboardReminder {
    return {
        ...item,
        notes: item.notes ?? '',
        manualRank: typeof item.manualRank === 'number' && Number.isFinite(item.manualRank) ? item.manualRank : null,
        dueAt: item.dueAt ?? null,
        remindAt: item.remindAt ?? null,
        linkedInstance: item.linkedInstance ?? null,
        subtasks: Array.isArray(item.subtasks) ? item.subtasks : [],
        notificationAttemptedAt: item.notificationAttemptedAt ?? null,
        notificationError: item.notificationError ?? null,
        instanceId: item.instanceId ?? null,
        messageId: item.messageId ?? null,
        turnIndex: item.turnIndex ?? null,
        port: item.port ?? null,
        threadKey: item.threadKey ?? null,
        sourceText: item.sourceText ?? null,
    };
}

function assertManualRankSupport(patch: DashboardReminderPatchInput, item: DashboardReminder): void {
    if ('manualRank' in patch && !Object.hasOwn(item, 'manualRank')) {
        throw new Error('Manual reminder ordering requires the dashboard backend to be rebuilt and restarted.');
    }
}

export async function listReminders(): Promise<DashboardRemindersResponse> {
    const res = await fetch(BASE, { credentials: 'same-origin', cache: 'no-store' });
    const body = await asJson<DashboardRemindersResponse>(res);
    return {
        ...body,
        items: Array.isArray(body.items) ? body.items.map(normalizeReminder) : [],
    };
}

export async function createReminder(input: DashboardReminderCreateInput): Promise<DashboardReminder> {
    const res = await fetch(BASE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
    });
    const body = await asJson<{ item: DashboardReminder }>(res);
    return normalizeReminder(body.item);
}

export async function updateReminder(id: string, patch: DashboardReminderPatchInput): Promise<DashboardReminder> {
    const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    });
    const body = await asJson<{ item: DashboardReminder }>(res);
    assertManualRankSupport(patch, body.item);
    return normalizeReminder(body.item);
}

export async function markReminderDone(id: string): Promise<DashboardReminder> {
    return await updateReminder(id, { status: 'done' });
}

export async function snoozeReminder(id: string, nextRemindAt: string): Promise<DashboardReminder> {
    return await updateReminder(id, { remindAt: nextRemindAt });
}
