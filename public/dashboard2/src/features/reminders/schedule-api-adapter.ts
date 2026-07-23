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
    createdAt: string;
    updatedAt: string;
}

export interface ScheduleWorkInput {
    title: string;
    group?: ScheduleGroup;
    cron?: string | null;
    runAt?: string | null;
    targetPort?: number | null;
    payload?: string | null;
    enabled?: boolean;
}

export type ScheduleWorkPatch = Partial<ScheduleWorkInput>;

export type ScheduleDispatchStatus = 'disabled' | 'no_target' | 'queued' | 'dispatched' | 'claim-changed';

export interface ScheduleDispatchResult {
    status: ScheduleDispatchStatus;
    message: string;
    targetPort: number | null;
}

export interface ScheduleDispatchResponse {
    result: ScheduleDispatchResult;
    item: ScheduleWorkItem;
}

export interface ScheduleApi {
    list(signal?: AbortSignal): Promise<ScheduleWorkItem[]>;
    create(input: ScheduleWorkInput): Promise<ScheduleWorkItem>;
    update(id: string, patch: ScheduleWorkPatch): Promise<ScheduleWorkItem>;
    remove(id: string): Promise<void>;
    dispatch(id: string, busyPorts?: number[]): Promise<ScheduleDispatchResponse>;
}

const SCHEDULE_PATH = '/api/dashboard/schedule/work';

type ItemEnvelope = { ok?: boolean; item?: ScheduleWorkItem; error?: string };

function responseError(response: Response, error?: string): Error {
    return new Error(error || response.statusText || `Request failed (${response.status})`);
}

async function readItemResponse(response: Response): Promise<ScheduleWorkItem> {
    const body = await response.json().catch(() => null) as ItemEnvelope | null;
    if (!response.ok || body?.ok !== true || !body.item) throw responseError(response, body?.error);
    return body.item;
}

export async function fetchScheduleWork(signal?: AbortSignal): Promise<ScheduleWorkItem[]> {
    const response = await fetch(SCHEDULE_PATH, { credentials: 'same-origin', cache: 'no-store', ...(signal ? { signal } : {}) });
    const body = await response.json().catch(() => null) as { ok?: boolean; items?: ScheduleWorkItem[]; error?: string } | null;
    if (!response.ok || body?.ok !== true || !Array.isArray(body.items)) throw responseError(response, body?.error);
    return body.items;
}

export async function createScheduleWork(input: ScheduleWorkInput): Promise<ScheduleWorkItem> {
    const response = await fetch(SCHEDULE_PATH, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    return readItemResponse(response);
}

export async function updateScheduleWork(id: string, patch: ScheduleWorkPatch): Promise<ScheduleWorkItem> {
    const response = await fetch(`${SCHEDULE_PATH}/${encodeURIComponent(id)}`, {
        method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    return readItemResponse(response);
}

export async function setScheduleWorkEnabled(id: string, enabled: boolean): Promise<ScheduleWorkItem> {
    return updateScheduleWork(id, { enabled });
}

export async function deleteScheduleWork(id: string): Promise<void> {
    const response = await fetch(`${SCHEDULE_PATH}/${encodeURIComponent(id)}`, {
        method: 'DELETE', credentials: 'same-origin',
    });
    const body = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!response.ok || body?.ok !== true) throw responseError(response, body?.error);
}

function normalizeDispatchStatus(status: string, message: string): ScheduleDispatchStatus {
    if (status === 'queued' && /(?:item changed|item removed) before dispatch/i.test(message)) return 'claim-changed';
    if (status === 'disabled' || status === 'no_target' || status === 'queued' || status === 'dispatched') return status;
    throw new Error(`Unknown dispatch decision status: ${status}`);
}

export async function dispatchScheduleWork(id: string, busyPorts: number[] = []): Promise<ScheduleDispatchResponse> {
    const response = await fetch(`${SCHEDULE_PATH}/${encodeURIComponent(id)}/dispatch`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ busyPorts }),
    });
    const body = await response.json().catch(() => null) as {
        ok?: boolean;
        result?: { status?: string; message?: string; targetPort?: number | null };
        item?: ScheduleWorkItem;
        error?: string;
    } | null;
    if (!response.ok || body?.ok !== true || !body.item || !body.result || typeof body.result.status !== 'string') {
        throw responseError(response, body?.error);
    }
    const message = typeof body.result.message === 'string' ? body.result.message : '';
    return {
        result: {
            status: normalizeDispatchStatus(body.result.status, message),
            message,
            targetPort: typeof body.result.targetPort === 'number' ? body.result.targetPort : null,
        },
        item: body.item,
    };
}

export const scheduleApi: ScheduleApi = {
    list: fetchScheduleWork,
    create: createScheduleWork,
    update: updateScheduleWork,
    remove: deleteScheduleWork,
    dispatch: dispatchScheduleWork,
};
