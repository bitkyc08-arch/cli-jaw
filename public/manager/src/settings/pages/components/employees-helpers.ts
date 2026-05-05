// Phase 6 — pure helpers + types for the Employees page.

export type EmployeeRecord = {
    id: string;
    name: string;
    cli: string;
    role: string;
    prompt: string;
    active: boolean;
};

export const EMPLOYEE_KEYS = ['employees'] as const;

export const DEFAULT_CLI_OPTIONS = [
    'codex',
    'claude',
    'copilot',
    'gemini',
] as const;

let counter = 0;
function fallbackId(): string {
    counter += 1;
    return `emp_${Date.now().toString(36)}_${counter}`;
}

/**
 * Generate a stable id for a brand-new row. Prefers `crypto.randomUUID`
 * when available (modern browsers + node 19+) and falls back to a
 * deterministic counter so unit tests don't fail on JSDOM-less Node.
 */
export function newEmployeeId(): string {
    const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (g && typeof g.randomUUID === 'function') {
        try {
            return g.randomUUID();
        } catch {
            /* fall through */
        }
    }
    return fallbackId();
}

export function makeDefaultEmployee(id: string = newEmployeeId()): EmployeeRecord {
    return {
        id,
        name: '',
        cli: 'claude',
        role: '',
        prompt: '',
        active: true,
    };
}

/**
 * Defensive parser for the `settings.employees` array. The plan calls
 * out backwards-compat as a risk: legacy installs may store a bare
 * `string[]` of employee names, while newer ones store the full object
 * shape. Accept both, drop garbage rows.
 */
export function normalizeEmployees(payload: unknown): EmployeeRecord[] {
    if (!Array.isArray(payload)) return [];
    const out: EmployeeRecord[] = [];
    let fallback = 0;
    for (const raw of payload) {
        if (typeof raw === 'string') {
            fallback += 1;
            out.push({
                ...makeDefaultEmployee(`emp_legacy_${fallback}`),
                name: raw,
            });
            continue;
        }
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const name = typeof r['name'] === 'string' ? r['name'] : '';
        if (!name && !r['id']) continue;
        fallback += 1;
        const id =
            typeof r['id'] === 'string' && r['id'].trim()
                ? r['id'].trim()
                : `emp_unknown_${fallback}`;
        const cli =
            typeof r['cli'] === 'string' && r['cli'].trim() ? r['cli'].trim() : 'claude';
        const role = typeof r['role'] === 'string' ? r['role'] : '';
        const prompt = typeof r['prompt'] === 'string' ? r['prompt'] : '';
        const active = r['active'] !== false;
        out.push({ id, name, cli, role, prompt, active });
    }
    return out;
}

/**
 * Per-row validation. Empty names are the only blocker — everything
 * else has a sensible default.
 */
export function employeeRowError(row: EmployeeRecord): string | null {
    if (!row.name.trim()) return 'Name is required';
    if (!row.cli.trim()) return 'CLI is required';
    return null;
}

export function employeesHaveErrors(rows: ReadonlyArray<EmployeeRecord>): boolean {
    return rows.some((row) => employeeRowError(row) !== null);
}

/**
 * Detect duplicate names case-insensitively. Returns the set of lowercased
 * duplicate names so the UI can flag every offending row.
 */
export function duplicateNameSet(rows: ReadonlyArray<EmployeeRecord>): Set<string> {
    const seen = new Map<string, number>();
    for (const row of rows) {
        const key = row.name.trim().toLowerCase();
        if (!key) continue;
        seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const dupes = new Set<string>();
    for (const [key, count] of seen) {
        if (count > 1) dupes.add(key);
    }
    return dupes;
}

/**
 * Strip presentational fields before saving so the persisted shape
 * matches the plan: `{ name, cli, role, prompt?, active }`. Keeps
 * `id` so subsequent loads round-trip stably.
 */
export function toPersistShape(rows: ReadonlyArray<EmployeeRecord>): unknown[] {
    return rows.map((row) => {
        const out: Record<string, unknown> = {
            id: row.id,
            name: row.name.trim(),
            cli: row.cli.trim() || 'claude',
            role: row.role.trim(),
            active: row.active,
        };
        if (row['prompt'].trim()) out['prompt'] = row['prompt'];
        return out;
    });
}
