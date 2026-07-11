// 041 — D21 hydration: assemble message content/tool_log (body owners) with
// body-less TurnSegment metadata rows, and normalize legacy body-channel SSE
// payloads into reducer actions. Pure module — no window/react/fetch; the
// transport (EventSource, generation guard) stays in the 032 sync-provider.
import type {
    AgentDoneSsePayload,
    AgentOutputSsePayload,
    AgentToolSsePayload,
    SegmentedMessageItem,
    TurnSegment,
} from '../../../../src/shared/chat-events.ts';
import type { HydratedTurnBody, TurnStreamAction } from './types.ts';

export interface HydrationResult {
    /** durable metadata rows carried by the history page, page order */
    rows: TurnSegment[];
    /** authoritative completed bodies keyed by turnId (provenance: message) */
    bodies: Record<string, HydratedTurnBody>;
}

/**
 * History pages own persisted `content`/`tool_log` plus ordered
 * `turn_segments`. Persisted message bodies are AUTHORITATIVE for their turn:
 * a stale live body must never overwrite a history snapshot (041 §6).
 */
export function hydrateFromMessages(messages: readonly SegmentedMessageItem[]): HydrationResult {
    const rows: TurnSegment[] = [];
    const bodies: Record<string, HydratedTurnBody> = {};
    for (const message of messages) {
        for (const segment of message.turn_segments) rows.push(segment);
        if (message.role !== 'assistant' || !message.turn_id) continue;
        bodies[message.turn_id] = {
            text: message.content,
            toolLog: message.tool_log,
            provenance: 'message',
            traceRunId: message.trace_run_id,
        };
    }
    return { rows, bodies };
}

/**
 * Merge precedence: message > live. A live body may only fill a turn that has
 * no message-provenance body yet; it never replaces one.
 */
export function mergeBody(
    existing: HydratedTurnBody | undefined,
    incoming: HydratedTurnBody,
): HydratedTurnBody {
    if (!existing) return incoming;
    if (existing.provenance === 'message' && incoming.provenance !== 'message') return existing;
    return incoming;
}

// ─── Legacy body-channel ingress (041 §2.1) ─────────────────────────
// These channels own bodies only; turn order/status/fidelity stay with the
// lifecycle channel. Normalizers convert payloads to reducer actions without
// widening the lifecycle DTO into the legacy ChatSsePayload union.

export function normalizeAgentOutput(payload: AgentOutputSsePayload): TurnStreamAction {
    return {
        kind: 'body_chunk',
        traceRunId: typeof payload.traceRunId === 'string' && payload.traceRunId ? payload.traceRunId : null,
        text: payload.text ?? '',
        textLen: typeof payload.textLen === 'number' ? payload.textLen : undefined,
        sseReplay: payload.sseReplay === true,
        isEmployee: payload.isEmployee === true,
    };
}

export function normalizeAgentTool(payload: AgentToolSsePayload): TurnStreamAction {
    return {
        kind: 'tool_event',
        traceRunId: typeof payload.traceRunId === 'string' && payload.traceRunId ? payload.traceRunId : null,
        traceSeq: typeof payload.traceSeq === 'number' ? payload.traceSeq : null,
        sseReplay: payload.sseReplay === true,
        isEmployee: payload.isEmployee === true,
    };
}

export function normalizeAgentDone(payload: AgentDoneSsePayload): TurnStreamAction {
    return {
        kind: 'agent_done',
        traceRunId: typeof payload.traceRunId === 'string' && payload.traceRunId ? payload.traceRunId : null,
        text: payload.text ?? '',
        steered: payload.steered === true,
    };
}
