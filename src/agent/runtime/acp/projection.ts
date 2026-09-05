import type { RuntimeItemStatus } from '../../../shared/runtime-contract.js';
import { FULLTEXT_MAX_CHARS } from '../../events/fulltext-bound.js';
import { RuntimeProjection } from '../projection.js';
import { acpRecord } from './session.js';
import { acpSnapshot, acpText } from './content.js';

const TOOL_LIMIT = 4096;
const NATIVE_ID_CHARS = 1024;
const UNSUPPORTED_CONTENT = '[unsupported ACP content]';
type Segment = { ref: string; nativeId: string | null; text: string };

function nativeId(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > NATIVE_ID_CHARS) throw new Error('acp_invalid_id');
    return value;
}
function title(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error('acp_invalid_content');
    if (value.length > FULLTEXT_MAX_CHARS) throw new Error('acp_content_limit');
    return value;
}
function toolStatus(value: unknown, prior?: RuntimeItemStatus): RuntimeItemStatus {
    if (value === undefined || value === null) return prior ?? 'running';
    switch (value) {
        case 'pending': case 'in_progress': return 'running';
        case 'completed': return 'done';
        case 'failed': return 'error';
        default: throw new Error('acp_invalid_tool_status');
    }
}
function exitDetail(raw: unknown): string | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const code = acpRecord(raw)['exit_code'];
    return typeof code === 'number' && Number.isSafeInteger(code) && code !== 0 ? `Exit code: ${code}` : undefined;
}

/** ACP protocol state only. Generic projection owns public IDs, privacy and preview budgets. */
export class AcpProjection {
    private readonly tools = new Map<string, RuntimeItemStatus>();
    private active: Segment | null = null;
    private thoughtRef: string | null = null;
    private partial = '';
    private nextSegment = 0;
    private toolEpoch = 0;
    private stopped = false;

    constructor(private readonly projection: RuntimeProjection) {}
    get partialText(): string { return this.partial; }

    update(params: unknown, nativeSessionId: string): void {
        const frame = acpRecord(params);
        if (!nativeSessionId || frame['sessionId'] !== nativeSessionId) throw new Error('acp_wrong_session');
        const update = acpRecord(frame['update']), kind = update['sessionUpdate'];
        if (typeof kind !== 'string' || !kind) throw new Error('acp_invalid_update');
        switch (kind) {
            case 'agent_message_chunk': this.message(update); break;
            case 'agent_thought_chunk': this.thought(update); break;
            case 'tool_call': case 'tool_call_update': this.tool(update, kind); break;
            case 'user_message_chunk': this.closeSegment(); break;
            default: break; // Config/plan/future metadata is not an assistant answer or terminal.
        }
    }

    private closeSegment(): void { this.active = null; this.thoughtRef = null; }

    private message(update: Record<string, unknown>): void {
        const id = update['messageId'] === undefined || update['messageId'] === null ? null : nativeId(update['messageId']);
        if (update['content'] === undefined || update['content'] === null) throw new Error('acp_invalid_content');
        const content = acpText(update['content']);
        // Check the cumulative raw bound before changing either answer accumulator.
        if (content.text !== null && this.partial.length + content.text.length > FULLTEXT_MAX_CHARS) throw new Error('acp_text_limit');
        this.stopped = false;
        this.thoughtRef = null;
        if (this.active && this.active.nativeId !== id) this.active = null;
        if (content.unsupported) {
            this.active = null;
            this.projection.text('message', 'unsupported-' + (++this.nextSegment), UNSUPPORTED_CONTENT, 'replace');
        }
        if (content.text === null) return;
        // A missing discriminator cannot separate consecutive anonymous same-type messages.
        if (!this.active || this.active.nativeId !== id) {
            this.active = { ref: 'message-' + (++this.nextSegment), nativeId: id, text: '' };
        }
        this.partial += content.text;
        this.active.text += content.text;
        this.projection.text('message', this.active.ref, content.text, 'append', 'unknown');
    }

    private thought(update: Record<string, unknown>): void {
        if (update['content'] === undefined || update['content'] === null) throw new Error('acp_invalid_content');
        const content = acpText(update['content']);
        this.stopped = false;
        this.active = null;
        if (!this.thoughtRef) this.thoughtRef = 'thought-' + (++this.nextSegment);
        if (content.text !== null) this.projection.text('reasoning', this.thoughtRef, content.text, 'append');
        if (content.unsupported) this.projection.text('reasoning', this.thoughtRef, UNSUPPORTED_CONTENT, 'append');
    }

    private tool(update: Record<string, unknown>, kind: string): void {
        const id = nativeId(update['toolCallId']), prior = this.tools.get(id);
        // A retired tool's replay is metadata, not a boundary for a newer answer.
        if (prior !== undefined && prior !== 'running') return;
        if (prior === undefined && this.tools.size >= TOOL_LIMIT) throw new Error('acp_tool_limit');
        const status = toolStatus(update['status'], prior), name = title(update['title']);
        const content = acpText(update['content']);
        const rawInput = update['rawInput'], rawOutput = update['rawOutput'];
        const input = rawInput === undefined || rawInput === null ? undefined : acpSnapshot(rawInput);
        const hasRawOutput = rawOutput !== undefined && rawOutput !== null;
        const output = hasRawOutput ? acpSnapshot(rawOutput) : content.text ?? undefined;
        const details = [kind === 'tool_call_update' ? name : undefined,
            content.unsupported ? UNSUPPORTED_CONTENT : undefined, exitDetail(rawOutput)].filter(value => value !== undefined && value !== '');
        this.closeSegment();
        this.stopped = false;
        this.tools.set(id, status);
        this.projection.tool(this.toolRef(id), { status,
            ...(name === undefined ? {} : { name }),
            ...(input === undefined ? {} : { input, inputStructured: true }),
            ...(output === undefined ? {} : { output, outputStructured: hasRawOutput && typeof rawOutput !== 'string' }),
            ...(details.length ? { detail: details.join('\n') } : {}),
        });
    }

    private toolRef(id: string): string { return JSON.stringify([this.toolEpoch, id]); }

    finalText(result: Record<string, unknown>): string | null {
        if (result['stopReason'] !== 'end_turn' || !this.active) return null;
        this.projection.text('message', this.active.ref, this.active.text, 'replace', 'final');
        return this.active.text; // Raw authoritative value, including empty, independent of recording.
    }

    /** Caller invokes this after the old attempt's terminal/drain fence, never on cancel dispatch. */
    stopTools(): void {
        this.closeSegment();
        if (this.stopped) return;
        for (const [id, status] of this.tools) {
            if (status === 'running') this.projection.tool(this.toolRef(id), { status: 'stopped' });
        }
        this.tools.clear();
        this.toolEpoch++;
        this.stopped = true;
    }
}
