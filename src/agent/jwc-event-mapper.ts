// AgentSessionEvent → cli-jaw bus mapping (110.4 fixed table).
// Reuses the EXISTING agent_* bus events so the Web UI renders jwc turns with
// zero UI change (D112-1). Keep this 1:1 with jawcode devlog 110.4 — changing
// the wire here without updating that doc is a drift.
//
// jwc event shapes (structural, mirrors jawcode AgentSessionEvent / AgentEvent /
// AssistantMessageEvent) — no hard import so this compiles before jwc is linked.

import { broadcast } from '../core/bus.js';
import { publish } from '../core/event-bus.js';
import { appendLiveRunText, appendLiveRunTool, getLiveRun } from './live-run-state.js';

interface AssistantMessageEvent {
    type: string;
    delta?: string;
    content?: unknown;
}
export interface JwcAgentEvent {
    type: string;
    // message_update
    assistantMessageEvent?: AssistantMessageEvent;
    // tool_execution_*
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
    // agent_end
    stopReason?: string;
    messages?: unknown;
    // notice
    level?: 'info' | 'warning' | 'error';
    message?: unknown;
    source?: string;
}

export interface JwcEventContext {
    /** cwd doubles as the session key for the resident main slot. */
    cwd: string;
    sessionId: string;
    agentId?: string;
    /** Live-run scope to accumulate text/tools into, so the spawn branch can
     *  persist the final assistant message + tool log after the turn (110.4 §3). */
    liveScope?: string | undefined;
    /** Turn start (ms) — rides on agent_tool broadcasts so the web UI elapsed timer
     *  has an authoritative origin instead of client arrival time (WP4b). */
    runStartedAt?: number | undefined;
}

function toolLabel(name: string | undefined, args: unknown): { label: string; detail: string } {
    const label = name ?? 'tool';
    let detail = '';
    if (args && typeof args === 'object') {
        const a = args as Record<string, unknown>;
        detail = String(a['path'] ?? a['command'] ?? a['query'] ?? a['pattern'] ?? '').slice(0, 120);
    }
    return { label, detail };
}

function extractTextOnly(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(extractTextOnly).join('');
    if (!value || typeof value !== 'object') return '';
    const obj = value as Record<string, unknown>;
    if (obj['type'] === 'thinking') return '';
    return extractTextOnly(obj['text'])
        || extractTextOnly(obj['delta'])
        || extractTextOnly(obj['content'])
        || extractTextOnly(obj['message'])
        || '';
}

function extractAssistantMessagesText(value: unknown): string {
    if (!Array.isArray(value)) return extractTextOnly(value);
    return value
        .filter((entry) => !!entry && typeof entry === 'object' && (entry as Record<string, unknown>)['role'] === 'assistant')
        .map(extractTextOnly)
        .join('');
}

function missingFinalSuffix(existing: string, finalText: string): string {
    if (!finalText) return '';
    if (!existing) return finalText;
    if (finalText.startsWith(existing)) return finalText.slice(existing.length);
    if (existing.includes(finalText)) return '';
    return finalText;
}

/** Map a single engine event onto the bus. Public lane unless noted (113.2 §5). */
export function mapAgentEventToBus(event: JwcAgentEvent, ctx: JwcEventContext): void {
    const agentId = ctx.agentId ?? 'jwc-main';
    const base = { agentId, cli: 'jwc' as const, sessionId: ctx.sessionId };

    switch (event.type) {
        case 'agent_start':
        case 'turn_start':
            broadcast('agent_status', { running: true, ...base });
            break;

        case 'message_update': {
            const ame = event.assistantMessageEvent;
            if (!ame) break;
            if (ame.type === 'text_delta' && ame.delta) {
                const textLen = ctx.liveScope ? appendLiveRunText(ctx.liveScope, ame.delta) : null;
                broadcast('agent_output', { ...base, text: ame.delta, ...(textLen !== null ? { textLen } : {}) });
            } else if (ame.type === 'thinking_delta' && ame.delta) {
                // thinking on the public lane but flagged so the UI interleaves it (083.3 parity)
                broadcast('agent_output', { ...base, text: ame.delta, thinking: true });
            }
            // toolcall_* deltas fold into tool_execution_* below — no double emit.
            break;
        }

        case 'tool_execution_start': {
            const { label, detail } = toolLabel(event.toolName, event.args);
            broadcast('agent_tool', { ...base, stepRef: event.toolCallId, label, detail, status: 'running', toolType: event.toolName, startedAt: ctx.runStartedAt });
            break;
        }
        case 'tool_execution_update': {
            const { label, detail } = toolLabel(event.toolName, event.args);
            broadcast('agent_tool', { ...base, stepRef: event.toolCallId, label, detail, status: 'running', toolType: event.toolName, startedAt: ctx.runStartedAt });
            break;
        }
        case 'tool_execution_end': {
            // tool_execution_end carries { toolCallId, toolName, result, isError } — no `args`.
            // Detail was already set on start; end only flips status.
            const label = event.toolName ?? 'tool';
            const status = event.isError ? 'error' : 'done';
            if (ctx.liveScope) {
                appendLiveRunTool(ctx.liveScope, { icon: 'tool', label, status, toolType: event.toolName });
            }
            broadcast('agent_tool', { ...base, stepRef: event.toolCallId, label, status, toolType: event.toolName, startedAt: ctx.runStartedAt });
            break;
        }

        case 'agent_end':
            {
                const finalText = extractAssistantMessagesText(event.messages);
                const existingText = ctx.liveScope ? getLiveRun(ctx.liveScope).text : '';
                const suffix = missingFinalSuffix(existingText, finalText);
                if (suffix) {
                    const textLen = ctx.liveScope ? appendLiveRunText(ctx.liveScope, suffix) : null;
                    broadcast('agent_output', { ...base, text: suffix, ...(textLen !== null ? { textLen } : {}) });
                }
                broadcast('agent_done', { ...base, stopReason: event.stopReason ?? 'completed', ...(finalText ? { text: finalText } : {}) });
            }
            broadcast('agent_status', { running: false, ...base });
            break;

        case 'notice': {
            const text = typeof event.message === 'string' ? event.message : String(event.message ?? '');
            if (event.level === 'error') broadcast('agent_done', { ...base, error: true, text });
            else broadcast('agent_status', { ...base, status: 'running', note: text });
            break;
        }

        case 'auto_compaction_start':
            // internal lane + sanitized public status line (113.2 §5)
            publish('jwc', 'code_compaction', { ...base, phase: 'start' });
            broadcast('agent_status', { ...base, status: 'compacting' });
            break;
        case 'auto_compaction_end':
            publish('jwc', 'code_compaction', { ...base, phase: 'end' });
            broadcast('agent_status', { ...base, status: 'running' });
            break;

        case 'auto_retry_start':
        case 'auto_retry_end':
            publish('jwc', 'code_retry', { ...base, phase: event.type === 'auto_retry_start' ? 'start' : 'end' });
            break;

        // goal_updated / thinking_level_changed / ttsr / todo / irc — not surfaced in M2 Code mode.
        default:
            break;
    }
}
