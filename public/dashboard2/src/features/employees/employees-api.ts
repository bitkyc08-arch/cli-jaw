export interface EmployeeRecord {
    id: string;
    name: string;
    cli: string;
    model: string | null;
    role: string | null;
    status: string | null;
}

export interface EmployeeSurfaceRow extends EmployeeRecord {
    state: string;
    taskPreview: string | null;
    progressUpdatedAt: number | null;
    attention: { kind: string; message: string } | null;
    active: boolean;
}

export interface EmployeeSurfaceData {
    rows: EmployeeSurfaceRow[];
    warnings: string[];
    loadedAt: number;
}

type FetchImpl = typeof fetch;
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonObject
        : null;
}

function string(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function arrayEnvelope(value: unknown, key?: string): unknown[] {
    if (Array.isArray(value)) return value;
    const root = object(value);
    if (!root) return [];
    if (key && Array.isArray(root[key])) return root[key];
    return Array.isArray(root['data']) ? root['data'] : [];
}

function normalizeEmployees(value: unknown): EmployeeRecord[] {
    return arrayEnvelope(value).flatMap((item) => {
        const row = object(item);
        const id = string(row?.['id']);
        const name = string(row?.['name']);
        if (!row || !id || !name) return [];
        return [{
            id,
            name,
            cli: string(row['cli']) ?? 'unknown',
            model: string(row['model']),
            role: string(row['role']),
            status: string(row['status']),
        }];
    });
}

function byAgentId(value: unknown, key?: string): Map<string, JsonObject> {
    const result = new Map<string, JsonObject>();
    for (const item of arrayEnvelope(value, key)) {
        const row = object(item);
        const agentId = string(row?.['agentId']) ?? string(row?.['employeeId']);
        if (row && agentId) result.set(agentId, row);
    }
    return result;
}

async function requestJson(fetchImpl: FetchImpl, url: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`${url} failed (${response.status})`);
    return await response.json() as unknown;
}

function progressFields(progress: JsonObject | undefined): {
    state: string | null;
    taskPreview: string | null;
    progressUpdatedAt: number | null;
    attention: EmployeeSurfaceRow['attention'];
} {
    const current = object(progress?.['current']);
    const attention = object(current?.['attention']);
    return {
        state: string(current?.['state']),
        taskPreview: string(current?.['taskPreview']),
        progressUpdatedAt: typeof current?.['progressUpdatedAt'] === 'number' ? current['progressUpdatedAt'] : null,
        attention: attention && string(attention['kind']) && string(attention['message'])
            ? { kind: string(attention['kind'])!, message: string(attention['message'])! }
            : null,
    };
}

export async function loadEmployeeSurface(
    port: number,
    options: { fetchImpl?: FetchImpl; signal?: AbortSignal; now?: () => number } = {},
): Promise<EmployeeSurfaceData> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const base = `/i/${port}/api`;
    const [employeesResult, activeResult, progressResult] = await Promise.allSettled([
        requestJson(fetchImpl, `${base}/employees`, options.signal),
        requestJson(fetchImpl, `${base}/orchestrate/workers`, options.signal),
        requestJson(fetchImpl, `${base}/orchestrate/worker-progress`, options.signal),
    ]);
    if (employeesResult.status === 'rejected') throw employeesResult.reason;

    const employees = normalizeEmployees(employeesResult.value);
    const active = activeResult.status === 'fulfilled' ? byAgentId(activeResult.value) : new Map<string, JsonObject>();
    const progress = progressResult.status === 'fulfilled' ? byAgentId(progressResult.value, 'workers') : new Map<string, JsonObject>();
    const warnings = [
        ...(activeResult.status === 'rejected' ? ['Active worker status is unavailable.'] : []),
        ...(progressResult.status === 'rejected' ? ['Worker progress is unavailable.'] : []),
    ];
    const rows = employees.map((employee): EmployeeSurfaceRow => {
        const activeWorker = active.get(employee.id);
        const fields = progressFields(progress.get(employee.id));
        const activeState = string(activeWorker?.['state']) ?? string(activeWorker?.['status']);
        const task = fields.taskPreview ?? string(activeWorker?.['task']);
        return {
            ...employee,
            state: fields.state ?? activeState ?? employee.status ?? 'idle',
            taskPreview: task ? task.slice(0, 200) : null,
            progressUpdatedAt: fields.progressUpdatedAt,
            attention: fields.attention,
            active: fields.state === 'running' || activeState === 'running',
        };
    }).sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));

    return { rows, warnings, loadedAt: (options.now ?? Date.now)() };
}
