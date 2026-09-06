import type { PiRuntimeEvent } from '../pi-runtime.js';
import { RuntimeProjection } from './projection.js';

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';

export type PiActivityRecord =
    | { kind: 'message-start' }
    | { kind: 'content'; index: number }
    | { kind: 'tool'; nativeId: string; stage: 'start' | 'update' | 'end';
        name: string; input?: string; output?: string; failed: boolean };

function resultText(value: unknown): string {
    if (typeof value === 'string') return value;
    const record = obj(value);
    const content = record['content'];
    if (!Array.isArray(content)) return str(record['text']);
    return content.map(entry => {
        const part = obj(entry);
        return part['type'] === 'text' ? str(part['text']) : '';
    }).filter(Boolean).join('\n');
}

export function parsePiActivityRecord(value: unknown): PiActivityRecord | null {
    const record = obj(value);
    const type = str(record['type']);
    if (type === 'message_start' && obj(record['message'])['role'] === 'assistant') {
        return { kind: 'message-start' };
    }
    if (type === 'message_update') {
        const event = obj(record['assistantMessageEvent']);
        const index = event['contentIndex'];
        if (Number.isSafeInteger(index) && Number(index) >= 0) return { kind: 'content', index: Number(index) };
        return null;
    }
    const stage = type === 'tool_execution_start' ? 'start'
        : type === 'tool_execution_update' ? 'update'
        : type === 'tool_execution_end' ? 'end' : null;
    if (!stage) return null;
    // Top-level id is RPC correlation, not a tool identity.
    const nativeId = str(record['toolCallId']) || str(record['tool_call_id'])
        || str(record['callId']) || str(obj(record['call'])['id']);
    const args = record['args'];
    const output = stage === 'update' ? record['partialResult'] : record['result'];
    return { kind: 'tool', nativeId, stage,
        name: str(record['toolName']) || str(record['name']) || str(record['tool_name']) || 'Pi tool',
        ...(args !== undefined ? { input: typeof args === 'string' ? args : JSON.stringify(args) ?? '' } : {}),
        ...(output !== undefined ? { output: resultText(output) } : {}),
        failed: record['isError'] === true || obj(output)['isError'] === true,
    };
}

export class PiProjection {
    private message = 0;
    private contentIndex = 0;
    private orphan = 0;

    constructor(private readonly projection: RuntimeProjection) {}

    observeRecord(raw: unknown): void {
        try {
            const activity = parsePiActivityRecord(raw);
            if (!activity) return;
            if (activity.kind === 'message-start') {
                this.message++;
                this.contentIndex = 0;
                return;
            }
            if (activity.kind === 'content') {
                this.contentIndex = activity.index;
                return;
            }
            if (!activity.nativeId) this.projection.report('missing-id');
            const ref = activity.nativeId ? 'native:' + activity.nativeId : 'orphan:' + (++this.orphan);
            this.projection.tool(ref, {
                name: activity.name,
                status: activity.stage === 'end' ? activity.failed ? 'error' : 'done' : 'running',
                ...(activity.input !== undefined ? { input: activity.input, inputStructured: true } : {}),
                ...(activity.output !== undefined ? { output: activity.output } : {}),
            });
        } catch { this.projection.report('malformed'); }
    }

    observe(event: PiRuntimeEvent): void {
        try {
            // Only callbacks accepted by the legacy stream/agent_end gate enter.
            if (event.kind === 'text') {
                this.projection.text('message', 'message:' + this.message, event.text, 'append', 'unknown');
            } else if (event.kind === 'thinking') {
                this.projection.text('reasoning', 'reasoning:' + this.message + ':' + this.contentIndex, event.text, 'append');
            }
            // tool was observed from raw; session stays with ctx/session owner.
        } catch { this.projection.report('malformed'); }
    }
}
