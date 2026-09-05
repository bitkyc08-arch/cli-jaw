// Cursor CLI stream-json adapter.

import { stripUndefined } from '../../core/strip-undefined.js';
import { getTraceToolEntry, updateTraceToolRow } from '../../trace/store.js';
import { asCliEventRecord, fieldNumber, fieldString } from '../../types/cli-events.js';
import type { CliEventRecord, SpawnContext, ToolEntry } from './types.js';
import {
    appendAssistantTextSegment,
    buildPreview,
    emitAgentTool,
    extractText,
    normalizeAssistantDisplayText,
    pushTrace,
    summarizeToolInput,
    syncLiveTools,
} from './helpers.js';

function cursorSessionId(event: CliEventRecord): string {
    return fieldString(event.session_id || event.sessionId);
}

function cursorAssistantText(event: CliEventRecord): string {
    const message = asCliEventRecord(event.message);
    return fieldString(event.text)
        || extractText(message.content)
        || extractText(event.content);
}

/** True when this assistant event begins a NEW message rather than continuing the
 *  one already accumulating. Cursor stream-json carries no channel tags, so message
 *  identity is the only seam left on turns that never call a tool.
 *
 *  A delta NEVER starts a new message — it is by definition a continuation, and this
 *  check comes first on purpose: cursor's message-id granularity is unverified, so an
 *  id-first rule would shred an answer down to its last chunk if ids ever varied per
 *  chunk. A snapshot that extends the previous text also continues (that is how cursor
 *  grows one answer). Everything else starts fresh.
 */
function cursorStartsNewAssistantMessage(
    ctx: SpawnContext,
    event: CliEventRecord,
    text: string,
    isDelta: boolean,
): boolean {
    if (isDelta) return false;
    const messageId = fieldString(event.message?.id || event["message_id"]);
    if (messageId) {
        return ctx.cursorAssistantMessageId !== undefined
            && ctx.cursorAssistantMessageId !== messageId;
    }
    const previous = ctx.cursorAssistantText || '';
    if (!previous) return false;
    return !text.startsWith(previous);
}

function appendCursorAssistantText(ctx: SpawnContext, event: CliEventRecord): string {
    const text = normalizeAssistantDisplayText(cursorAssistantText(event));
    if (!text) return '';

    const isDelta = event.subtype === 'delta' || event.delta?.type === 'text_delta';
    // LAST-WINS across MESSAGE boundaries — the companion to the tool-boundary rule
    // below. A turn that never calls a tool, or that narrates after its last tool,
    // has no tool seam, so successive assistant messages used to concatenate into the
    // durable answer and reach Slack as one run-on paragraph.
    //
    // Two non-continuing snapshots are ambiguous: "narration then answer" and "answer
    // part 1 then part 2" look identical on the wire. Last-wins is the same tradeoff
    // the codex NDJSON adapter already makes for untagged agent_messages, and the
    // observed failures are all the first shape. Cumulative snapshot growth (the
    // prefix case) is unaffected.
    if (cursorStartsNewAssistantMessage(ctx, event, text, isDelta)) {
        ctx.printActivity?.nextMessage();
        ctx.fullText = '';
        ctx.outputTextStarted = false;
        // Drop the dedupe baseline too. It describes the message being replaced, and
        // this snapshot belongs to a different one — keeping it would slice a real
        // prefix off the new message ('요약' + '요약본입니다.' → '본입니다.'). The
        // tool guard below keeps its baseline for the opposite reason: there the NEXT
        // text may still be a cumulative snapshot of the SAME message.
        ctx.cursorAssistantText = '';
    }
    if (!isDelta) {
        const messageId = fieldString(event.message?.id || event["message_id"]);
        if (messageId) ctx.cursorAssistantMessageId = messageId;
    }

    const previous = ctx.cursorAssistantText || '';
    const segmentText = isDelta
        ? text
        : (text.startsWith(previous) ? text.slice(previous.length) : text);
    if (!segmentText) return '';

    ctx.printActivity?.message(segmentText, 'append', 'unknown');
    ctx.cursorAssistantText = isDelta ? `${previous}${text}` : text;
    return appendAssistantTextSegment(ctx, segmentText);
}

function updateCursorUsage(ctx: SpawnContext, usage: unknown): void {
    const data = asCliEventRecord(usage);
    const inputTokens = fieldNumber(data["inputTokens"] || data["input_tokens"]);
    const outputTokens = fieldNumber(data["outputTokens"] || data["output_tokens"]);
    const cacheRead = fieldNumber(data["cacheReadTokens"] || data["cache_read_input_tokens"]);
    const cacheWrite = fieldNumber(data["cacheWriteTokens"] || data["cache_creation_input_tokens"]);
    if (inputTokens == null && outputTokens == null && cacheRead == null && cacheWrite == null) return;
    ctx.tokens = stripUndefined({
        input_tokens: inputTokens ?? ctx.tokens?.["input_tokens"] ?? 0,
        output_tokens: outputTokens ?? ctx.tokens?.["output_tokens"] ?? 0,
        cached_read: cacheRead ?? ctx.tokens?.["cached_read"],
        cached_write: cacheWrite ?? ctx.tokens?.["cached_write"],
    }) as Record<string, number>;
}

function cursorToolRef(event: CliEventRecord): string {
    return fieldString(event["call_id"] || event.callID || event.tool_id || event.id || event.name, 'tool');
}

function cursorToolKindLabel(kindKey: string): string {
    const base = kindKey.replace(/ToolCall$/i, '');
    if (!base) return 'tool';
    const aliases: Record<string, string> = {
        shell: 'Bash',
        read: 'Read',
        write: 'Write',
        edit: 'Edit',
        grep: 'Grep',
        glob: 'Glob',
        list: 'List',
        search: 'Search',
        web: 'WebSearch',
        mcp: 'MCP',
    };
    if (aliases[base]) return aliases[base];
    return base.charAt(0).toUpperCase() + base.slice(1);
}

function parseCursorToolPayload(event: CliEventRecord): { name: string; input: unknown } {
    const nested = asCliEventRecord(event['tool_call']);
    if (nested) {
        for (const [kindKey, rawPayload] of Object.entries(nested)) {
            const payload = asCliEventRecord(rawPayload);
            if (!payload) continue;
            const name = cursorToolKindLabel(kindKey);
            const input = payload['args'] ?? payload.input ?? payload.parameters ?? payload;
            return { name, input };
        }
    }
    return {
        name: fieldString(event.name || event.tool || event.tool_name, 'tool'),
        input: event.input || event.rawInput || event.parameters || {},
    };
}

function cursorToolStatus(event: CliEventRecord): 'running' | 'done' | 'error' {
    const phase = fieldString(event.status || event.subtype);
    if (['started', 'running', 'in_progress', 'pending'].includes(phase)) return 'running';

    const nested = asCliEventRecord(event['tool_call']);
    if (nested) {
        for (const rawPayload of Object.values(nested)) {
            const payload = asCliEventRecord(rawPayload);
            const result = asCliEventRecord(payload?.['result']);
            if (result?.['rejected'] || result?.error || result?.['failed']) return 'error';
        }
    }

    if (['error', 'failed', 'rejected', 'denied'].includes(phase)) return 'error';
    if (['completed', 'success', 'done'].includes(phase)) return 'done';
    return 'running';
}

function cursorToolLabel(event: CliEventRecord): ToolEntry {
    const { name, input } = parseCursorToolPayload(event);
    const status = cursorToolStatus(event);
    return stripUndefined({
        icon: status === 'error' ? '❌' : (status === 'done' ? '✅' : '🔧'),
        label: buildPreview(name, 60) || 'tool',
        toolType: 'tool' as const,
        stepRef: `cursor:tool:${cursorToolRef(event)}`,
        detail: summarizeToolInput(name, input, 0),
        status,
    });
}

function emitCursorTool(
    ctx: SpawnContext,
    agentLabel: string,
    empTag: Record<string, unknown>,
    tool: ToolEntry,
): void {
    const key = [tool.icon, tool.label, tool.stepRef || '', tool.status || ''].join(':');
    const existingIdx = tool.stepRef
        ? ctx.toolLog.findIndex((entry) => entry.stepRef === tool.stepRef)
        : -1;
    let prior = ctx.toolLog[existingIdx];
    const pointer = tool.stepRef ? ctx.toolTraceIndex?.get(tool.stepRef) : undefined;
    if (!prior && pointer) {
        prior = getTraceToolEntry(pointer.traceRunId, pointer.traceSeq) ?? undefined;
    }
    // Late start snapshots must not reopen a completed tool, even with changed detail.
    if (['done', 'error', 'stopped'].includes(prior?.status || '')
        && !['done', 'error', 'stopped'].includes(tool.status || '')) return;
    if (ctx.seenToolKeys?.has(key) && (!prior || prior.detail === tool.detail)) return;
    ctx.seenToolKeys?.add(key);
    // Admission precedes all text/message-boundary effects as well as tool writes.
    // LAST-WINS across tool boundaries: assistant text that arrived BEFORE
    // a tool ran is planning narration ("경계를 먼저 확인한 뒤 ..."), not part
    // of the final answer. Cursor stream-json has no channel tags, so the
    // tool boundary is the only reliable seam — discard the durable
    // accumulation when a NEW tool starts and keep only post-last-tool text.
    // Only on 'running' (tool start): a late completion update arriving
    // after the answer began must not wipe answer text. The delta/snapshot
    // dedupe state (cursorAssistantText) is deliberately NOT reset, so a
    // cumulative end-of-turn snapshot still dedupes to nothing instead of
    // re-ingesting the discarded narration. Live UI keeps the narration via
    // pendingOutputChunk/agent_output; only fullText (=agent_done → external
    // channels) is affected.
    if (tool.status === 'running' && (ctx.fullText || ctx.outputTextStarted)) {
        ctx.printActivity?.nextMessage();
        ctx.fullText = '';
        ctx.outputTextStarted = false;
    }
    const traceRunId = pointer?.traceRunId ?? prior?.traceRunId;
    const traceSeq = pointer?.traceSeq ?? prior?.traceSeq;
    if (traceRunId && traceSeq) {
        tool.traceRunId = traceRunId;
        tool.traceSeq = traceSeq;
        tool.detailAvailable = ctx.traceAudience !== 'internal';
        if (ctx.traceAudience === 'internal') tool.rawRetentionStatus = 'internal';
        else if (prior?.rawRetentionStatus !== undefined) tool.rawRetentionStatus = prior.rawRetentionStatus;
    }
    if (existingIdx >= 0) ctx.toolLog[existingIdx] = tool;
    else ctx.toolLog.push(tool);
    syncLiveTools(ctx);
    updateTraceToolRow(tool);
    emitAgentTool(ctx, agentLabel, tool, empTag);
}

export function handleCursorEvent(
    event: CliEventRecord,
    ctx: SpawnContext,
    agentLabel: string,
    empTag: Record<string, unknown>,
): void {
    const sid = cursorSessionId(event);
    if (sid) ctx.sessionId = sid;

    if (event.type === 'system') {
        if (event.model) ctx.model = event.model;
        ctx.metadata = { ...(ctx.metadata || {}), cursor: stripUndefined({
            subtype: event.subtype,
            permissionMode: event["permissionMode"],
            model: event.model,
        }) };
        pushTrace(ctx, `[${agentLabel}] cursor system${event.model ? ` model=${event.model}` : ''}`);
    }

    if (event.type === 'assistant') {
        const segment = appendCursorAssistantText(ctx, event);
        ctx.pendingOutputChunk = (ctx.pendingOutputChunk || '') + segment;
    }

    if (event.type === 'tool_call') {
        emitCursorTool(ctx, agentLabel, empTag, cursorToolLabel(event));
    }

    if (event.type === 'result') {
        updateCursorUsage(ctx, event.usage);
        if (event.duration_ms != null) ctx.duration = Number(event.duration_ms);
        if (event.cost != null || event.total_cost_usd != null) {
            ctx.cost = Number(event.cost ?? event.total_cost_usd);
        }
        if (event.subtype) ctx.finishReason = String(event.subtype);
        const rejected = event["rejected"] === true || event["is_error"] === true;
        if (rejected) {
            const detail = fieldString(event["result"] || event.output || event.error?.message, 'Cursor result rejected');
            emitCursorTool(ctx, agentLabel, empTag, {
                icon: '❌',
                label: buildPreview(detail, 80) || 'cursor rejected',
                toolType: 'tool',
                detail,
                status: 'error',
            });
        } else if (!ctx.fullText && typeof event["result"] === 'string') {
            const text = normalizeAssistantDisplayText(event["result"]);
            ctx.printActivity?.message(text, 'append', 'unknown');
            const segment = appendAssistantTextSegment(ctx, text);
            ctx.pendingOutputChunk = (ctx.pendingOutputChunk || '') + segment;
        }
    }
}
