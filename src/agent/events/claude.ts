// Claude CLI event adapter (claude, claude-e, ai-e)

import { appendBoundedFullText } from './fulltext-bound.js';
import { fieldString } from '../../types/cli-events.js';
import { updateTraceToolRow, getTraceToolEntry } from '../../trace/store.js';
import type { CliEventRecord } from './types.js';
import type { SpawnContext, ToolEntry } from './types.js';
import {
    syncLiveTools,
    emitAgentTool,
    pushTrace,
    buildPreview,
    appendAssistantTextSegment,
    extractAssistantText,
    summarizeToolInput,
    claudeRateLimitInfo,
    claudeRateLimitStatus,
    isClaudeRateLimitAllowed,
    isClaudeRateLimitWarning,
    claudeRateLimitResetMs,
    claudeRateLimitWaitMs,
    appendDetail,
    extractText,
} from './helpers.js';

// ─── Claude rate-limit tool management ───────────────

const CLAUDE_RATE_LIMIT_STEP_REF = 'claude:rate-limit';

function formatClaudeRateLimitReset(event: CliEventRecord): string {
    const resetMs = claudeRateLimitResetMs(event);
    if (!resetMs) return '';
    const date = new Date(resetMs);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString();
}

function buildClaudeRateLimitTool(event: CliEventRecord): ToolEntry | null {
    const info = claudeRateLimitInfo(event);
    const status = claudeRateLimitStatus(event);
    if (isClaudeRateLimitAllowed(status)) return null;

    const rateLimitType = fieldString(info["rateLimitType"] || info["rate_limit_type"]);
    const reset = formatClaudeRateLimitReset(event);
    const warning = isClaudeRateLimitWarning(status);
    const labelPrefix = warning ? 'Claude quota near limit' : 'Claude quota wait';
    const label = rateLimitType ? `${labelPrefix}: ${rateLimitType}` : labelPrefix;
    const detail = appendDetail(
        status ? `status: ${status}` : '',
        reset ? `resets_at: ${reset}` : '',
        fieldString(info["overageStatus"]) ? `overage: ${fieldString(info["overageStatus"])}` : '',
        fieldString(event.message || event.reason),
    );

    return {
        icon: warning ? '⚠️' : '⏳',
        label: buildPreview(label, 60),
        toolType: 'tool',
        status: warning ? 'done' : 'running',
        stepRef: CLAUDE_RATE_LIMIT_STEP_REF,
        ...(detail ? { detail } : {}),
    };
}

function finalizeClaudeRateLimitTool(
    ctx: SpawnContext,
    agentLabel: string | undefined,
    empTag: Record<string, unknown>,
    event?: CliEventRecord,
    reason = 'Claude quota wait resolved',
): boolean {
    const existing = [...ctx.toolLog].reverse().find(
        (t: ToolEntry) => t.stepRef === CLAUDE_RATE_LIMIT_STEP_REF && t.status === 'running'
    );
    if (!existing) return false;

    const status = event ? claudeRateLimitStatus(event) : '';
    existing.icon = '✅';
    existing.label = buildPreview(reason, 60);
    existing.status = 'done';
    const detail = appendDetail(existing.detail, status ? `status: ${status}` : '');
    if (detail) existing.detail = detail;
    syncLiveTools(ctx);
    emitAgentTool(ctx, agentLabel, existing, empTag);
    return true;
}

function upsertClaudeRateLimitTool(
    ctx: SpawnContext,
    agentLabel: string | undefined,
    empTag: Record<string, unknown>,
    tool: ToolEntry,
): void {
    const idx = ctx.toolLog.findIndex((t: ToolEntry) => t.stepRef === CLAUDE_RATE_LIMIT_STEP_REF);
    if (idx === -1) {
        ctx.toolLog.push(tool);
    } else {
        ctx.toolLog[idx] = { ...ctx.toolLog[idx], ...tool };
    }
    syncLiveTools(ctx);
    emitAgentTool(ctx, agentLabel, tool, empTag);
}

export function handleClaudeRateLimitEvent(
    ctx: SpawnContext,
    agentLabel: string | undefined,
    empTag: Record<string, unknown>,
    event: CliEventRecord,
): void {
    ctx.claudeRateLimitEventSeen = true;
    ctx.stallWatchdog?.markProgress();

    const status = claudeRateLimitStatus(event);
    if (isClaudeRateLimitAllowed(status)) {
        finalizeClaudeRateLimitTool(ctx, agentLabel, empTag, event);
        return;
    }

    const tool = buildClaudeRateLimitTool(event);
    if (!tool) return;
    upsertClaudeRateLimitTool(ctx, agentLabel, empTag, tool);

    if (tool.status !== 'running') return;
    const waitMs = claudeRateLimitWaitMs(event);
    if (waitMs <= 0 || !ctx.stallWatchdog) return;
    ctx.stallWatchdog.extendDeadline(waitMs, 'Claude quota wait');
    pushTrace(ctx, `[${agentLabel || 'agent'}] [watchdog] extended for Claude quota wait by ${Math.ceil(waitMs / 1000)}s`);
}

export function finalizeClaudeRateLimitOnResult(
    ctx: SpawnContext,
    agentLabel: string | undefined,
    empTag: Record<string, unknown>,
    event: CliEventRecord,
): void {
    finalizeClaudeRateLimitTool(ctx, agentLabel, empTag, event);
}

// ─── Claude snapshot text (claude-e / interactive) ───

function appendClaudeISnapshotText(ctx: SpawnContext, event: CliEventRecord): string {
    const text = extractAssistantText(event);
    if (!text) return '';

    const messageId = fieldString(event.message?.id || event.id);
    if (messageId && messageId === ctx.claudeILastAssistantId) {
        const previous = ctx.claudeILastAssistantText || '';
        ctx.claudeILastAssistantText = text;
        if (text === previous || previous.startsWith(text)) return '';
        ctx.printActivity?.message(text, 'replace', 'unknown');
        if (text.startsWith(previous)) {
            const delta = text.slice(previous.length);
            {
                const bounded = appendBoundedFullText(ctx.fullText, delta);
                ctx.fullText = bounded.text;
                if (bounded.truncated) ctx.fullTextTruncated = true;
            }
            return delta;
        }
        if (ctx.fullText.endsWith(previous)) {
            ctx.fullText = ctx.fullText.slice(0, -previous.length) + text;
        }
        return '';
    }

    // Reaching here means this snapshot is NOT a continuation of the message
    // already accumulating: either the id changed, or there is no id to match.
    // Either way a new assistant message started, so what came before was progress
    // narration rather than part of this answer (NARRATION-BOUNDARY-01).
    //
    // The guard is claudeILastAssistantText, not the id: an id-LESS snapshot used
    // to clear the id and thereby blind the NEXT identified event to its own
    // boundary, letting narration survive. Tracking "a message was accumulating"
    // covers identified and anonymous streams alike, and still leaves the first
    // message of a run untouched.
    if (ctx.claudeILastAssistantText !== undefined) resetClaudeDurableMessage(ctx);
    if (messageId) ctx.claudeILastAssistantId = messageId;
    else delete ctx.claudeILastAssistantId;
    ctx.claudeILastAssistantText = text;
    ctx.printActivity?.message(text, 'replace', 'unknown');
    return appendAssistantTextSegment(ctx, text);
}

/** Drop the durable accumulation at a claude MESSAGE boundary
 *  (NARRATION-BOUNDARY-01: external channels read ctx.fullText, so narration that
 *  survives here reaches Slack).
 *
 *  Every field below describes the message being REPLACED, so they must move
 *  together. A stale streaming anchor makes the next reconcile slice at the wrong
 *  offset — or skip entirely — and a stale snapshot baseline slices a real prefix
 *  off the new message. pendingOutputChunk is deliberately untouched: it is the
 *  live drain buffer, and clearing it would lose text the UI has not read yet.
 *  liveOutputText is guarded rather than assumed: claude runs never initialize it
 *  (spawn.ts gates that to kiro-plain/agy/pi), and this mirrors the same defensive
 *  check the reconcile path already carries. */
export function resetClaudeDurableMessage(ctx: SpawnContext): void {
    ctx.printActivity?.nextMessage();
    ctx.fullText = '';
    if (ctx.liveOutputText !== undefined) ctx.liveOutputText = '';
    ctx.outputTextStarted = false;
    delete ctx.fullTextTruncated;
    ctx.claudeStreamedText = false;
    ctx.claudeStreamedTextStart = undefined;
    delete ctx.claudeILastAssistantId;
    delete ctx.claudeILastAssistantText;
}

// ─── Flush buffers (public export, called from spawn.ts) ─────

export function flushClaudeBuffers(ctx: SpawnContext, agentLabel?: string, empTag: Record<string, unknown> = {}) {
    if (ctx.claudeThinkingBuf) {
        const merged = ctx.claudeThinkingBuf.trim();
        if (merged) {
            const tool = {
                icon: '💭',
                label: buildPreview(merged, 80) || 'thinking...',
                toolType: 'thinking' as const,
                detail: merged,
            };
            ctx.toolLog.push(tool);
            syncLiveTools(ctx);
            emitAgentTool(ctx, agentLabel, tool, empTag);
            pushTrace(ctx, `[${agentLabel || 'agent'}] 💭 ${merged.slice(0, 200)}`);
        }
        ctx.claudeThinkingBuf = '';
    }
    if (ctx.claudeInputJsonBuf) {
        try {
            const input = JSON.parse(ctx.claudeInputJsonBuf);
            const toolName = ctx.claudeCurrentToolName || 'tool';
            const detail = summarizeToolInput(toolName, input);
            if (detail) {
                const existing = [...ctx.toolLog].reverse().find(
                    (t: ToolEntry) => t.icon === '🔧' && t.label === toolName && !t.detail
                );
                if (existing) {
                    existing.detail = detail;
                    syncLiveTools(ctx);
                    emitAgentTool(ctx, agentLabel, existing, empTag);
                }
            }
        } catch { /* partial JSON — best effort */ }
        ctx.claudeInputJsonBuf = '';
        ctx.claudeCurrentToolName = '';
    }
}

// ─── Main Claude event handler ───────────────────────

export function handleClaudeEvent(
    evt: CliEventRecord,
    ctx: SpawnContext,
    cli: string,
    agentLabel: string,
    empTag: Record<string, unknown>,
): void {
    if (evt.type === 'assistant' && evt.message?.content) {
        if (cli === 'claude-e') {
            const segment = appendClaudeISnapshotText(ctx, evt);
            ctx.pendingOutputChunk = (ctx.pendingOutputChunk || '') + segment;
        } else if (ctx.claudeStreamedText) {
            // Reconcile the raw-streamed region with the canonical complete block via
            // the segment formatter: restores the '\n- ' boundary between
            // tool-separated messages (codex/claude-e parity) without re-appending
            // (260612 audit 07 F-T4 no-doubling — replace, never append) and without
            // mid-token corruption (the canonical block is complete text, not a token).
            const hasCanonicalText = evt.message.content.some(
                (block) => block.type === 'text' && block.text,
            );
            if (hasCanonicalText) ctx.printActivity?.message(extractAssistantText(evt), 'replace', 'unknown');
            if (ctx.claudeStreamedTextStart !== undefined && hasCanonicalText) {
                const useLive = ctx.liveOutputText !== undefined;
                const target = useLive ? ctx.liveOutputText! : ctx.fullText;
                if (ctx.claudeStreamedTextStart <= target.length) {
                    const truncated = target.slice(0, ctx.claudeStreamedTextStart);
                    if (useLive) ctx.liveOutputText = truncated;
                    else ctx.fullText = truncated;
                    // Re-derive so the formatter's first-output branch keeps a plain
                    // first message unbulleted.
                    ctx.outputTextStarted = truncated.trim().length > 0;
                    for (const block of evt.message.content) {
                        if (block.type === 'text') appendAssistantTextSegment(ctx, block.text);
                    }
                }
            }
            // Reset the per-message state so the next assistant message starts clean.
            ctx.claudeStreamedText = false;
            ctx.claudeStreamedTextStart = undefined;
        } else {
            // Fallback: no partial text stream seen (e.g. --include-partial-messages
            // absent) → surface the complete assistant text block here.
            // A CHANGED top-level message id is a new assistant message, so the
            // previous one was narration (NARRATION-BOUNDARY-01). Key on the id
            // rather than on "a second event arrived": one message can span several
            // assistant events, and a boolean would delete the first block's text.
            const fallbackId = fieldString(evt.message?.id || evt.id);
            if (fallbackId && ctx.claudeILastAssistantId !== undefined
                && ctx.claudeILastAssistantId !== fallbackId) {
                resetClaudeDurableMessage(ctx);
            }
            if (fallbackId) ctx.claudeILastAssistantId = fallbackId;
            for (const block of evt.message.content) {
                if (block.type === 'text') {
                    if (block.text) ctx.printActivity?.message(block.text, 'append', 'unknown');
                    const segment = appendAssistantTextSegment(ctx, block.text);
                    ctx.pendingOutputChunk = (ctx.pendingOutputChunk || '') + segment;
                }
            }
        }
    } else if (evt.type === 'result') {
        ctx.cost = evt.total_cost_usd ?? null;
        ctx.turns = evt.num_turns ?? null;
        ctx.duration = evt.duration_ms ?? null;
        if (evt.session_id) ctx.sessionId = evt.session_id;
        if (evt.usage) {
            ctx.tokens = {
                input_tokens: evt.usage.input_tokens ?? 0,
                output_tokens: evt.usage.output_tokens ?? ctx.tokens?.["output_tokens"] ?? 0,
                cache_read: evt.usage.cache_read_input_tokens ?? 0,
                cache_creation: evt.usage.cache_creation_input_tokens ?? 0,
            };
        }
    } else if (evt.type === 'user' && evt.message?.content) {
        for (const block of evt.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
                const existing = [...ctx.toolLog].reverse().find(
                    (t: ToolEntry) => t.stepRef === `claude:tooluse:${block.tool_use_id}`
                );
                if (existing) {
                    existing.status = block["is_error"] ? 'error' : 'done';
                    existing.icon = block["is_error"] ? '❌' : '✅';
                    const resultText = extractText(block.content);
                    if (resultText && !existing.detail) {
                        existing.detail = resultText.length > 500
                            ? resultText.slice(0, 497) + '...'
                            : resultText;
                    }
                    syncLiveTools(ctx);
                    updateTraceToolRow(existing);
                    emitAgentTool(ctx, agentLabel, existing, empTag);
                } else {
                    // RAM cap evicted the placeholder — converge the durable row via
                    // the stamp-time index so trace state still reaches final
                    // status (WP4, devlog 260703 doc 12 item 3).
                    const pointer = ctx.toolTraceIndex?.get(`claude:tooluse:${block.tool_use_id}`);
                    if (pointer) {
                        const base = getTraceToolEntry(pointer.traceRunId, pointer.traceSeq);
                        const resultText = extractText(block.content);
                        const merged: ToolEntry = {
                            toolType: 'tool',
                            label: 'tool',
                            ...base,
                            stepRef: `claude:tooluse:${block.tool_use_id}`,
                            icon: block["is_error"] ? '❌' : '✅',
                            status: block["is_error"] ? 'error' : 'done',
                            traceRunId: pointer.traceRunId,
                            traceSeq: pointer.traceSeq,
                        };
                        if (resultText && !merged.detail) {
                            merged.detail = resultText.length > 500
                                ? resultText.slice(0, 497) + '...'
                                : resultText;
                        }
                        updateTraceToolRow(merged);
                        ctx.printActivity?.tool(merged);
                    }
                }
            }
        }
    }
}
