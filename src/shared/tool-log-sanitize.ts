export interface SanitizableToolLogEntry {
    icon?: unknown;
    rawIcon?: unknown;
    label?: unknown;
    detail?: unknown;
    toolType?: unknown;
    stepRef?: unknown;
    status?: unknown;
    isEmployee?: unknown;
    traceRunId?: unknown;
    traceSeq?: unknown;
    detailAvailable?: unknown;
    detailBytes?: unknown;
    rawRetentionStatus?: unknown;
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
    isEmployee?: boolean;
    traceRunId?: string;
    traceSeq?: number;
    detailAvailable?: boolean;
    detailBytes?: number;
    rawRetentionStatus?: string;
}

export const MAX_TOOL_LOG_RAW_INPUT_CHARS = 180_000;
export const MAX_TOOL_LOG_ENTRIES = 160;
export const MAX_TOOL_LOG_STRING_CHARS = 240;
export const MAX_TOOL_LOG_DETAIL_CHARS = 3_000;
export const MAX_TOOL_LOG_TOTAL_DETAIL_CHARS = 24_000;
export const MAX_TOOL_LOG_JSON_CHARS = 64_000;

const TRUNCATION_ICON = '⚠️';
const TRUNCATION_LABEL = 'Tool log truncated';
const TRUNCATION_DETAIL = 'Inline preview capped.';
const TRACE_RUN_ID_RE = /^tr_[A-Za-z0-9_-]{16,80}$/;

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

/** Omitted count carried by an overflow marker from a prior sanitize pass; 0 for real entries.
 *  Live-run state re-sanitizes the same array on every append, so the marker must be
 *  absorbable or repeated passes drop every new entry (devlog 260609 doc 86). */
function omittedCountOf(entry: unknown): number {
    if (!entry || typeof entry !== 'object') return 0;
    const e = entry as SanitizableToolLogEntry;
    if (e.icon !== TRUNCATION_ICON) return 0;
    const label = String(e.label ?? '');
    if (label === TRUNCATION_LABEL) return 1;
    const m = /^(\d+) tool events? omitted$/.exec(label);
    return m ? Number(m[1]) : 0;
}

/** True when the entry is a synthetic head overflow marker from a prior sanitize
 *  pass — the live-run snapshot uses it as an "RAM log is capped" signal (WP4,
 *  devlog 260703 doc 12). */
export function isToolLogOverflowMarker(entry: unknown): boolean {
    return omittedCountOf(entry) > 0;
}

function boundedNumber(value: unknown, max: number): number | undefined {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.min(Math.floor(n), max);
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
    const traceRunId = asBoundedString(entry.traceRunId, 96);
    const traceSeq = boundedNumber(entry.traceSeq, Number.MAX_SAFE_INTEGER);
    const detailBytes = boundedNumber(entry.detailBytes, Number.MAX_SAFE_INTEGER);
    const rawRetentionStatus = asBoundedString(entry.rawRetentionStatus, 32);
    if (rawIcon) sanitized.rawIcon = rawIcon;
    if (detail) sanitized.detail = detail;
    if (toolType) sanitized.toolType = toolType;
    if (stepRef) sanitized.stepRef = stepRef;
    if (status) sanitized.status = status;
    if (entry['isEmployee'] === true) sanitized.isEmployee = true;
    if (traceRunId && TRACE_RUN_ID_RE.test(traceRunId)) sanitized.traceRunId = traceRunId;
    if (traceSeq != null && traceSeq > 0) sanitized.traceSeq = traceSeq;
    if (entry.detailAvailable === true) sanitized.detailAvailable = true;
    if (detailBytes != null) sanitized.detailBytes = detailBytes;
    if (rawRetentionStatus) sanitized.rawRetentionStatus = rawRetentionStatus;
    return sanitized;
}

export function sanitizeToolLogForDurableStorage(entries: unknown): SanitizedToolLogEntry[] {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    // Absorb a head overflow marker left by a prior pass so re-sanitizing an
    // append-only live log accumulates the omitted count instead of freezing
    // the list and dropping every new entry (doc 86).
    let source = entries;
    let priorOmitted = omittedCountOf(entries[0]);
    if (priorOmitted > 0) source = entries.slice(1);
    // Cap keeps the NEWEST entries: on navigate-back the user must see the most
    // recent tools, matching what the live SSE stream showed last.
    let dropped = 0;
    if (priorOmitted > 0 || source.length > MAX_TOOL_LOG_ENTRIES) {
        const room = MAX_TOOL_LOG_ENTRIES - 1; // head marker takes one slot
        dropped = Math.max(0, source.length - room);
        if (dropped > 0) source = source.slice(dropped);
    }
    const omittedTotal = priorOmitted + dropped;
    const normalized: SanitizableToolLogEntry[] = source.map((raw) =>
        (raw && typeof raw === 'object') ? raw as SanitizableToolLogEntry : { label: raw });
    // Allocate the shared detail budget NEWEST-first: the entry cap above keeps the
    // newest entries because those are what the user inspects on navigate-back, and
    // front-to-back allocation let old entries exhaust the 24K pool and blank the
    // newest details in detail-heavy runs (doc 86 §7).
    const budgets = new Array<number>(normalized.length).fill(0);
    let detailBudgetLeft = MAX_TOOL_LOG_TOTAL_DETAIL_CHARS;
    for (let i = normalized.length - 1; i >= 0; i--) {
        const detail = normalized[i]!.detail;
        const detailRawLength = detail == null ? 0 : String(detail).length;
        const detailBudget = Math.min(MAX_TOOL_LOG_DETAIL_CHARS, detailBudgetLeft);
        budgets[i] = detailBudget;
        detailBudgetLeft = Math.max(0, detailBudgetLeft - Math.min(detailRawLength, detailBudget));
    }
    const output = normalized.map((entry, i) => sanitizeToolLogEntry(entry, budgets[i]!));
    if (omittedTotal > 0) output.unshift(makeOverflowEntry(omittedTotal));
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
    const traceRunId = asBoundedString(entry.traceRunId, 96);
    const traceSeq = boundedNumber(entry.traceSeq, Number.MAX_SAFE_INTEGER);
    const detailBytes = boundedNumber(entry.detailBytes, Number.MAX_SAFE_INTEGER);
    const rawRetentionStatus = asBoundedString(entry.rawRetentionStatus, 32);
    if (toolType) shrunk.toolType = toolType;
    if (stepRef) shrunk.stepRef = stepRef;
    if (status) shrunk.status = status;
    if (detail) shrunk.detail = detail;
    if (entry.isEmployee === true) shrunk.isEmployee = true;
    if (traceRunId && TRACE_RUN_ID_RE.test(traceRunId)) shrunk.traceRunId = traceRunId;
    if (traceSeq != null && traceSeq > 0) shrunk.traceSeq = traceSeq;
    if (entry.detailAvailable === true) shrunk.detailAvailable = true;
    if (detailBytes != null) shrunk.detailBytes = detailBytes;
    if (rawRetentionStatus) shrunk.rawRetentionStatus = rawRetentionStatus;
    return shrunk;
}

function fitToolLogToJsonCap(entries: SanitizedToolLogEntry[]): SanitizedToolLogEntry[] {
    // Shrinking is a last resort for oversized logs only — entries within the
    // JSON cap keep their full per-entry detail budget (doc 86: the previous
    // unconditional shrink abbreviated every persisted entry to 180 chars).
    if (JSON.stringify(entries).length <= MAX_TOOL_LOG_JSON_CHARS) return entries;
    let fitted = entries.map(shrinkEntryForJson);
    let json = JSON.stringify(fitted);
    while (json.length > MAX_TOOL_LOG_JSON_CHARS && fitted.length > 1) {
        // Drop the OLDEST real entry and fold it into the head marker so the
        // newest tools survive, mirroring the entry-cap semantics above.
        const priorOmitted = omittedCountOf(fitted[0]);
        fitted.splice(priorOmitted > 0 ? 1 : 0, 1);
        const marker = makeOverflowEntry(priorOmitted + 1);
        if (priorOmitted > 0) fitted[0] = marker;
        else fitted.unshift(marker);
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
