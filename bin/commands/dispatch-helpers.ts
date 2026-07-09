import fs from 'node:fs';

export interface EmployeeSummary {
    id?: string;
    name?: string;
}

// ─── Task-file / task-tags helpers (260703 dispatch affordance) ─────
// Multi-line task briefs move out of shell quoting into files the boss
// writes with its own file tool; these helpers stay pure and unit-testable.

export interface TaskFileResult {
    ok: boolean;
    content?: string;
    error?: string;
}

export function readTaskFile(path: string, maxBytes = 1_048_576): TaskFileResult {
    try {
        if (!fs.existsSync(path)) {
            return { ok: false, error: `task file not found: ${path}` };
        }
        const size = fs.statSync(path).size;
        if (size > maxBytes) {
            return { ok: false, error: `task file too large: ${size} bytes (max ${maxBytes})` };
        }
        const content = fs.readFileSync(path, 'utf8');
        if (!content.trim()) {
            return { ok: false, error: `task file is empty: ${path}` };
        }
        return { ok: true, content };
    } catch (err) {
        return { ok: false, error: `task file read failed: ${(err as Error)?.message || String(err)}` };
    }
}

export function parseTaskTagsFlag(raw?: string): string[] {
    if (!raw || typeof raw !== 'string') return [];
    return raw
        .split(',')
        .map(t => t.trim().toLowerCase())
        .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isEmployeeSummary(value: unknown): value is EmployeeSummary {
    if (!isRecord(value)) return false;
    return typeof value['id'] === 'string' || typeof value['name'] === 'string';
}

export function unwrapEmployeeSummaries(body: unknown): EmployeeSummary[] {
    if (Array.isArray(body)) return body.filter(isEmployeeSummary);
    if (isRecord(body) && Array.isArray(body['data'])) {
        return body['data'].filter(isEmployeeSummary);
    }
    return [];
}
