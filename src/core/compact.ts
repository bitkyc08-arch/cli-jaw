// ─── Compact Helpers ────────────────────────────────

export const COMPACT_MARKER_CONTENT = 'Conversation compacted.';
export const MANAGED_COMPACT_PREFIX = '[assistant] Managed compact summary:';

type MessageRow = {
    role?: string | null;
    content?: string | null;
    trace?: string | null;
    model?: string | null;
};

function safeText(value: unknown): string {
    return String(value || '').trim();
}

function normalizeSummaryText(text: string): string {
    return text
        .replace(/<\/?tool_call>/g, '')
        .replace(/<\/?tool_result>[\s\S]*?(?:<\/tool_result>|$)/g, '')
        .replace(/\n\n✅[\s\S]*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function clipText(text: string, max = 220): string {
    const normalized = normalizeSummaryText(text);
    if (!normalized) return '';
    return normalized.length > max ? `${normalized.slice(0, max - 1).trim()}…` : normalized;
}

export function isCompactMarkerRow(row: MessageRow | null | undefined): boolean {
    if (!row) return false;
    const role = safeText(row.role);
    const content = safeText(row.content);
    const trace = safeText(row.trace);
    return role === 'assistant'
        && content === COMPACT_MARKER_CONTENT
        && trace.startsWith(MANAGED_COMPACT_PREFIX);
}

export function getRowsSinceLatestCompactForTest(rows: MessageRow[]): MessageRow[] {
    const selected: MessageRow[] = [];
    for (const row of rows || []) {
        if (isCompactMarkerRow(row)) break;
        selected.push(row);
    }
    return selected.reverse();
}

function formatSummaryLine(row: MessageRow): string {
    const role = safeText(row.role) || 'user';
    const primary = role === 'assistant'
        ? safeText(row.content) || safeText(row.trace)
        : safeText(row.content);
    const clipped = clipText(primary);
    if (!clipped) return '';
    return `- [${role}] ${clipped}`;
}

export function buildManagedCompactSummaryForTest(rows: MessageRow[], instructions = ''): string {
    const windowRows = getRowsSinceLatestCompactForTest(rows)
        .filter(row => safeText(row.role) === 'user' || safeText(row.role) === 'assistant')
        .slice(-8);
    const lines = [
        MANAGED_COMPACT_PREFIX,
        `focus instructions: ${safeText(instructions) || 'Preserve the active task, latest decisions, blockers, and next steps.'}`,
        'keep only these facts:',
    ];

    for (const row of windowRows) {
        const line = formatSummaryLine(row);
        if (line) lines.push(line);
    }

    if (lines.length === 3) {
        lines.push('- No recent user/assistant turns were available. Preserve only the latest compact state.');
    }
    lines.push('discard everything else.');
    return lines.join('\n');
}
