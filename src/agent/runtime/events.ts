import type { RuntimeEvent, RuntimeEventBody, RuntimeEventIdentity } from '../../shared/runtime-contract.js';
import { appendTraceEvent } from '../../trace/store.js';
import { publish } from '../../core/event-bus.js';
import { stringifyTraceValue } from '../../trace/redact.js';
import { encodeRuntimeBody, decodeRuntimeBody, RUNTIME_BODY_BYTES } from '../../trace/runtime-body-codec.js';

export interface RuntimeEventContext {
    runId: string;
    sessionId: string;
    scope: string;
    turnId: string;
    parentItemId?: string;
    audience: 'public' | 'internal';
}
export function recordRuntimeEvent(context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null {
    try {
        const identity: RuntimeEventIdentity = {
            version: 1, runId: context.runId, sessionId: context.sessionId,
            scope: context.scope, turnId: context.turnId, seq: 1,
            ...(context.parentItemId === undefined ? {} : { parentItemId: context.parentItemId }),
        };
        const encoded = encodeRuntimeBody(identity, body);
        const serialized = stringifyTraceValue(encoded.raw);
        if (Buffer.byteLength(serialized, 'utf8') > RUNTIME_BODY_BYTES) return null;
        const raw: unknown = JSON.parse(serialized);
        // Validate what will actually be stored before consuming a trace seq.
        if (!decodeRuntimeBody(raw, identity, body.kind)) return null;
        const pointer = appendTraceEvent({ runId: context.runId, source: 'runtime',
            eventType: body.kind, raw, preview: body.kind });
        if (!pointer) return null;
        const event = decodeRuntimeBody(raw, { ...identity, seq: pointer.traceSeq }, body.kind);
        if (!event) return null;
        if (context.audience === 'public') publish('agent', 'agent_runtime', { ...event });
        return event;
    } catch {
        console.warn('[runtime] projection_record_failed');
        return null;
    }
}
