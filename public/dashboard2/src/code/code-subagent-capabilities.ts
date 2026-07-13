// 061 D16 — jwc subagent exposure is v1 READ-ONLY (observation only).
// The only observable contract today is the task tool_call / tool_call_update
// lifecycle (src/agent/events/acp.ts:43-104,153-215). No pause/resume method
// name, target identity, or idempotency contract has been measured on the
// installed jwc, so this module deliberately exports ZERO control methods —
// no REST call, no ACP extMethod, no optimistic state. Control exposure
// requires a phase amendment with a captured capability contract first.
import type { TurnSegment } from '../../../../src/shared/chat-events.ts';

export const CODE_SUBAGENT_CONTROL_LEVEL = 'read-only' as const;

export interface SubagentObservation {
    label: string;
    toolCallId: string;
    status: 'running' | 'done' | 'error';
}

/** Projects a collab segment row into the read-only observation model. */
export function describeSubagentObservation(row: TurnSegment): SubagentObservation | null {
    if (row.type !== 'collab') return null;
    const parts = row.segmentId.split(':');
    if (parts.length < 3 || parts[0] !== 'collab') return null;
    let label: string;
    let toolCallId: string;
    try {
        label = decodeURIComponent(parts[1] ?? '');
        toolCallId = decodeURIComponent(parts.slice(2).join(':'));
    } catch {
        return null;
    }
    if (!label || !toolCallId) return null;
    return {
        label,
        toolCallId,
        status: row.status === 'running' ? 'running' : row.status === 'error' ? 'error' : 'done',
    };
}
