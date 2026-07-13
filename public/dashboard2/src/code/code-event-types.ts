// 060 — Code ('jwc' topic) wire schema + runtime guards. This module owns the
// boundary between the SSE/replay wire and the code-source-adapter: it narrows
// the `update['sessionUpdate']` discriminant, admits the three envelope classes
// (session update / lifecycle / permission), and preserves unknown fields.
// Policy: malformed or unknown input NEVER throws — callers count + ignore.
import type { JwcSsePayload } from '../providers/sync-provider.tsx';

export type { JwcSsePayload } from '../providers/sync-provider.tsx';

/** ACP session/update body — open union: unknown kinds/fields are preserved */
export interface AcpSessionUpdate {
    sessionUpdate: string;
    content?: unknown;
    messageId?: string;
    toolCallId?: string;
    id?: string;
    name?: string;
    title?: string;
    kind?: string;
    status?: string;
    input?: unknown;
    rawInput?: unknown;
    reason?: unknown;
    [key: string]: unknown;
}

/** `code_*` event that carries an ACP session update */
export interface JwcSessionUpdateEvent {
    class: 'session_update';
    event: `code_${string}`;
    sessionId: string;
    update: AcpSessionUpdate;
    sseReplay: boolean;
    sseEventId: string | null;
}

/** lifecycle `code_*` event without an update body (turn done/error/exit...) */
export interface JwcLifecycleEvent {
    class: 'lifecycle';
    event: `code_${string}`;
    sessionId: string | null;
    stopReason: string | null;
    reason: unknown;
    sseReplay: boolean;
    sseEventId: string | null;
    raw: Record<string, unknown>;
}

/** permission request — top-level id/options, NOT an update envelope */
export interface JwcPermissionEvent {
    class: 'permission';
    event: `code_${string}`;
    sessionId: string | null;
    requestId: string | null;
    options: unknown;
    toolCall: unknown;
    raw: Record<string, unknown>;
}

export type JwcCodeEvent = JwcSessionUpdateEvent | JwcLifecycleEvent | JwcPermissionEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value ? value : null;
}

const PERMISSION_EVENTS = new Set(['code_permission_request', 'code_request_permission']);

/**
 * Classify one `'jwc'` topic payload from the shared SSE transport.
 * Returns null for payloads that are not usable `code_*` events; the caller
 * counts them as unknown telemetry and keeps running.
 */
export function classifyJwcPayload(payload: unknown): JwcCodeEvent | null {
    if (!isRecord(payload)) return null;
    const event = payload['event'];
    if (typeof event !== 'string' || !event.startsWith('code_')) return null;
    const typedEvent = event as `code_${string}`;
    const sessionId = stringOrNull(payload['sessionId']);
    const sseReplay = payload['sseReplay'] === true;
    const sseEventId = stringOrNull(payload['sseEventId']);

    if (PERMISSION_EVENTS.has(event)) {
        return {
            class: 'permission',
            event: typedEvent,
            sessionId,
            requestId: stringOrNull(payload['id']) ?? stringOrNull(payload['requestId']),
            options: payload['options'] ?? null,
            toolCall: payload['toolCall'] ?? null,
            raw: payload,
        };
    }

    const update = payload['update'];
    if (isRecord(update) && typeof update['sessionUpdate'] === 'string' && update['sessionUpdate']) {
        if (!sessionId) return null;
        return {
            class: 'session_update',
            event: typedEvent,
            sessionId,
            update: update as AcpSessionUpdate,
            sseReplay,
            sseEventId,
        };
    }

    // update-less lifecycle events (turn done/error/cancel/child exit ...)
    return {
        class: 'lifecycle',
        event: typedEvent,
        sessionId,
        stopReason: stringOrNull(payload['stopReason']),
        reason: payload['reason'] ?? null,
        sseReplay,
        sseEventId,
        raw: payload,
    };
}

/**
 * Normalize one stored replay record (CodeSessionInfo.replayEvents) into the
 * same classified shape as live SSE payloads. Replay records carry only
 * {event, sessionId?, update?...} — no topic/sseEventId (061 doc §1) — so the
 * classifier runs on the record with replay marked explicitly.
 */
export function classifyReplayRecord(record: unknown, sessionId: string): JwcCodeEvent | null {
    if (!isRecord(record)) return null;
    return classifyJwcPayload({
        sessionId,
        ...record,
        sseReplay: true,
        sseEventId: null,
    });
}

/** text extraction for message/thought chunk content (ACP content block) */
export function chunkText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (isRecord(content)) {
        if (typeof content['text'] === 'string') return content['text'];
        if (Array.isArray(content)) return '';
    }
    if (Array.isArray(content)) {
        return content.map(part => chunkText(part)).join('');
    }
    return '';
}
