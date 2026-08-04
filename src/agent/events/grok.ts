// Grok CLI event adapter

import { appendBoundedFullText } from './fulltext-bound.js';
import {
    asCliEventRecord,
    fieldString,
    isCliEventRecord,
} from '../../types/cli-events.js';
import type { CliEventRecord } from './types.js';
import type { SpawnContext, ToolEntry } from './types.js';
import {
    syncLiveTools,
    emitAgentTool,
    pushTrace,
    buildPreview,
    summarizeToolInput,
} from './helpers.js';

const GROK_THINKING_STEP_REF = 'grok:thinking';
const GROK_THINKING_UPDATE_MIN_MS = 750;
const GROK_THINKING_UPDATE_MIN_CHARS = 240;
const GROK_THOUGHT_BUFFER_MAX = 102_400;

function findGrokThinkingTool(ctx: SpawnContext): ToolEntry | undefined {
    const currentRef = ctx.grokCurrentThoughtRef;
    if (currentRef) {
        const current = [...ctx.toolLog].reverse().find(
            (t: ToolEntry) => t.stepRef === currentRef && (!t.status || t.status === 'running')
        );
        if (current) return current;
    }
    return [...ctx.toolLog].reverse().find(
        (t: ToolEntry) => t.stepRef?.startsWith(GROK_THINKING_STEP_REF) && (!t.status || t.status === 'running')
    );
}

function nextGrokThinkingStepRef(ctx: SpawnContext): string {
    if (ctx.grokCurrentThoughtRef) return ctx.grokCurrentThoughtRef;
    ctx.grokThoughtSeq = (ctx.grokThoughtSeq || 0) + 1;
    ctx.grokCurrentThoughtRef = ctx.grokThoughtSeq === 1
        ? GROK_THINKING_STEP_REF
        : `${GROK_THINKING_STEP_REF}:${ctx.grokThoughtSeq}`;
    return ctx.grokCurrentThoughtRef;
}

function shouldEmitGrokThinkingUpdate(ctx: SpawnContext, detail: string): boolean {
    const now = Date.now();
    const lastAt = ctx.grokLastThoughtEmitAt || 0;
    const lastChars = ctx.grokLastThoughtEmitChars || 0;
    return !lastAt
        || now - lastAt >= GROK_THINKING_UPDATE_MIN_MS
        || Math.max(0, detail.length - lastChars) >= GROK_THINKING_UPDATE_MIN_CHARS;
}

function markGrokThinkingUpdateEmitted(ctx: SpawnContext, detail: string): void {
    ctx.grokLastThoughtEmitAt = Date.now();
    ctx.grokLastThoughtEmitChars = detail.length;
}

function ensureGrokThinkingProgress(
    ctx: SpawnContext,
    agentLabel: string,
    empTag: Record<string, unknown>,
    detail?: string,
): void {
    const trimmed = detail?.trim() || '';
    const label = 'Grok thinking';
    const existing = findGrokThinkingTool(ctx);
    if (existing) {
        existing.label = label;
        if (trimmed) existing.detail = trimmed;
        if (!shouldEmitGrokThinkingUpdate(ctx, trimmed)) return;
        syncLiveTools(ctx);
        emitAgentTool(ctx, agentLabel, existing, empTag);
        markGrokThinkingUpdateEmitted(ctx, trimmed);
        return;
    }
    const stepRef = nextGrokThinkingStepRef(ctx);
    const tool = {
        icon: '💭',
        label,
        toolType: 'thinking' as const,
        ...(trimmed ? { detail: trimmed } : {}),
        status: 'running' as const,
        stepRef,
    };
    ctx.grokThoughtProgressEmitted = true;
    ctx.toolLog.push(tool);
    syncLiveTools(ctx);
    emitAgentTool(ctx, agentLabel, tool, empTag);
    markGrokThinkingUpdateEmitted(ctx, trimmed);
    pushTrace(ctx, `[${agentLabel}] grok thinking started`);
}

function finalizeGrokThinkingProgress(
    ctx: SpawnContext,
    agentLabel: string,
    empTag: Record<string, unknown>,
    detail?: string,
): boolean {
    const existing = findGrokThinkingTool(ctx);
    if (!existing) return false;
    existing.status = 'done';
    if (detail?.trim()) {
        const trimmed = detail.trim();
        existing.label = buildPreview(trimmed, 80) || 'thinking...';
        existing.detail = trimmed;
    }
    syncLiveTools(ctx);
    emitAgentTool(ctx, agentLabel, existing, empTag);
    delete ctx.grokCurrentThoughtRef;
    delete ctx.grokLastThoughtEmitAt;
    delete ctx.grokLastThoughtEmitChars;
    ctx.grokThoughtProgressEmitted = false;
    return true;
}

function finalizeAllGrokThinkingProgress(
    ctx: SpawnContext,
    agentLabel: string,
    empTag: Record<string, unknown>,
): void {
    const runningThoughts = ctx.toolLog.filter(
        (t: ToolEntry) => t.stepRef?.startsWith(GROK_THINKING_STEP_REF) && (!t.status || t.status === 'running')
    );
    for (const thought of runningThoughts) {
        thought.status = 'done';
        syncLiveTools(ctx);
        emitAgentTool(ctx, agentLabel, thought, empTag);
    }
    delete ctx.grokCurrentThoughtRef;
    delete ctx.grokLastThoughtEmitAt;
    delete ctx.grokLastThoughtEmitChars;
    ctx.grokThoughtProgressEmitted = false;
}

function grokToolRef(event: CliEventRecord, ctx: SpawnContext): string {
    const part = asCliEventRecord(event.part);
    const rawId = fieldString(event.id)
        || fieldString(event.toolCallId)
        || fieldString(event["tool_call_id"])
        || fieldString(event["toolUseId"])
        || fieldString(event.tool_id)
        || fieldString(event.tool_use_id)
        || fieldString(event["toolId"])
        || fieldString(event["call_id"])
        || fieldString(event.callID)
        || fieldString(event["callId"])
        || fieldString(part.callID)
        || fieldString(part.id)
        || fieldString(part["toolCallId"])
        || fieldString(part["tool_call_id"])
        || fieldString(event.requestId);
    if (rawId) return `grok:tool:${rawId}`;
    ctx.grokSyntheticToolSeq = (ctx.grokSyntheticToolSeq || 0) + 1;
    return `grok:tool:synthetic-${ctx.grokSyntheticToolSeq}`;
}

function grokToolName(event: CliEventRecord): string {
    const part = asCliEventRecord(event.part);
    const state = asCliEventRecord(event.state);
    const partState = asCliEventRecord(part.state);
    const toolName = isCliEventRecord(event.tool) ? fieldString(event.tool.name) : fieldString(event.tool);
    return fieldString(event.name)
        || fieldString(event["toolName"])
        || fieldString(event.tool_name)
        || toolName
        || fieldString(part.tool)
        || fieldString(part.name)
        || fieldString(state.title)
        || fieldString(partState.title)
        || fieldString(event.command)
        || fieldString(event.title)
        || 'tool';
}

function grokToolDetail(event: CliEventRecord): string {
    const name = grokToolName(event);
    const rawInput = event["arguments"] ?? event["args"] ?? event.input ?? event.parameters;
    if (rawInput && typeof rawInput === 'object') {
        const summary = summarizeToolInput(name, rawInput as Record<string, unknown>);
        if (summary && summary !== '{}') return summary;
    }
    const part = asCliEventRecord(event.part);
    const state = asCliEventRecord(event.state);
    const partState = asCliEventRecord(part.state);
    const value = event["arguments"]
        ?? event["args"]
        ?? event.input
        ?? event.parameters
        ?? event.rawInput
        ?? part.input
        ?? partState.input
        ?? event.output
        ?? state.output
        ?? part.output
        ?? partState.output
        ?? event["result"]
        ?? event.data
        ?? event.error
        ?? event.message;
    if (typeof value === 'string') return value;
    if (value == null) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function handleGrokToolEvent(
    event: CliEventRecord,
    ctx: SpawnContext,
    agentLabel: string,
    empTag: Record<string, unknown>,
): boolean {
    const type = fieldString(event.type);
    const part = asCliEventRecord(event.part);
    const state = asCliEventRecord(event.state);
    const partState = asCliEventRecord(part.state);
    const rawStatus = fieldString(event.status) || fieldString(state.status) || fieldString(partState.status);
    const normalizedStatus = rawStatus.toLowerCase();
    const completedStatuses = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'failed', 'error']);
    const startTypes = new Set(['tool_use', 'tool_call', 'tool_start', 'tool.started']);
    const endTypes = new Set(['tool_result', 'tool_output', 'tool_end', 'tool.completed']);
    const startsTool = startTypes.has(type);
    const endsTool = endTypes.has(type) || (startsTool && completedStatuses.has(normalizedStatus));
    if (!startsTool && !endsTool) return false;

    const ref = grokToolRef(event, ctx);
    const name = grokToolName(event);
    const detail = grokToolDetail(event);
    const isError = Boolean(
        event["is_error"]
        || event.error
        || normalizedStatus === 'error'
        || normalizedStatus === 'failed'
    );

    if (startsTool && !endsTool) {
        const existing = [...ctx.toolLog].reverse().find((t: ToolEntry) => t.stepRef === ref);
        if (existing) {
            existing.icon = '🔧';
            existing.label = buildPreview(name, 80) || existing.label || 'tool';
            existing.toolType = 'tool';
            existing.status = 'running';
            if (detail) existing.detail = detail;
            syncLiveTools(ctx);
            emitAgentTool(ctx, agentLabel, existing, empTag);
            return true;
        }
        const tool = {
            icon: '🔧',
            label: buildPreview(name, 80) || 'tool',
            toolType: 'tool' as const,
            ...(detail ? { detail } : {}),
            status: 'running' as const,
            stepRef: ref,
        };
        ctx.toolLog.push(tool);
        syncLiveTools(ctx);
        emitAgentTool(ctx, agentLabel, tool, empTag);
        pushTrace(ctx, `[${agentLabel}] grok tool start: ${name}`);
        return true;
    }

    const existing = [...ctx.toolLog].reverse().find((t: ToolEntry) => t.stepRef === ref);
    const doneTool = existing || {
        icon: isError ? '❌' : '✅',
        label: buildPreview(name, 80) || 'tool',
        toolType: 'tool' as const,
        stepRef: ref,
    };
    doneTool.icon = isError ? '❌' : '✅';
    doneTool.label = buildPreview(name, 80) || doneTool.label || 'tool';
    doneTool.status = isError ? 'error' : 'done';
    if (detail) doneTool.detail = detail;
    if (!existing) ctx.toolLog.push(doneTool);
    syncLiveTools(ctx);
    emitAgentTool(ctx, agentLabel, doneTool, empTag);
    pushTrace(ctx, `[${agentLabel}] grok tool ${isError ? 'error' : 'done'}: ${name}`);
    return true;
}

export function handleGrokEvent(
    evt: CliEventRecord,
    ctx: SpawnContext,
    agentLabel: string,
    empTag: Record<string, unknown>,
): void {
    if (evt.type === 'error') {
        const detail = String(
            evt.error?.message
            || evt.message
            || evt.data
            || evt.text
            || 'grok error',
        ).trim();
        const tool = {
            icon: '❌',
            label: buildPreview(detail, 80) || 'grok error',
            toolType: 'tool' as const,
            detail,
            status: 'error' as const,
            stepRef: `grok:error:${evt.requestId || ctx.traceRunId || 'run'}`,
        };
        const key = `${tool.stepRef}:${detail}`;
        if (ctx.seenToolKeys.has(key)) return;
        ctx.seenToolKeys.add(key);
        ctx.toolLog.push(tool);
        syncLiveTools(ctx);
        emitAgentTool(ctx, agentLabel, tool, empTag);
        pushTrace(ctx, `[${agentLabel}] grok error: ${detail.slice(0, 200)}`);
        return;
    }
    if (handleGrokToolEvent(evt, ctx, agentLabel, empTag)) {
        return;
    }
    if (evt.type === 'thought') {
        const text = String(evt.data || evt.text || '');
        const buf = (ctx.grokThoughtBuf || '') + text;
        ctx.grokThoughtBuf = buf.length > GROK_THOUGHT_BUFFER_MAX ? buf.slice(-GROK_THOUGHT_BUFFER_MAX) : buf;
        ensureGrokThinkingProgress(ctx, agentLabel, empTag, ctx.grokThoughtBuf);
        return;
    }
    if (evt.type === 'text') {
        const text = String(evt.data || evt.text || '');
        if (text) {
            finalizeGrokThinkingProgress(ctx, agentLabel, empTag, ctx.grokThoughtBuf);
            ctx.grokThoughtBuf = '';
            {
                const bounded = appendBoundedFullText(ctx.fullText, text);
                ctx.fullText = bounded.text;
                if (bounded.truncated) ctx.fullTextTruncated = true;
            }
            ctx.outputTextStarted = true;
            ctx.pendingOutputChunk = (ctx.pendingOutputChunk || '') + text;
        }
        return;
    }
    if (evt.type === 'end') {
        if (typeof evt.sessionId === 'string' && evt.sessionId.trim()) {
            ctx.sessionId = evt.sessionId;
        }
        if (!ctx.metadata) ctx.metadata = {};
        if (evt.stopReason) ctx.metadata["stopReason"] = evt.stopReason;
        if (evt.requestId) ctx.metadata["requestId"] = evt.requestId;
        if (ctx.grokThoughtBuf?.trim()) {
            const detail = ctx.grokThoughtBuf.trim();
            const updated = finalizeGrokThinkingProgress(ctx, agentLabel, empTag, detail);
            if (!updated) {
                const tool = {
                    icon: '💭',
                    label: buildPreview(detail, 80) || 'thinking...',
                    toolType: 'thinking' as const,
                    detail,
                    status: 'done' as const,
                };
                ctx.toolLog.push(tool);
                syncLiveTools(ctx);
                emitAgentTool(ctx, agentLabel, tool, empTag);
            }
            ctx.grokThoughtBuf = '';
        } else {
            finalizeGrokThinkingProgress(ctx, agentLabel, empTag);
        }
        finalizeAllGrokThinkingProgress(ctx, agentLabel, empTag);
    }
}
