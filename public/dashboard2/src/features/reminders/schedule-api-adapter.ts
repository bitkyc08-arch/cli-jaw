export type ScheduleGroup = 'today' | 'upcoming' | 'recurring' | 'blocked';

export interface ScheduleWorkItem {
    id: string;
    title: string;
    group: ScheduleGroup;
    cron: string | null;
    runAt: string | null;
    targetPort: number | null;
    payload: string | null;
    enabled: boolean;
    lastRunAt: string | null;
    lastStatus: string | null;
    nextRunAt: string | null;
}

const SCHEDULE_PATH = '/api/dashboard/schedule/work';

async function readItemResponse(response: Response): Promise<ScheduleWorkItem> {
    const body = await response.json().catch(() => null) as { ok?: boolean; item?: ScheduleWorkItem; error?: string } | null;
    if (!response.ok || body?.ok !== true || !body.item) throw new Error(body?.error || response.statusText || `Request failed (${response.status})`);
    return body.item;
}

export async function fetchScheduleWork(signal?: AbortSignal): Promise<ScheduleWorkItem[]> {
    const response = await fetch(SCHEDULE_PATH, { credentials: 'same-origin', cache: 'no-store', ...(signal ? { signal } : {}) });
    const body = await response.json().catch(() => null) as { ok?: boolean; items?: ScheduleWorkItem[]; error?: string } | null;
    if (!response.ok || body?.ok !== true || !Array.isArray(body.items)) throw new Error(body?.error || response.statusText || `Request failed (${response.status})`);
    return body.items;
}

export async function setScheduleWorkEnabled(id: string, enabled: boolean): Promise<ScheduleWorkItem> {
    const response = await fetch(`${SCHEDULE_PATH}/${encodeURIComponent(id)}`, {
        method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
    });
    return readItemResponse(response);
}
