// Phase 6 — pure helpers + types for the Memory page.
// Pulled out so the page module stays under the 500-line cap and the
// tests can import without dragging in React.

export type MemoryEntry = {
    key: string;
    value: string;
    source: string;
};

export type MemoryBlock = {
    enabled?: boolean;
    flushEvery?: number;
    cli?: string;
    retentionDays?: number;
    autoReflectAfterFlush?: boolean;
    flushLanguage?: string;
};

export const MEMORY_SECTION_A_KEYS = [
    'memory.enabled',
    'memory.flushEvery',
    'memory.cli',
    'memory.retentionDays',
    'memory.autoReflectAfterFlush',
    'memory.flushLanguage',
] as const;

export const FLUSH_LANGUAGE_OPTIONS = [
    { value: 'en', label: 'English (en)' },
    { value: 'ko', label: '한국어 (ko)' },
    { value: 'ja', label: '日本語 (ja)' },
    { value: 'zh', label: '中文 (zh)' },
] as const;

export const MEMORY_PAGE_SIZE = 50;

/** Whether the dotted key belongs to the shared `/api/settings` save bundle. */
export function isMemorySettingsKey(key: string): boolean {
    return (MEMORY_SECTION_A_KEYS as ReadonlyArray<string>).includes(key);
}

/**
 * Defensive parser for `GET /api/memory`. Server returns the raw rows
 * via `getMemory.all()`, which is `{ key, value, source }[]`. The
 * `ok()` http helper wraps responses in `{ ok: true, data }` so the
 * payload could either be `[]` or `{ data: [] }` depending on the
 * helper version. Accept both shapes.
 */
export function normalizeMemoryRows(payload: unknown): MemoryEntry[] {
    const raw = unwrapOkData(payload);
    if (!Array.isArray(raw)) return [];
    const out: MemoryEntry[] = [];
    for (const row of raw) {
        const entry = safeMemoryEntry(row);
        if (entry) out.push(entry);
    }
    return out;
}

function unwrapOkData(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object') return payload;
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj)) return obj;
    if ('data' in obj) return obj['data'];
    return payload;
}

function safeMemoryEntry(raw: unknown): MemoryEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const key = typeof r['key'] === 'string' ? r['key'] : null;
    if (!key) return null;
    const value = typeof r['value'] === 'string' ? r['value'] : '';
    const source = typeof r['source'] === 'string' ? r['source'] : 'manual';
    return { key, value, source };
}

/**
 * Validate user-typed numbers for memory.flushEvery / retentionDays.
 * Both must be positive integers. Returns the error string or null.
 */
export function validatePositiveInt(value: number, label: string): string | null {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        return `${label} must be a positive integer`;
    }
    return null;
}

/**
 * Slice rows for client-side pagination. The `/api/memory` endpoint
 * doesn't support server-side pagination today (P1 follow-up); 50
 * entries per page is the default budget agreed in the plan.
 */
export function paginate<T>(rows: ReadonlyArray<T>, page: number, size = MEMORY_PAGE_SIZE): {
    slice: T[];
    hasMore: boolean;
    pageCount: number;
} {
    const safePage = Math.max(0, Math.floor(page));
    const start = safePage * size;
    const slice = rows.slice(start, start + size);
    const pageCount = Math.max(1, Math.ceil(rows.length / size));
    const hasMore = start + size < rows.length;
    return { slice, hasMore, pageCount };
}

/** Render-friendly preview for a row in the table. */
export function previewValue(value: string, max = 80): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}…`;
}
