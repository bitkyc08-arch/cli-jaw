export interface SanitizableToolLogEntry {
    icon?: unknown;
    rawIcon?: unknown;
    label?: unknown;
    detail?: unknown;
    toolType?: unknown;
    stepRef?: unknown;
    status?: unknown;
    [key: string]: unknown;
}

export interface SanitizedToolLogEntry {
    icon: string;
    rawIcon?: string;
    label: string;
    detail?: string;
    toolType?: string;
    stepRef?: string;
    status?: string;
}

export const MAX_TOOL_LOG_RAW_INPUT_CHARS = 180_000;
export const MAX_TOOL_LOG_ENTRIES = 160;
export const MAX_TOOL_LOG_STRING_CHARS = 240;
export const MAX_TOOL_LOG_DETAIL_CHARS = 3_000;
export const MAX_TOOL_LOG_TOTAL_DETAIL_CHARS = 24_000;
export const MAX_TOOL_LOG_JSON_CHARS = 64_000;

const TRUNCATION_ICON = '⚠️';
const TRUNCATION_LABEL = 'Tool log truncated';
const TRUNCATION_DETAIL = 'Tool log was truncated for dashboard memory safety.';

function asBoundedString(value: unknown, max: number): string | undefined {
    if (value == null) return undefined;
    const raw = String(value);
    if (!raw) return undefined;
    if (raw.length <= max) return raw;
    return `${raw.slice(0, Math.max(0, max - 1))}…`;
}

function truncationNotice(kept: number, total: number): string {
    return `[detail truncated: kept ${kept} of ${total} chars]`;
}

function makeOverflowEntry(omitted: number): SanitizedToolLogEntry {
    const suffix = omitted > 0 ? `${omitted} tool event${omitted === 1 ? '' : 's'} omitted` : TRUNCATION_LABEL;
    return {
        icon: TRUNCATION_ICON,
        label: asBoundedString(suffix, MAX_TOOL_LOG_STRING_CHARS) || TRUNCATION_LABEL,
        toolType: 'tool',
        status: 'done',
        detail: TRUNCATION_DETAIL,
    };
}

export function sanitizeToolLogEntry(
    entry: SanitizableToolLogEntry,
    detailBudget = MAX_TOOL_LOG_DETAIL_CHARS,
): SanitizedToolLogEntry {
    const detailRaw = entry.detail == null ? '' : String(entry.detail);
    const allowedDetail = Math.max(0, Math.min(MAX_TOOL_LOG_DETAIL_CHARS, detailBudget));
    let detail = asBoundedString(detailRaw, allowedDetail);
    if (detail && detailRaw.length > allowedDetail) {
        const notice = truncationNotice(detail.length, detailRaw.length);
        const room = Math.max(0, allowedDetail - notice.length - 1);
        detail = `${detailRaw.slice(0, room)}\n${notice}`;
    }
    const sanitized: SanitizedToolLogEntry = {
        icon: asBoundedString(entry.icon, MAX_TOOL_LOG_STRING_CHARS) || '🔧',
        label: asBoundedString(entry.label, MAX_TOOL_LOG_STRING_CHARS) || 'tool',
    };
    const rawIcon = asBoundedString(entry.rawIcon, MAX_TOOL_LOG_STRING_CHARS);
    const toolType = asBoundedString(entry.toolType, MAX_TOOL_LOG_STRING_CHARS);
    const stepRef = asBoundedString(entry.stepRef, MAX_TOOL_LOG_STRING_CHARS);
    const status = asBoundedString(entry.status, MAX_TOOL_LOG_STRING_CHARS);
    if (rawIcon) sanitized.rawIcon = rawIcon;
    if (detail) sanitized.detail = detail;
    if (toolType) sanitized.toolType = toolType;
    if (stepRef) sanitized.stepRef = stepRef;
    if (status) sanitized.status = status;
    return sanitized;
}

export function sanitizeToolLogForDurableStorage(entries: unknown): SanitizedToolLogEntry[] {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const overflow = Math.max(0, entries.length - MAX_TOOL_LOG_ENTRIES);
    const cappedEntries = entries.slice(0, MAX_TOOL_LOG_ENTRIES);
    const output: SanitizedToolLogEntry[] = [];
    let detailBudgetLeft = MAX_TOOL_LOG_TOTAL_DETAIL_CHARS;
    for (const raw of cappedEntries) {
        const entry: SanitizableToolLogEntry = (raw && typeof raw === 'object')
            ? raw as SanitizableToolLogEntry
            : { label: raw };
        const detailRawLength = entry.detail == null ? 0 : String(entry.detail).length;
        const detailBudget = Math.min(MAX_TOOL_LOG_DETAIL_CHARS, detailBudgetLeft);
        const sanitized = sanitizeToolLogEntry(entry, detailBudget);
        output.push(sanitized);
        detailBudgetLeft = Math.max(0, detailBudgetLeft - Math.min(detailRawLength, detailBudget));
        if (detailBudgetLeft <= 0) detailBudgetLeft = 0;
    }
    if (overflow > 0) {
        if (output.length >= MAX_TOOL_LOG_ENTRIES) output.pop();
        output.push(makeOverflowEntry(overflow));
    }
    return fitToolLogToJsonCap(output);
}

function shrinkEntryForJson(entry: SanitizedToolLogEntry): SanitizedToolLogEntry {
    const shrunk: SanitizedToolLogEntry = {
        icon: asBoundedString(entry.icon, 24) || '🔧',
        label: asBoundedString(entry.label, 80) || 'tool',
    };
    const toolType = asBoundedString(entry.toolType, 48);
    const stepRef = asBoundedString(entry.stepRef, 80);
    const status = asBoundedString(entry.status, 24);
    const detail = asBoundedString(entry.detail, 180);
    if (toolType) shrunk.toolType = toolType;
    if (stepRef) shrunk.stepRef = stepRef;
    if (status) shrunk.status = status;
    if (detail) shrunk.detail = detail;
    return shrunk;
}

function fitToolLogToJsonCap(entries: SanitizedToolLogEntry[]): SanitizedToolLogEntry[] {
    let fitted = entries.map(shrinkEntryForJson);
    let json = JSON.stringify(fitted);
    while (json.length > MAX_TOOL_LOG_JSON_CHARS && fitted.length > 1) {
        fitted.splice(Math.max(0, fitted.length - 2), 1);
        fitted[fitted.length - 1] = makeOverflowEntry(entries.length - fitted.length + 1);
        json = JSON.stringify(fitted);
    }
    if (json.length <= MAX_TOOL_LOG_JSON_CHARS) return fitted;
    const minimal = [{
        icon: TRUNCATION_ICON,
        label: TRUNCATION_LABEL,
        toolType: 'tool',
        status: 'done',
        detail: TRUNCATION_DETAIL,
    }];
    return JSON.stringify(minimal).length <= MAX_TOOL_LOG_JSON_CHARS ? minimal : [];
}

export function serializeSanitizedToolLog(entries: unknown): string | null {
    const sanitized = sanitizeToolLogForDurableStorage(entries);
    if (sanitized.length === 0) return null;
    const json = JSON.stringify(sanitized);
    if (json.length <= MAX_TOOL_LOG_JSON_CHARS) return json;
    return JSON.stringify(fitToolLogToJsonCap(sanitized));
}

export function parseToolLogBounded(raw?: string | null): SanitizedToolLogEntry[] {
    if (!raw) return [];
    if (raw.length > MAX_TOOL_LOG_RAW_INPUT_CHARS) {
        return [makeOverflowEntry(1)];
    }
    try {
        const parsed = JSON.parse(raw);
        return sanitizeToolLogForDurableStorage(parsed);
    } catch {
        return [];
    }
}

export function sanitizeSerializedToolLog(raw?: string | null): string | null {
    return serializeSanitizedToolLog(parseToolLogBounded(raw));
}
