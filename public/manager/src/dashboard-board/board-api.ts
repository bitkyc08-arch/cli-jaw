export type DashboardTaskLane = 'inbox' | 'doing' | 'blocked' | 'review' | 'done';

export type DashboardTask = {
    id: string;
    title: string;
    summary: string | null;
    detail: string | null;
    lane: DashboardTaskLane;
    port: number | null;
    threadKey: string | null;
    notePath: string | null;
    source: string;
    createdAt: string;
    updatedAt: string;
};

export type DashboardTaskInput = {
    title: string;
    summary?: string | null;
    detail?: string | null;
    lane?: DashboardTaskLane;
    port?: number | null;
    threadKey?: string | null;
    notePath?: string | null;
    source?: string;
};

export type DashboardTaskPatch = Partial<Omit<DashboardTaskInput, 'source'>>;

const BASE = '/api/dashboard/board';

function normalizeTask(task: DashboardTask): DashboardTask {
    return {
        ...task,
        summary: task.summary ?? null,
        detail: task.detail ?? null,
    };
}

async function asJson<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status} ${body || res.statusText}`);
    }
    return await res.json() as T;
}

export async function listTasks(): Promise<DashboardTask[]> {
    const res = await fetch(`${BASE}/tasks`, { credentials: 'same-origin', cache: 'no-store' });
    const body = await asJson<{ ok: boolean; tasks?: DashboardTask[] }>(res);
    return Array.isArray(body.tasks) ? body.tasks.map(normalizeTask) : [];
}

export async function createTask(input: DashboardTaskInput): Promise<DashboardTask> {
    const res = await fetch(`${BASE}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(input),
    });
    const body = await asJson<{ ok: boolean; task: DashboardTask }>(res);
    return normalizeTask(body.task);
}

export async function updateTask(id: string, patch: DashboardTaskPatch): Promise<DashboardTask> {
    const res = await fetch(`${BASE}/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(patch),
    });
    const body = await asJson<{ ok: boolean; task: DashboardTask }>(res);
    return normalizeTask(body.task);
}

export async function deleteTask(id: string): Promise<void> {
    const res = await fetch(`${BASE}/tasks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
    });
    await asJson<{ ok: boolean }>(res);
}

export type FromMessageInput = {
    port: number;
    threadKey?: string | null;
    title?: string;
    lane?: DashboardTaskLane;
};

export async function createTaskFromMessage(input: FromMessageInput): Promise<DashboardTask> {
    const res = await fetch(`${BASE}/tasks/from-message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(input),
    });
    const body = await asJson<{ ok: boolean; task: DashboardTask }>(res);
    return normalizeTask(body.task);
}
