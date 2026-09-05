import type { ToolEntry } from '../types/agent.js';
import { isToolLogOverflowMarker, type SanitizedToolLogEntry } from '../shared/tool-log-sanitize.js';

function toolIdentity(tool: ToolEntry, fallbackRunId: string): string | undefined {
    // A boss run cannot supply the missing identity of a worker's child run.
    const runId = tool.traceRunId || (tool.isEmployee ? '' : fallbackRunId);
    if (!runId) return undefined;
    if (tool.stepRef) return JSON.stringify([runId, 'ref', tool.stepRef]);
    if (Number.isSafeInteger(tool.traceSeq) && tool.traceSeq! > 0) {
        return JSON.stringify([runId, 'seq', tool.traceSeq]);
    }
    return undefined;
}

const TERMINAL_STATUSES = new Set(['done', 'error', 'failed', 'completed', 'cancelled', 'canceled', 'interrupted', 'stopped']);

function statusRank(tool: ToolEntry): number {
    if (tool.status && TERMINAL_STATUSES.has(tool.status)) return 2;
    return tool.status === 'running' ? 1 : 0;
}

function latestTool(prior: ToolEntry, incoming: ToolEntry, preferIncoming: boolean): ToolEntry {
    const difference = statusRank(incoming) - statusRank(prior);
    const incomingWins = difference > 0 || (difference === 0 && preferIncoming);
    const [winner, other] = incomingWins ? [incoming, prior] : [prior, incoming];
    const detail = winner.detail !== undefined ? winner.detail : other.detail;
    return {
        ...other,
        ...winner,
        // Empty is an explicit clear; missing detail can borrow the other snapshot.
        ...(detail !== undefined ? { detail } : {}),
    };
}

function foldSource(entries: readonly (ToolEntry | SanitizedToolLogEntry)[], fallbackRunId: string): ToolEntry[] {
    const result: ToolEntry[] = [];
    const positions = new Map<string, number>();
    for (const entry of entries) {
        if (isToolLogOverflowMarker(entry)) continue;
        const tool: ToolEntry = { ...entry, toolType: entry.toolType ?? 'tool' };
        const key = toolIdentity(tool, fallbackRunId);
        const position = key === undefined ? undefined : positions.get(key);
        if (position === undefined) {
            if (key !== undefined) positions.set(key, result.length);
            result.push(tool);
        } else {
            result[position] = latestTool(result[position]!, tool, true);
        }
    }
    return result;
}

/** Latest content within each source; primary wins ties across sources. Positions
 * stay primary-first, then mirror-only. Entries without a scoped identity remain
 * distinct: labels and array positions are never used to infer tool ownership.
 * Omission markers are separate from tools: keep one authoritative marker at the
 * head so the consumer's sanitizer can absorb it and account for any new caps. */
export function mergeLatestTools(
    primary: readonly ToolEntry[],
    mirrors: readonly SanitizedToolLogEntry[],
    fallbackRunId: string,
): ToolEntry[] {
    const marker = primary.find(isToolLogOverflowMarker) ?? mirrors.find(isToolLogOverflowMarker);
    const result = foldSource(primary, fallbackRunId);
    const positions = new Map<string, number>();
    result.forEach((tool, position) => {
        const key = toolIdentity(tool, fallbackRunId);
        if (key !== undefined) positions.set(key, position);
    });
    for (const tool of foldSource(mirrors, fallbackRunId)) {
        const key = toolIdentity(tool, fallbackRunId);
        const position = key === undefined ? undefined : positions.get(key);
        if (position === undefined) result.push(tool);
        else result[position] = latestTool(result[position]!, tool, false);
    }
    // Source omission counts may overlap; never invent a sum across snapshots.
    return marker ? [{ ...marker, toolType: marker.toolType ?? 'tool' }, ...result] : result;
}
