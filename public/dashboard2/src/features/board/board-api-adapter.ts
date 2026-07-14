import type {
    BoardLaneId,
    BoardTask,
    CreateBoardTaskInput,
    UpdateBoardTaskInput,
} from './board-types.ts';

interface RequestOptions {
    signal?: AbortSignal;
}

type ServerBoardLane = 'backlog' | 'ready' | 'active' | 'review' | 'done';

const TASK_BASE = '/api/dashboard/board/tasks';

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function statusFromApi(value: unknown): BoardLaneId {
    switch (value) {
        case 'backlog':
            return 'backlog';
        case 'ready':
            return 'todo';
        case 'active':
            return 'in_progress';
        case 'review':
            return 'review';
        case 'done':
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
        summary: optionalString(item['summary']),
        detail: optionalString(item['detail']),
        status: statusFromApi(item['lane']),
        port: typeof item['port'] === 'number' ? item['port'] : null,
        threadKey: optionalString(item['threadKey']),
        notePath: optionalString(item['notePath']),
        source: optionalString(item['source']) ?? 'user',
        createdAt: optionalString(item['createdAt']),
        updatedAt: optionalString(item['updatedAt']),
    };
}

function statusForApi(status: BoardLaneId): ServerBoardLane {
    switch (status) {
        case 'backlog': return 'backlog';
        case 'todo': return 'ready';
        case 'in_progress': return 'active';
        case 'review': return 'review';
        case 'done': return 'done';
    }
}

async function responseJson(response: Response): Promise<unknown> {
    if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof body?.error === 'string' ? body.error : `Task request failed (${response.status})`);
    }
    if (response.status === 204) return null;
    return await response.json() as unknown;
}

function taskFromPayload(payload: unknown): BoardTask {
    const body = record(payload);
    const task = body?.['ok'] === true ? normalizeTask(body['task']) : null;
    if (!task) throw new Error('Task response was missing a valid task');
    return task;
}

export async function listBoardTasks(options: RequestOptions = {}): Promise<BoardTask[]> {
    const response = await fetch(TASK_BASE, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...(options.signal ? { signal: options.signal } : {}),
    });
    const payload = await responseJson(response);
    const body = record(payload);
    if (body?.['ok'] !== true || !Array.isArray(body['tasks'])) {
        throw new Error('Task response was missing a valid task list');
    }
    const items = body['tasks'];
    return items.flatMap((item) => {
        const task = normalizeTask(item);
        return task ? [task] : [];
    });
}

export async function createBoardTask(input: CreateBoardTaskInput): Promise<BoardTask> {
    const response = await fetch(TASK_BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
            title: input.title,
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            ...(input.detail !== undefined ? { detail: input.detail } : {}),
            lane: statusForApi(input.status),
        }),
    });
    return taskFromPayload(await responseJson(response));
}

export async function updateBoardTask(
    id: string,
    input: UpdateBoardTaskInput,
): Promise<BoardTask> {
    const response = await fetch(`${TASK_BASE}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            ...(input.detail !== undefined ? { detail: input.detail } : {}),
            ...(input.status !== undefined ? { lane: statusForApi(input.status) } : {}),
        }),
    });
    return taskFromPayload(await responseJson(response));
}

export async function deleteBoardTask(id: string): Promise<void> {
    const response = await fetch(`${TASK_BASE}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
    });
    const payload = record(await responseJson(response));
    if (payload?.['ok'] !== true) throw new Error('Task response did not confirm deletion');
}
