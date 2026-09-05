import type { ToolEventInput } from './transcript.js';
import type { RuntimeEvent } from '../../shared/runtime-contract.js';
import { parseRuntimeEvent } from '../../shared/runtime-event-parse.js';

export type ToolStatus = 'running' | 'done' | 'error';

export type TuiEvent =
    | { kind: 'runtime'; event: RuntimeEvent }
    | { kind: 'runtime-invalid'; raw: Record<string, unknown> }
    | { kind: 'runtime-gap'; runId: string; sessionId: string; scope: string }
    | { kind: 'assistant-output'; text: string; agentId?: string | undefined; thinking: boolean }
    | { kind: 'agent-done'; text: string; agentId?: string | undefined; toolLog: ToolEventInput[]; raw: Record<string, unknown> }
    | { kind: 'agent-status'; status: string; agentId?: string | undefined; agentName?: string | undefined }
    | { kind: 'agent-tool'; icon: string; label: string; detail: string; status: ToolStatus; stepRef?: string | undefined; agentId?: string | undefined; toolType?: string | undefined }
    | { kind: 'agent-fallback'; from: string; to: string }
    | { kind: 'bgtask-update'; raw: Record<string, unknown> }
    | { kind: 'queue-update'; pending: number; raw: Record<string, unknown> }
    | { kind: 'external-message'; source: string; content: string }
    | { kind: 'session-reset' }
    | { kind: 'worker-warning'; type: string; agentId?: string | undefined }
    | { kind: 'raw'; raw: Record<string, unknown> }
    | { kind: 'ignore'; raw: Record<string, unknown> };

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function optString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function normalizeToolStatus(value: unknown): ToolStatus {
    if (value === 'done' || value === 'error') return value;
    return 'running';
}

function normalizeToolLog(value: unknown): ToolEventInput[] {
    if (!Array.isArray(value)) return [];
    const out: ToolEventInput[] = [];
    for (const entry of value.slice(0, 100)) {
        const record = asRecord(entry);
        if (!record) continue;
        const rawToolType = optString(record['toolType']) ?? optString(record['tool_type']);
        const thinkingTool = rawToolType?.toLowerCase() === 'thinking' || record['thinking'] === true;
        const label = optString(record['label']) ?? optString(record['tool']) ?? optString(record['name']) ?? (thinkingTool ? 'Thinking' : undefined);
        if (!label) continue;
        const tool: ToolEventInput = {
            icon: optString(record['icon']) ?? '•',
            label,
            detail: stringValue(record['detail']) || stringValue(record['output']) || stringValue(record['text']) || stringValue(record['content']) || stringValue(record['message']),
            status: normalizeToolStatus(record['status']),
        };
        const agentId = optString(record['agentId']);
        const stepRef = optString(record['stepRef']) ?? optString(record['id']);
        if (agentId) tool.agentId = agentId;
        if (stepRef) tool.stepRef = stepRef;
        if (rawToolType) tool.toolType = rawToolType;
        else if (thinkingTool) tool.toolType = 'thinking';
        out.push(tool);
    }
    return out;
}

function numberValue(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function normalizeTuiWsEvent(raw: unknown): TuiEvent {
    const msg = asRecord(raw) ?? {};
    const type = stringValue(msg['type']);
    switch (type) {
        case 'agent_runtime': {
            const event = parseRuntimeEvent(msg);
            return event ? { kind: 'runtime', event } : { kind: 'runtime-invalid', raw: msg };
        }
        case 'agent_runtime_gap': {
            const runId = optString(msg['runId']);
            const sessionId = optString(msg['sessionId']);
            const scope = optString(msg['scope']);
            // Gaps are notices, not committed RuntimeEvents: they have no seq/turnId.
            if (!runId || !sessionId || !scope || runId.length > 240 || sessionId.length > 240
                || scope.length > 240 || msg['reason'] !== 'projection_degraded') return { kind: 'ignore', raw: msg };
            return { kind: 'runtime-gap', runId, sessionId, scope };
        }
        case 'agent_chunk':
        case 'agent_output':
            return {
                kind: 'assistant-output',
                text: stringValue(msg['text']),
                thinking: msg['thinking'] === true,
                ...(optString(msg['agentId']) ? { agentId: optString(msg['agentId']) } : {}),
            };
        case 'agent_done':
            return {
                kind: 'agent-done',
                text: stringValue(msg['text']),
                toolLog: normalizeToolLog(msg['toolLog']),
                raw: msg,
                ...(optString(msg['agentId']) ? { agentId: optString(msg['agentId']) } : {}),
            };
        case 'agent_status':
            return {
                kind: 'agent-status',
                status: stringValue(msg['status']),
                ...(optString(msg['agentId']) ? { agentId: optString(msg['agentId']) } : {}),
                ...(optString(msg['agentName']) ? { agentName: optString(msg['agentName']) } : {}),
            };
        case 'agent_tool': {
            const icon = optString(msg['icon']);
            const label = optString(msg['label']);
            if (!icon || !label) return { kind: 'ignore', raw: msg };
            const toolType = optString(msg['toolType']) ?? optString(msg['tool_type']) ?? (msg['thinking'] === true ? 'thinking' : undefined);
            return {
                kind: 'agent-tool',
                icon,
                label,
                detail: stringValue(msg['detail']),
                status: normalizeToolStatus(msg['status']),
                ...(optString(msg['stepRef']) ? { stepRef: optString(msg['stepRef']) } : {}),
                ...(optString(msg['agentId']) ? { agentId: optString(msg['agentId']) } : {}),
                ...(toolType ? { toolType } : {}),
            };
        }
        case 'agent_fallback':
            return {
                kind: 'agent-fallback',
                from: stringValue(msg['from']),
                to: stringValue(msg['to']),
            };
        case 'bgtask_update':
            return { kind: 'bgtask-update', raw: msg };
        case 'queue_update':
            return { kind: 'queue-update', pending: numberValue(msg['pending']), raw: msg };
        case 'new_message':
            return {
                kind: 'external-message',
                source: stringValue(msg['source']),
                content: stringValue(msg['content']),
            };
        case 'session_reset':
        case 'clear':
            return { kind: 'session-reset' };
        case 'worker_stalled':
        case 'worker_timeout':
        case 'worker_disconnected':
            return {
                kind: 'worker-warning',
                type,
                ...(optString(msg['agentId']) ? { agentId: optString(msg['agentId']) } : {}),
            };
        default:
            return type ? { kind: 'raw', raw: msg } : { kind: 'ignore', raw: msg };
    }
}
