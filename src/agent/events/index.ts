// Event dispatcher and public API

// --- Explicit named re-exports (legacy public surface only) ---
export { flushClaudeBuffers } from './claude.js';
export { flushOpenCodeBuffers } from './opencode.js';
export { extractFromAcpUpdate, extractFromAcpSubagent } from './acp.js';
export { summarizeToolInput, extractToolLabel, extractToolLabelsForTest, makeClaudeToolKeyForTest } from './tool-labels.js';
export { logEventSummary } from './summary.js';

import type { SpawnContext, ToolEntry, CliEventRecord } from './types.js';
import { isClaudeLikeCli } from '../cli-helpers.js';
import {
    syncLiveTools,
    emitAgentTool,
    pushTrace,
    buildPreview,
    summarizeToolInput,
    appendAssistantRawText,
} from './helpers.js';
import { handleClaudeEvent, handleClaudeRateLimitEvent, finalizeClaudeRateLimitOnResult } from './claude.js';
import { handleCodexEvent } from './codex.js';
import { handleCursorEvent } from './cursor.js';
import { handleGrokEvent } from './grok.js';
import { handleOpenCodeEvent } from './opencode.js';
import { extractToolLabels } from './tool-labels.js';

export function extractSessionId(cli: string, event: CliEventRecord): string | null {
    switch (cli) {
        case 'claude':
        case 'claude-e': return event.type === 'system' ? event.session_id ?? null : null;
        case 'codex': return event.type === 'thread.started' ? event.thread_id ?? null : null;
        case 'cursor': return event.session_id ?? event.sessionId ?? null;
        case 'grok': return event.type === 'end' ? event.sessionId ?? null : null;
        case 'opencode': return event.sessionID ?? null;
        default: return null;
    }
}

export function extractOutputChunk(cli: string, event: CliEventRecord, ctx?: SpawnContext): string {
    if (cli === 'opencode') {
        if (ctx?.pendingOutputChunk) {
            const chunk = ctx.pendingOutputChunk;
            ctx.pendingOutputChunk = '';
            return chunk;
        }
        return '';
    }
    if (cli === 'grok') {
        if (ctx?.pendingOutputChunk) {
            const chunk = ctx.pendingOutputChunk;
            ctx.pendingOutputChunk = '';
            return chunk;
        }
        if (event.type === 'text') return String(event.data || event.text || '');
        return '';
    }
    if (cli === 'cursor') {
        if (ctx?.pendingOutputChunk) {
            const chunk = ctx.pendingOutputChunk;
            ctx.pendingOutputChunk = '';
            return chunk;
        }
        return '';
    }
    // claude / claude-e: pendingOutputChunk holds live assistant-text deltas.
    //  - claude:   text_delta stream events (extractFromEvent) append here
    //  - claude-e: snapshot assistant records are diffed to deltas in handleClaudeEvent
    // Drain it so the append-only frontend streams text without duplication.
    if (cli === 'claude' || cli === 'claude-e') {
        if (ctx?.pendingOutputChunk) {
            const chunk = ctx.pendingOutputChunk;
            ctx.pendingOutputChunk = '';
            return chunk;
        }
        return '';
    }
    // [P0-1.5] Codex: emit agent_message text as live chunk
    if (cli === 'codex') {
        if (ctx?.pendingOutputChunk) {
            const chunk = ctx.pendingOutputChunk;
            ctx.pendingOutputChunk = '';
            return chunk;
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
            return String(event.item.text || '');
        }
        return '';
    }
    if (cli === 'copilot') {
        if (ctx?.pendingOutputChunk) {
            const chunk = ctx.pendingOutputChunk;
            ctx.pendingOutputChunk = '';
            return chunk;
        }
        if (typeof event.text === 'string') return event.text;
        if (typeof event.content === 'string') return event.content;
        if (event.type === 'assistant' && event.message?.content) {
            return event.message.content
                .filter((block) => block.type === 'text')
                .map((block) => String(block.text || ''))
                .join('');
        }
        return '';
    }
    return '';
}

export function extractFromEvent(cli: string, event: CliEventRecord, ctx: SpawnContext, agentLabel: string, empTag: Record<string, unknown> = {}) {
    // [P2-3.1] Claude system/init metadata: store model, tools, version
    if (isClaudeLikeCli(cli) && event.type === 'system') {
        if (event.model) ctx.model = event.model;
        if (!ctx.metadata) ctx.metadata = {};
        if (event.tools) ctx.metadata["tools"] = event.tools;
        if (event.mcp_servers) ctx.metadata["mcp_servers"] = event.mcp_servers;
        if (event.version) ctx.metadata["version"] = event.version;
    }

    // ── Claude stream buffer: thinking_delta + input_json_delta ──
    if (isClaudeLikeCli(cli) && event.type === 'stream_event') {
        const inner = event.event;

        // [P0-1.1] signature_delta: discard silently, do NOT trigger thinking flush.
        // [encrypted-thinking] Track signature length — used as evidence opus-4-7 reasoned server-side.
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'signature_delta') {
            const sig = inner.delta.signature;
            if (typeof sig === 'string') {
                ctx.claudeSignatureLen = (ctx.claudeSignatureLen || 0) + sig.length;
            }
            return;
        }

        // [P2-3.2] message_start: capture per-message input_tokens
        if (inner?.type === 'message_start' && inner.message?.usage) {
            if (!ctx.tokens) ctx.tokens = { input_tokens: 0, output_tokens: 0 };
            ctx.tokens["input_tokens"] = inner.message.usage.input_tokens ?? ctx.tokens["input_tokens"] ?? 0;
        }

        // Buffer thinking deltas
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta') {
            if (!ctx.claudeThinkingBuf) ctx.claudeThinkingBuf = '';
            ctx.claudeThinkingBuf += inner.delta.thinking || '';
            ctx.claudeThinkingHadDelta = true;
            return;
        }

        // Stream visible assistant text deltas live (the response prose). This is what
        // makes plain `claude` stream like claude-e; without it the text only surfaces
        // in the final complete `assistant` event as one dump. Use the RAW appender
        // (not appendAssistantTextSegment) — the segment formatter injects "\n- " bullets
        // between segments and would corrupt mid-token deltas. Set per-message
        // claudeStreamedText so handleClaudeEvent skips the duplicate complete-block
        // append (and resets it) without false-skipping a tool-only turn.
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
            const seg = appendAssistantRawText(ctx, inner.delta.text || '');
            if (seg) {
                // Arm the per-message guard only when real text flowed: an all-empty
                // text_delta run must NOT skip the complete-block fallback (else its
                // prose would be dropped).
                ctx.claudeStreamedText = true;
                ctx.pendingOutputChunk = (ctx.pendingOutputChunk || '') + seg;
            }
            return;
        }

        // [encrypted-thinking] Mark thinking block open so we can detect empty/encrypted case on stop.
        if (inner?.type === 'content_block_start' && inner.content_block?.type === 'thinking') {
            ctx.claudeThinkingBlockOpen = true;
            ctx.claudeThinkingHadDelta = false;
            ctx.claudeSignatureLen = 0;
        }

        // Buffer tool input JSON deltas
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'input_json_delta') {
            if (!ctx.claudeInputJsonBuf) ctx.claudeInputJsonBuf = '';
            ctx.claudeInputJsonBuf += inner.delta.partial_json || '';
            return;
        }

        // Track current tool name from content_block_start
        if (inner?.type === 'content_block_start' && inner.content_block?.type === 'tool_use') {
            ctx.claudeCurrentToolName = inner.content_block.name || 'tool';
        }

        // [P1-2.1] message_delta: accumulate output_tokens from streaming usage
        if (inner?.type === 'message_delta' && inner.usage) {
            if (inner.usage.output_tokens != null) {
                if (!ctx.tokens) ctx.tokens = { input_tokens: 0, output_tokens: 0 };
                ctx.tokens["output_tokens"] = inner.usage.output_tokens;
            }
        }

        // content_block_stop → flush both buffers
        if (inner?.type === 'content_block_stop') {
            // Flush thinking
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
                }
                ctx.claudeThinkingBuf = '';
            } else if (ctx.claudeThinkingBlockOpen && !ctx.claudeThinkingHadDelta) {
                // [encrypted-thinking] opus-4-7: thinking block opened but only signature streamed, no plaintext.
                // Surface a badge so users know the model reasoned server-side even though the content is withheld.
                const sigLen = ctx.claudeSignatureLen || 0;
                const detail = sigLen > 0
                    ? `server-side reasoning, plaintext withheld — signature ${sigLen}B`
                    : 'server-side reasoning, plaintext withheld';
                const tool = {
                    icon: '🔒',
                    label: 'encrypted thinking',
                    toolType: 'thinking' as const,
                    detail,
                };
                ctx.toolLog.push(tool);
                syncLiveTools(ctx);
                emitAgentTool(ctx, agentLabel, tool, empTag);
                pushTrace(ctx, `[${agentLabel || 'agent'}] 🔒 encrypted thinking (sig ${sigLen}B)`);
            }
            if (ctx.claudeThinkingBlockOpen) {
                ctx.claudeThinkingBlockOpen = false;
                ctx.claudeThinkingHadDelta = false;
                ctx.claudeSignatureLen = 0;
            }
            // Flush tool input → update existing tool label with detail
            if (ctx.claudeInputJsonBuf) {
                try {
                    const input = JSON.parse(ctx.claudeInputJsonBuf);
                    const toolName = ctx.claudeCurrentToolName || 'tool';
                    const detail = summarizeToolInput(toolName, input);  // full, no clip (max=0)
                    if (detail) {
                        // Find the last tool label for this tool and update its detail
                        const existing = [...ctx.toolLog].reverse().find(
                            (t: ToolEntry) => t.icon === '🔧' && t.label === toolName && !t.detail
                        );
                        if (existing) {
                            existing.detail = detail;
                            syncLiveTools(ctx);
                            // Re-broadcast with detail
                            emitAgentTool(ctx, agentLabel, existing, empTag);
                        }
                    }
                    if (toolName === 'ScheduleWakeup' && input.delaySeconds && input.prompt) {
                        const delay = Number(input.delaySeconds);
                        if (!Number.isFinite(delay) || delay <= 0) {
                            console.warn(`[jaw:wakeup] invalid delaySeconds: ${input.delaySeconds} — ignoring`);
                        } else {
                            if (ctx.scheduleWakeup) {
                                console.warn('[jaw:wakeup] multiple ScheduleWakeup calls — using latest');
                            }
                            const prompt = String(input.prompt).slice(0, 4000);
                            const reason = String(input.reason || 'scheduled wakeup').slice(0, 200);
                            ctx.scheduleWakeup = { delaySeconds: delay, prompt, reason };
                        }
                    }
                } catch { /* partial JSON */ }
                ctx.claudeInputJsonBuf = '';
                ctx.claudeCurrentToolName = '';
            }
        }

        // Non-block-stop but non-delta → flush thinking
        if (inner?.type !== 'content_block_stop' && ctx.claudeThinkingBuf) {
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
            }
            ctx.claudeThinkingBuf = '';
        }
    }

    const toolLabels = extractToolLabels(cli, event, ctx);
    for (const toolLabel of toolLabels) {
        // Dedupe: same logic as ACP path — skip already-seen tool keys
        const key = [
            toolLabel.icon,
            toolLabel.label,
            toolLabel.stepRef || '',
            toolLabel.status || '',
        ].join(':');
        if (ctx.seenToolKeys && ctx.seenToolKeys.has(key)) continue;
        if (ctx.seenToolKeys) ctx.seenToolKeys.add(key);

        // Resolve running → done/error: replace existing running entry in toolLog
        if (toolLabel.stepRef && (toolLabel.status === 'done' || toolLabel.status === 'error')) {
            const runIdx = ctx.toolLog.findIndex(
                (t: ToolEntry) => t.stepRef === toolLabel.stepRef && t.status === 'running'
            );
            if (runIdx !== -1) {
                ctx.toolLog[runIdx] = toolLabel;
                if (cli === 'opencode' && ctx.opencodePendingToolRefs) {
                    ctx.opencodePendingToolRefs = ctx.opencodePendingToolRefs.filter(ref => ref !== toolLabel.stepRef);
                }
                syncLiveTools(ctx);
                emitAgentTool(ctx, agentLabel, toolLabel, empTag);
                continue;
            }
        }

        ctx.toolLog.push(toolLabel);
        if (cli === 'opencode' && toolLabel.stepRef && (!toolLabel.status || toolLabel.status === 'running')) {
            if (!ctx.opencodePendingToolRefs) ctx.opencodePendingToolRefs = [];
            if (!ctx.opencodePendingToolRefs.includes(toolLabel.stepRef)) ctx.opencodePendingToolRefs.push(toolLabel.stepRef);
        }
        syncLiveTools(ctx);
        emitAgentTool(ctx, agentLabel, toolLabel, empTag);
    }

    if (isClaudeLikeCli(cli) && (event.type === 'assistant' || event.type === 'result')) {
        finalizeClaudeRateLimitOnResult(ctx, agentLabel, empTag, event);
    }

    if (isClaudeLikeCli(cli) && event.type === 'rate_limit_event') {
        handleClaudeRateLimitEvent(ctx, agentLabel, empTag, event);
        return;
    }

    switch (cli) {
        case 'claude':
        case 'claude-e':
            handleClaudeEvent(event, ctx, cli, agentLabel, empTag);
            break;
        case 'codex':
            handleCodexEvent(event, ctx, agentLabel, empTag);
            break;
        case 'cursor':
            handleCursorEvent(event, ctx, agentLabel, empTag);
            break;
        case 'grok':
            handleGrokEvent(event, ctx, agentLabel, empTag);
            break;
        case 'opencode':
            handleOpenCodeEvent(event, ctx, agentLabel, empTag);
            break;
    }
}
