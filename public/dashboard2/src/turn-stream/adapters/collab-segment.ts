import type {
    CollabTurnSegmentIdentity,
    TurnSegment,
} from '../../../../../src/shared/chat-events.ts';
import type { WorkerProgressRun } from '../../../../../src/orchestrator/worker-progress.ts';

export type CollabIdentity = CollabTurnSegmentIdentity;

export interface CollabItem extends CollabIdentity {
    segment: TurnSegment;
    run: WorkerProgressRun | null;
    verdict: string | null;
}

const TERMINAL_STATES = new Set<WorkerProgressRun['state']>(['done', 'failed', 'cancelled']);

function identityFrom(value: unknown): CollabIdentity | null {
    if (typeof value !== 'string') return null;
    const match = /^collab:([^:]+):([^:]+)$/.exec(value);
    if (!match?.[1] || !match[2]) return null;
    try {
        return { agentId: decodeURIComponent(match[1]), runId: decodeURIComponent(match[2]) };
    } catch {
        return null;
    }
}

export function parseCollabIdentity(segment: TurnSegment): CollabIdentity | null {
    return identityFrom(segment.segmentId) ?? identityFrom(segment.detailRef?.traceRunId);
}

export function extractCollabVerdict(rows: readonly WorkerProgressRun[]): string | null {
    let verdict: string | null = null;
    for (const row of rows) {
        if (!TERMINAL_STATES.has(row.state)) continue;
        const text = row.resultPreview?.trim();
        verdict = text || null;
    }
    return verdict;
}

export function convergeWorkerProgressRun(rows: readonly WorkerProgressRun[]): WorkerProgressRun | null {
    if (rows.length === 0) return null;
    let latest = rows[rows.length - 1]!;
    for (const row of rows) {
        if (TERMINAL_STATES.has(row.state)) latest = row;
    }
    return latest;
}

export function joinCollabSegment(
    segment: TurnSegment,
    workerRows: readonly WorkerProgressRun[],
): CollabItem | null {
    if (segment.type !== 'collab') return null;
    const identity = parseCollabIdentity(segment);
    if (!identity) return null;
    const matching = workerRows.filter(row => row.runId === identity.runId);
    return {
        ...identity,
        segment,
        run: convergeWorkerProgressRun(matching),
        verdict: extractCollabVerdict(matching),
    };
}

export function joinCollabSegments(
    segments: readonly TurnSegment[],
    workerRows: readonly WorkerProgressRun[],
): CollabItem[] {
    const byRun = new Map<string, { identity: CollabIdentity; segment: TurnSegment }>();
    for (const segment of segments) {
        if (segment.type !== 'collab') continue;
        const identity = parseCollabIdentity(segment);
        if (identity) byRun.set(identity.runId, { identity, segment });
    }
    const items: CollabItem[] = [];
    for (const { identity, segment } of byRun.values()) {
        const matching = workerRows.filter(row => row.runId === identity.runId);
        items.push({
            ...identity,
            segment,
            run: convergeWorkerProgressRun(matching),
            verdict: extractCollabVerdict(matching),
        });
    }
    return items;
}
