import type {
    BoardLaneId,
    BoardTask,
    CreateBoardTaskInput,
    UpdateBoardTaskInput,
} from './board-types.ts';

interface RequestOptions {
    signal?: AbortSignal;
}

function taskBase(port: number): string {
    return `/i/${port}/api/tasks`;
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeStatus(value: unknown): BoardLaneId {
    switch (value) {
        case 'backlog':
        case 'inbox':
            return 'backlog';
        case 'todo':
        case 'ready':
        case 'pending':
            return 'todo';
        case 'in_progress':
        case 'active':
        case 'doing':
        case 'review':
        case 'blocked':
            return 'in_progress';
        case 'done':
        case 'complete':
        case 'completed':
        case 'cancelled':
            return 'done';
        default:
            return 'backlog';
    }
}

function normalizeTask(value: unknown): BoardTask | null {
    const item = record(value);
    if (!item || typeof item['id'] !== 'string') return null;
    const title = optionalString(item['title']) ?? optionalString(item['content']);
    if (!title) return null;

    return {
        id: item['id'],
        title,
        assignee: optionalString(item['assignee']) ?? optionalString(item['owner']),
        status: normalizeStatus(item['lane'] ?? item['status']),
        createdAt: optionalString(item['createdAt']) ?? optionalString(item['created_at']),
    };
}

function statusForApi(status: BoardLaneId): string {
    if (status === 'in_progress') return 'in_progress';
    if (status === 'done') return 'done';
    return 'pending';
}

async function responseJson(response: Response): Promise<unknown> {
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(body || `Task request failed (${response.status})`);
    }
    if (response.status === 204) return null;
    return await response.json() as unknown;
}

function taskFromPayload(payload: unknown): BoardTask {
    const body = record(payload);
    const task = normalizeTask(body?.['task'] ?? payload);
    if (!task) throw new Error('Task response was missing a valid task');
    return task;
}

export async function listBoardTasks(port: number, options: RequestOptions = {}): Promise<BoardTask[]> {
    const response = await fetch(taskBase(port), {
        cache: 'no-store',
        credentials: 'same-origin',
        ...(options.signal ? { signal: options.signal } : {}),
    });
    const payload = await responseJson(response);
    const body = record(payload);
    const items = Array.isArray(payload)
        ? payload
        : Array.isArray(body?.['tasks'])
            ? body['tasks']
            : [];
    return items.flatMap((item) => {
        const task = normalizeTask(item);
        return task ? [task] : [];
    });
}

export async function createBoardTask(port: number, input: CreateBoardTaskInput): Promise<BoardTask> {
    const response = await fetch(taskBase(port), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
            title: input.title,
            content: input.title,
            assignee: input.assignee || undefined,
            owner: input.assignee || undefined,
            lane: input.status,
            status: statusForApi(input.status),
        }),
    });
    return taskFromPayload(await responseJson(response));
}

export async function updateBoardTask(
    port: number,
    id: string,
    input: UpdateBoardTaskInput,
): Promise<BoardTask> {
    const response = await fetch(`${taskBase(port)}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
            ...(input.title !== undefined ? { title: input.title, content: input.title } : {}),
            ...(input.assignee !== undefined ? { assignee: input.assignee, owner: input.assignee } : {}),
            ...(input.status !== undefined
                ? { lane: input.status, status: statusForApi(input.status) }
                : {}),
        }),
    });
    return taskFromPayload(await responseJson(response));
}

export async function deleteBoardTask(port: number, id: string): Promise<void> {
    const response = await fetch(`${taskBase(port)}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
    });
    await responseJson(response);
}
