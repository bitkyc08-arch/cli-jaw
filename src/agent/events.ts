// ─── Event Extraction (NDJSON parser) ────────────────

import { broadcast } from '../core/bus.js';
import { stripUndefined } from '../core/strip-undefined.js';
import type { SpawnContext, ToolEntry } from '../types/agent.js';
import {
    asCliEventArray,
    asCliEventRecord,
    fieldNumber,
    fieldString,
    isCliEventRecord,
    type AcpSubagentEvent,
    type AcpUpdateParams,
    type CliEventRecord,
    type ExtractedEventResult,
} from '../types/cli-events.js';
import { appendLiveRunText, replaceLiveRunTools, appendLiveRunTool } from './live-run-state.js';

function liveScopeOf(ctx: SpawnContext): string | null {
    return ctx.liveScope ?? null;
}

function syncLiveTools(ctx: SpawnContext): void {
    const scope = liveScopeOf(ctx);
    if (scope) replaceLiveRunTools(scope, ctx.toolLog);
    if (ctx.parentLiveScope) {
        const synced = ctx._parentSyncedCount || 0;
        const total = ctx.toolLog.length;
        for (let i = synced; i < total; i++) {
            appendLiveRunTool(ctx.parentLiveScope, { ...ctx.toolLog[i], isEmployee: true });
        }
        ctx._parentSyncedCount = total;
    }
}

/** Flush Claude-specific stream buffers (thinking + input_json).
 *  Call on stream close to avoid data loss if content_block_stop never arrives. */
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
            broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag });
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
                    broadcast('agent_tool', { agentId: agentLabel, ...existing, ...empTag });
                }
            }
        } catch { /* partial JSON — best effort */ }
        ctx.claudeInputJsonBuf = '';
        ctx.claudeCurrentToolName = '';
    }
}

function pushTrace(ctx: SpawnContext | null | undefined, line: string) {
    if (!ctx?.traceLog || !line) return;
    ctx.traceLog.push(line);
}

function logLine(line: string, ctx: SpawnContext | null | undefined) {
    console.log(line);
    pushTrace(ctx, line);
}

function toSingleLine(text: unknown) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function clipText(text: string, max: number) {
    if (!max || max < 1) return text;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildPreview(text: unknown, max = 80) {
    return clipText(toSingleLine(text), max);
}

function appendDetail(...parts: Array<string | null | undefined>): string {
    return parts.map(p => String(p || '').trim()).filter(Boolean).join('\n');
}

function formatJsonDetail(label: string, value: unknown): string {
    if (value == null) return '';
    try {
        return `${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`;
    } catch {
        return `${label}: ${String(value)}`;
    }
}

function formatAssistantTextSegment(ctx: SpawnContext, text: unknown): string {
    const raw = String(text || '');
    if (!raw) return '';
    if (!ctx.outputTextStarted) {
        ctx.outputTextStarted = true;
        return raw;
    }
    if (/\s$/.test(ctx.fullText) || /^\s/.test(raw) || /^[,.;:!?)]/.test(raw) || /^-\S/.test(raw)) return raw;
    return raw.startsWith('- ') || raw.startsWith('* ')
        ? `\n${raw}`
        : `\n- ${raw}`;
}

function appendAssistantTextSegment(ctx: SpawnContext, text: unknown): string {
    const segment = formatAssistantTextSegment(ctx, text);
    if (!segment) return '';
    ctx.fullText += segment;
    return segment;
}

function appendGeminiAssistantTextSegment(ctx: SpawnContext, text: unknown, isDelta: boolean): string {
    const raw = String(text || '');
    if (!raw) return '';
    if (isDelta && ctx.geminiDeltaActive) {
        ctx.fullText += raw;
        return raw;
    }
    const segment = appendAssistantTextSegment(ctx, raw);
    ctx.geminiDeltaActive = isDelta;
    return segment;
}

function emitGeminiThought(
    ctx: SpawnContext,
    agentLabel: string,
    empTag: Record<string, unknown>,
    text: unknown,
): void {
    const detail = String(text || '').trim();
    if (!detail) return;
    const tool = {
        icon: '💭',
        label: buildPreview(detail, 80) || 'thinking...',
        toolType: 'thinking' as const,
        detail,
    };
    ctx.toolLog.push(tool);
    syncLiveTools(ctx);
    broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag });
}

function extractGeminiThoughtText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(isCliEventRecord)
            .filter((p) => p.type === 'thought' || p.type === 'thinking')
            .map((p) => String(p.thought || p.text || p.content || ''))
            .join('');
    }
    if (isCliEventRecord(content)) {
        return String(content.thought || content.text || content.content || '');
    }
    return '';
}

function toIndentedPreview(text: unknown, max = 200) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const clipped = raw.length > max ? `${raw.slice(0, max)}…` : raw;
    return clipped.replace(/\n/g, '\n  ');
}

function isOpencodeToolFailure(part: CliEventRecord): boolean {
    const exitCode = part?.state?.metadata?.["exit"];
    if (exitCode != null && exitCode !== 0) return true;
    const status = String(part?.state?.status || '').toLowerCase();
    return status === 'error'
        || status === 'failed'
        || status === 'denied'
        || status === 'cancelled';
}

function cleanOpencodeTaskResult(output: unknown): string {
    const raw = String(output || '').trim();
    if (!raw) return '';
    const match = raw.match(/<task_result>([\s\S]*?)<\/task_result>/);
    return (match?.[1] || raw).trim();
}

function formatOpenCodeTaskDetail(part: CliEventRecord): string {
    const state = part?.state || {};
    const input = state.input || {};
    const meta = state.metadata || {};
    const modelInfo = asCliEventRecord(meta.model);
    const model = meta.model
        ? [modelInfo["providerID"], modelInfo["modelID"]].filter(Boolean).join('/')
        : '';
    return appendDetail(
        input.prompt ? `prompt: ${clipText(String(input.prompt), 300)}` : '',
        model ? `model: ${model}` : '',
        meta["sessionId"] ? `child_session: ${meta["sessionId"]}` : '',
        cleanOpencodeTaskResult(state.output) ? `result: ${cleanOpencodeTaskResult(state.output)}` : '',
    );
}

function finalizeOpencodePendingTools(
    ctx: SpawnContext,
    agentLabel: string,
    empTag: Record<string, unknown>,
): void {
    const pendingRefs = ctx.opencodePendingToolRefs || [];
    if (!pendingRefs.length) return;
    const failed = !!ctx.opencodeHadToolErrorInStep;
    for (const ref of pendingRefs) {
        const existing = [...ctx.toolLog].reverse().find(
            (t: ToolEntry) => t.stepRef === ref && (!t.status || t.status === 'running')
        );
        if (!existing) continue;
        existing.status = failed ? 'error' : 'done';
        existing.icon = failed ? '❌' : '✅';
        syncLiveTools(ctx);
        broadcast('agent_tool', { agentId: agentLabel, ...existing, ...empTag });
    }
}

export function extractSessionId(cli: string, event: CliEventRecord): string | null {
    switch (cli) {
        case 'claude': return event.type === 'system' ? event.session_id ?? null : null;
        case 'codex': return event.type === 'thread.started' ? event.thread_id ?? null : null;
        case 'gemini': return event.type === 'init' ? event.session_id ?? null : null;
        case 'opencode': return event.sessionID ?? null;
        default: return null;
    }
}

export function extractOutputChunk(cli: string, event: CliEventRecord, ctx?: SpawnContext): string {
    if (cli === 'gemini') {
        if (ctx?.pendingOutputChunk) {
            const chunk = ctx.pendingOutputChunk;
            ctx.pendingOutputChunk = '';
            return chunk;
        }
        // [#107] Skip thought/thinking events (future-proofing for when Gemini CLI adds them)
        if (event.type === 'thought' || event.thought === true) return '';
        if (event.type === 'message' && event.role === 'assistant' && event.content) {
            // Skip message events with thought content parts (ACP path)
            if (Array.isArray(event.content)) {
                const textParts = asCliEventArray(event.content).filter((p) => p.type === 'text');
                return textParts.map((p) => String(p.text || '')).join('');
            }
            return String(event.content);
        }
        return '';
    }
    if (cli === 'opencode') {
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
    return '';
}

export function extractFromEvent(cli: string, event: CliEventRecord, ctx: SpawnContext, agentLabel: string, empTag: Record<string, unknown> = {}) {
    // [P2-3.1] Claude system/init metadata: store model, tools, version
    if (cli === 'claude' && event.type === 'system') {
        if (event.model) ctx.model = event.model;
        if (!ctx.metadata) ctx.metadata = {};
        if (event.tools) ctx.metadata["tools"] = event.tools;
        if (event.mcp_servers) ctx.metadata["mcp_servers"] = event.mcp_servers;
        if (event.version) ctx.metadata["version"] = event.version;
    }

    // ── Claude stream buffer: thinking_delta + input_json_delta ──
    if (cli === 'claude' && event.type === 'stream_event') {
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
                    broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag });
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
                broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag });
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
                            broadcast('agent_tool', { agentId: agentLabel, ...existing, ...empTag });
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
                broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag });
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
                broadcast('agent_tool', { agentId: agentLabel, ...toolLabel, ...empTag });
                continue;
            }
        }

        ctx.toolLog.push(toolLabel);
        if (cli === 'opencode' && toolLabel.stepRef && (!toolLabel.status || toolLabel.status === 'running')) {
            if (!ctx.opencodePendingToolRefs) ctx.opencodePendingToolRefs = [];
            if (!ctx.opencodePendingToolRefs.includes(toolLabel.stepRef)) ctx.opencodePendingToolRefs.push(toolLabel.stepRef);
        }
        syncLiveTools(ctx);
        broadcast('agent_tool', { agentId: agentLabel, ...toolLabel, ...empTag });
    }

    switch (cli) {
        case 'claude':
            if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.type === 'text') {
                        const segment = appendAssistantTextSegment(ctx, block.text);
                        const scope = liveScopeOf(ctx);
                        if (scope) appendLiveRunText(scope, segment);
                    }
                }
            } else if (event.type === 'result') {
                ctx.cost = event.total_cost_usd ?? null;
                ctx.turns = event.num_turns ?? null;
                ctx.duration = event.duration_ms ?? null;
                if (event.session_id) ctx.sessionId = event.session_id;
                // [P1-2.3] Store modelUsage for per-model token/cache breakdown
                if (event.usage) {
                    ctx.tokens = {
                        input_tokens: event.usage.input_tokens ?? 0,
                        output_tokens: event.usage.output_tokens ?? ctx.tokens?.["output_tokens"] ?? 0,
                        cache_read: event.usage.cache_read_input_tokens ?? 0,
                        cache_creation: event.usage.cache_creation_input_tokens ?? 0,
                    };
                }
            // [P1-2.2] rate_limit_event: emit quota warning
            } else if (event.type === 'rate_limit_event') {
                const msg = event.message || event.reason || 'rate limited';
                const tool = { icon: '⚠️', label: buildPreview(msg, 60), toolType: 'tool' as const, status: 'warning' };
                ctx.toolLog.push(tool);
                syncLiveTools(ctx);
                broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag });
            // [P0-1.2] Parse user/tool_result feedback (stdout/stderr/is_error)
            } else if (event.type === 'user' && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const existing = [...ctx.toolLog].reverse().find(
                            (t: ToolEntry) => t.stepRef === `claude:tooluse:${block.tool_use_id}`
                        );
                        if (existing) {
                            existing.status = block["is_error"] ? 'error' : 'done';
                            existing.icon = block["is_error"] ? '❌' : '✅';
                            const resultText = extractText(block.content);
                            if (resultText) existing.detail = (existing.detail || '') + '\n' + resultText;
                            syncLiveTools(ctx);
                            broadcast('agent_tool', { agentId: agentLabel, ...existing, ...empTag });
                        }
                    }
                }
            }
            break;
        case 'codex':
            // [P2-3.4] turn.started: mark turn boundary
            if (event.type === 'turn.started') {
                pushTrace(ctx, `[${agentLabel}] codex turn started`);
            }
            if (event.type === 'item.completed') {
                if (event.item?.type === 'agent_message') {
                    const text = String(event.item.text || '');
                    const segment = appendAssistantTextSegment(ctx, text);
                    ctx.pendingOutputChunk = (ctx.pendingOutputChunk || '') + segment;
                    // [spark-visibility] Spark and other lightweight codex models often
                    // emit only an agent_message (no reasoning/command_execution), so the
                    // toolLog would be empty and the run would be invisible in the UI.
                    // Surface the final message as a 💬 entry so every codex run shows at
                    // least one toolLog step. Dedup is handled by seenToolKeys via stepRef.
                    if (segment.trim()) {
                        const itemId = event.item.id || '';
                        const tool = stripUndefined({
                            icon: '💬',
                            label: buildPreview(segment, 80) || 'message',
                            toolType: 'tool' as const,
                            detail: segment,
                            stepRef: itemId ? `codex:item:${itemId}` : undefined,
                            status: 'done' as const,
                        });
                        const key = tool.stepRef || `codex:msg:${ctx.toolLog.length}:${segment.slice(0, 30)}`;
                        if (!ctx.seenToolKeys || !ctx.seenToolKeys.has(key)) {
                            if (ctx.seenToolKeys) ctx.seenToolKeys.add(key);
                            ctx.toolLog.push(tool);
                            syncLiveTools(ctx);
                            broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag });
                        }
                    }
                }
                if (event.item?.type === 'command_execution') {
                    const cmd = (event.item.command || '').slice(0, 120);
                    const exitCode = event.item.exit_code ?? '?';
                    const itemId = event.item.id || '';
                    const doneRef = itemId ? `codex:cmd:${itemId}` : `codex:cmd:done:${ctx.toolLog.length}`;
                    const doneTool = {
                        icon: '✅',
                        label: 'done',
                        toolType: 'tool' as const,
                        stepRef: doneRef,
                        status: (exitCode === 0 ? 'done' : 'error') as 'done' | 'error',
                    };
                    const doneKey = `${doneTool.icon}:${doneTool.label}:${doneRef}:${doneTool.status}`;
                    if (!ctx.seenToolKeys?.has(doneKey)) {
                        ctx.seenToolKeys?.add(doneKey);
                        ctx.toolLog.push(doneTool);
                        syncLiveTools(ctx);
                        broadcast('agent_tool', { agentId: agentLabel, ...doneTool, ...empTag });
                    }
                }
                if (event.item?.type === 'collab_tool_call'
                    && ['spawn_agent', 'wait'].includes(String(event.item.tool || event.item.name || ''))) {
                    ctx.hasActiveSubAgent = false;
                }
            } else if (event.type === 'item.started') {
                if (event.item?.type === 'command_execution') {
                    const cmd = (event.item.command || '').slice(0, 120);
                    const itemId = event.item.id || '';
                    const tool = stripUndefined({
                        icon: '⚡',
                        label: buildPreview(cmd, 80) || 'command',
                        toolType: 'tool' as const,
                        detail: cmd,
                        stepRef: itemId ? `codex:cmd:${itemId}` : undefined,
                    });
                    const key = `${tool.icon}:${tool.label}:${tool.stepRef || ''}:`;
                    if (!ctx.seenToolKeys?.has(key)) {
                        ctx.seenToolKeys?.add(key);
                        ctx.toolLog.push(tool);
                        syncLiveTools(ctx);
                        broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag });
                    }
                }
                if (event.item?.type === 'collab_tool_call'
                    && ['spawn_agent', 'wait'].includes(String(event.item.tool || event.item.name || ''))) {
                    ctx.hasActiveSubAgent = true;
                }
            } else if (event.type === 'turn.completed' && event.usage) {
                // [P2-3.6] Include cached_input_tokens in token storage
                ctx.tokens = {
                    input_tokens: event.usage.input_tokens ?? 0,
                    output_tokens: event.usage.output_tokens ?? 0,
                    cached_input_tokens: event.usage.cached_input_tokens ?? 0,
                };
            } else if (event.type === 'error' || event.type === 'turn.failed') {
                // codex emits {type:"error"} or {type:"turn.failed", error:{message}} for API failures
                // (e.g. "The 'gpt-5.3-spark' model is not supported when using Codex with a ChatGPT account.")
                const raw = event.error?.message ?? event.message ?? '';
                let msg = String(raw);
                try {
                    const parsed = JSON.parse(msg);
                    msg = parsed?.error?.message || parsed?.message || msg;
                } catch { /* raw string is fine */ }
                const tool = {
                    icon: '❌',
                    label: buildPreview(msg, 80) || 'codex error',
                    toolType: 'tool' as const,
                    detail: msg,
                    status: 'error' as const,
                };
                ctx.toolLog.push(tool);
                syncLiveTools(ctx);
                broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag });
                pushTrace(ctx, `[${agentLabel}] codex ${event.type}: ${msg.slice(0, 200)}`);
            }
            break;
        case 'gemini':
            // [P2-3.7] Store model from init event
            if (event.type === 'init' && event.model) {
                ctx.model = event.model;
            }
            if (event.type === 'tool_use' || event.type === 'tool_result') {
                ctx.geminiDeltaActive = false;
            }
            // [#107/#121] Thought content never enters fullText; optional visibility uses process steps.
            if (event.type === 'thought' || event.thought === true) {
                if (ctx.showReasoning) {
                    emitGeminiThought(ctx, agentLabel, empTag, event.content || event.thought || event.text);
                    pushTrace(ctx, `[${agentLabel}] gemini thought (visible)`);
                } else {
                    pushTrace(ctx, `[${agentLabel}] gemini thought (hidden)`);
                }
                break;
            }
            if (event.type === 'message' && event.role === 'assistant') {
                // [#107] If content is an array (ACP-style), extract only text parts
                if (Array.isArray(event.content)) {
                    if (ctx.showReasoning) {
                        emitGeminiThought(ctx, agentLabel, empTag, extractGeminiThoughtText(event.content));
                    }
                    const textOnly = event.content
                        .filter(isCliEventRecord)
                        .filter((p) => p.type === 'text')
                        .map((p) => String(p.text || ''))
                        .join('');
                    if (textOnly) {
                        const segment = appendGeminiAssistantTextSegment(ctx, textOnly, !!event.delta);
                        ctx.pendingOutputChunk = (ctx.pendingOutputChunk || '') + segment;
                        pushTrace(ctx, `[${agentLabel}] gemini text (filtered)`);
                    }
                    break;
                }
                // [P2-3.8] Track delta vs full message (pre/post tool text)
                if (event.delta) {
                    pushTrace(ctx, `[${agentLabel}] gemini delta text`);
                }
                const segment = appendGeminiAssistantTextSegment(ctx, event.content || '', !!event.delta);
                ctx.pendingOutputChunk = (ctx.pendingOutputChunk || '') + segment;
            } else if (event.type === 'result') {
                ctx.geminiDeltaActive = false;
                ctx.geminiResultSeen = true;
                ctx.duration = event.stats?.duration_ms ?? null;
                ctx.turns = event.stats?.tool_calls ?? null;
                // [P0-1.6] Store Gemini token stats
                if (event.stats) {
                    ctx.tokens = {
                        input_tokens: event.stats.input_tokens ?? event.stats.inputTokens ?? 0,
                        output_tokens: event.stats.output_tokens ?? event.stats.outputTokens ?? 0,
                        cached_tokens: event.stats.cached ?? 0,
                        total_tokens: event.stats.total_tokens ?? event.stats.totalTokens ?? 0,
                    };
                }
            }
            break;
        case 'opencode':
            if (typeof event.type === 'string' && ![
                'step_start',
                'text',
                'tool_use',
                'step_finish',
                'reasoning',
                'error',
            ].includes(event.type)) {
                pushTrace(ctx, `[${agentLabel}] opencode unknown event type=${event.type}`);
            }
            // [P2-3.10] step_start: emit UI indicator for step boundary
            if (event.type === 'step_start') {
                const model = event.part?.model || event.model;
                if (model) ctx.model = model;
                ctx.opencodePreToolText = '';
                ctx.opencodePostToolText = '';
                ctx.opencodeSawToolInStep = false;
                ctx.opencodeHadToolErrorInStep = false;
                ctx.opencodePendingToolRefs = [];
                ctx.opencodeStepThinkingToolEmitted = false;
                pushTrace(ctx, `[${agentLabel}] opencode step_start${model ? ` model=${model}` : ''}`);
            }
            if (event.type === 'reasoning') {
                const text = String(event.part?.text || event.text || '').trim();
                if (text) {
                    const thinkingTool = {
                        icon: '💭',
                        label: buildPreview(text, 80) || 'thinking...',
                        toolType: 'thinking' as const,
                        detail: text,
                        status: 'done' as const,
                    };
                    ctx.toolLog.push(thinkingTool);
                    syncLiveTools(ctx);
                    broadcast('agent_tool', { agentId: agentLabel, ...thinkingTool, ...empTag });
                    ctx.opencodeStepThinkingToolEmitted = true;
                    pushTrace(ctx, `[${agentLabel}] opencode reasoning (${text.length} chars)`);
                }
            } else if (event.type === 'text' && event.part?.text) {
                if (ctx.opencodeSawToolInStep) {
                    ctx.opencodePostToolText = (ctx.opencodePostToolText || '') + String(event.part.text);
                } else {
                    ctx.opencodePreToolText = (ctx.opencodePreToolText || '') + String(event.part.text);
                }
            } else if (event.type === 'tool_use') {
                ctx.opencodeSawToolInStep = true;
                if (isOpencodeToolFailure(asCliEventRecord(event.part))) ctx.opencodeHadToolErrorInStep = true;
            } else if (event.type === 'step_finish' && event.part) {
                ctx.sessionId = event.sessionID ?? null;
                // [P0-1.7] Accumulate tokens across steps (not overwrite)
                if (event.part.tokens) {
                    if (!ctx.tokens) ctx.tokens = { input_tokens: 0, output_tokens: 0, cached_read: 0, cached_write: 0 };
                    ctx.tokens["input_tokens"] = (ctx.tokens["input_tokens"] ?? 0) + (event.part.tokens.input ?? 0);
                    ctx.tokens["output_tokens"] = (ctx.tokens["output_tokens"] ?? 0) + (event.part.tokens.output ?? 0);
                    // [P0-1.8] Cache token accumulation
                    if (event.part.tokens.cache) {
                        ctx.tokens["cached_read"] = (ctx.tokens["cached_read"] ?? 0) + (event.part.tokens.cache.read ?? 0);
                        ctx.tokens["cached_write"] = (ctx.tokens["cached_write"] ?? 0) + (event.part.tokens.cache.write ?? 0);
                    }
                    // [P2-3.13] Accumulate total tokens across steps
                    if (event.part.tokens.total != null) {
                        ctx.tokens["total_tokens"] = (ctx.tokens["total_tokens"] ?? 0) + event.part.tokens.total;
                    }
                    if (event.part.tokens.reasoning != null) {
                        ctx.tokens["reasoning_tokens"] = (ctx.tokens["reasoning_tokens"] ?? 0) + event.part.tokens.reasoning;
                    }
                }
                // Accumulate cost across steps
                if (event.part.cost != null) {
                    ctx.cost = (ctx.cost ?? 0) + event.part.cost;
                }
                // [P2-3.11] Store finish reason (tool-calls vs stop)
                if (event.part.reason) {
                    ctx.finishReason = event.part.reason;
                }
                const preToolText = ctx.opencodePreToolText || '';
                const postToolText = ctx.opencodePostToolText || '';
                const textToCommit = event.part.reason === 'tool-calls'
                    ? postToolText
                    : `${preToolText}${postToolText}`;
                const suppressedText = event.part.reason === 'tool-calls' ? preToolText : '';
                if (textToCommit) {
                    const segment = appendAssistantTextSegment(ctx, textToCommit);
                    ctx.pendingOutputChunk = (ctx.pendingOutputChunk || '') + segment;
                }
                if (suppressedText) {
                    const thinkingTool = {
                        icon: '💭',
                        label: buildPreview(suppressedText, 80) || 'thinking...',
                        toolType: 'thinking' as const,
                        detail: suppressedText,
                    };
                    ctx.toolLog.push(thinkingTool);
                    syncLiveTools(ctx);
                    broadcast('agent_tool', { agentId: agentLabel, ...thinkingTool, ...empTag });
                    ctx.opencodeStepThinkingToolEmitted = true;
                    pushTrace(ctx, `[${agentLabel}] opencode pre-tool intermediate text (${suppressedText.length} chars)`);
                }
                const reasoningTokens = Number(event.part.tokens?.reasoning || 0);
                if (reasoningTokens > 0 && !ctx.opencodeStepThinkingToolEmitted) {
                    const reason = String(event.part.reason || 'unknown');
                    const thinkingTool = {
                        icon: '💭',
                        label: `reasoning used: ${reasoningTokens.toLocaleString()} tokens`,
                        toolType: 'thinking' as const,
                        detail: [
                            `OpenCode reported ${reasoningTokens} reasoning tokens for this step, but did not emit plaintext reasoning content.`,
                            `reason=${reason}`,
                        ].join('\n'),
                        status: 'done' as const,
                    };
                    ctx.toolLog.push(thinkingTool);
                    syncLiveTools(ctx);
                    broadcast('agent_tool', { agentId: agentLabel, ...thinkingTool, ...empTag });
                    ctx.opencodeStepThinkingToolEmitted = true;
                    pushTrace(ctx, `[${agentLabel}] opencode reasoning token fallback (${reasoningTokens} tokens)`);
                }
                finalizeOpencodePendingTools(ctx, agentLabel, empTag);
                ctx.opencodePreToolText = '';
                ctx.opencodePostToolText = '';
                ctx.opencodeSawToolInStep = false;
                ctx.opencodeHadToolErrorInStep = false;
                ctx.opencodePendingToolRefs = [];
                ctx.opencodeStepThinkingToolEmitted = false;
                // [P2-3.12] Store step timing
                if (event.part["time"]) {
                    if (!ctx.metadata) ctx.metadata = {};
                    ctx.metadata["lastStepTime"] = event.part["time"];
                }
            }
            break;
    }
}

export function logEventSummary(agentLabel: string, cli: string, event: CliEventRecord, ctx: SpawnContext | null = null) {
    const item = event.item || event.part || {};

    if (cli === 'codex') {
        if (event.type === 'item.started' && item.type === 'command_execution') {
            logLine(`[${agentLabel}] cmd: ${(item.command || '').slice(0, 160)}`, ctx);
            return;
        }
        if (event.type === 'item.completed') {
            if (item.type === 'reasoning') {
                logLine(`[${agentLabel}] reasoning: ${toSingleLine(item.text).slice(0, 200)}`, ctx);
                return;
            }
            if (item.type === 'agent_message') {
                logLine(`[${agentLabel}] agent: ${toSingleLine(item.text).slice(0, 220)}`, ctx);
                return;
            }
            if (item.type === 'command_execution') {
                const cmd = (item.command || '').slice(0, 120);
                const exitCode = item.exit_code ?? '?';
                logLine(`[${agentLabel}] cmd: ${cmd} → exit ${exitCode}`, ctx);
                const outPreview = toIndentedPreview(item.aggregated_output, 260);
                if (outPreview) logLine(`  ${outPreview}`, ctx);
                return;
            }
            if (item.type === 'web_search') {
                const query = item.query || item.action?.query || '';
                logLine(`[${agentLabel}] search: ${toSingleLine(query).slice(0, 200)}`, ctx);
                return;
            }
        }
        if (event.type === 'turn.completed' && event.usage) {
            const u = event.usage;
            logLine(
                `[${agentLabel}] tokens: in=${(u.input_tokens ?? 0).toLocaleString()} `
                + `(cached=${(u.cached_input_tokens ?? 0).toLocaleString()}) `
                + `out=${(u.output_tokens ?? 0).toLocaleString()}`,
                ctx
            );
            return;
        }
    }

    if (cli === 'claude') {
        // Real-time streaming events (--include-partial-messages)
        if (event.type === 'stream_event' && event.event) {
            const inner = event.event;
            if (inner.type === 'content_block_start' && inner.content_block) {
                const cb = inner.content_block;
                if (cb.type === 'tool_use') {
                    logLine(`[${agentLabel}] 🔧 ${cb.name || 'tool'}`, ctx);
                } else if (cb.type === 'thinking') {
                    logLine(`[${agentLabel}] 💭 thinking...`, ctx);
                }
            }
            return;
        }
        if (event.type === 'assistant' && event.message?.content) {
            if (ctx?.hasClaudeStreamEvents) return;
            for (const block of event.message.content) {
                if (block.type === 'tool_use') {
                    logLine(`[${agentLabel}] tool: ${block.name}`, ctx);
                } else if (block.type === 'thinking') {
                    logLine(`[${agentLabel}] thinking: ${toSingleLine(block.thinking).slice(0, 160)}`, ctx);
                }
            }
            return;
        }
        if (event.type === 'result') {
            const cost = Number(event.total_cost_usd || 0).toFixed(4);
            const turns = event.num_turns ?? 0;
            const dur = ((event.duration_ms || 0) / 1000).toFixed(1);
            logLine(`[${agentLabel}] result: $${cost} / ${turns} turns / ${dur}s`, ctx);
            return;
        }
    }

    // [P2-3.9] Gemini-specific logEventSummary
    if (cli === 'gemini') {
        if (event.type === 'init') {
            logLine(`[${agentLabel}] gemini init model=${event.model || '?'}`, ctx);
            return;
        }
        if (event.type === 'tool_use') {
            logLine(`[${agentLabel}] 🔧 ${event.tool_name || 'tool'}${event.parameters?.command ? `: ${String(event.parameters.command).slice(0, 120)}` : ''}`, ctx);
            return;
        }
        if (event.type === 'tool_result') {
            logLine(`[${agentLabel}] tool ${event.status || 'done'}: ${(event.tool_name || '')}`, ctx);
            return;
        }
        if (event.type === 'result') {
            const dur = ((event.stats?.duration_ms || 0) / 1000).toFixed(1);
            const calls = event.stats?.tool_calls ?? 0;
            logLine(`[${agentLabel}] result: ${calls} tool calls / ${dur}s`, ctx);
            return;
        }
    }

    if (event.type !== 'system') {
        logLine(`[${agentLabel}] ${cli}:${event.type}`, ctx);
    }
}

function makeClaudeToolKey(event: CliEventRecord, label: ToolEntry) {
    // Prefer the unique tool_use id (carried in stepRef) so multi-turn streams with
    // matching tool names across distinct messages don't collide on the per-message index.
    if (label.stepRef) return `claude:ref:${label.stepRef}:${label.icon}:${label.label}`;
    const msgId = event.message?.id || '';
    const idx = event.event?.["index"];
    if (msgId && idx !== undefined && idx !== null) return `claude:msg:${msgId}:${idx}:${label.icon}:${label.label}`;
    if (idx !== undefined && idx !== null) return `claude:idx:${idx}:${label.icon}:${label.label}`;
    if (msgId) return `claude:msg:${msgId}:${label.icon}:${label.label}`;
    return `claude:type:${event.type}:${label.icon}:${label.label}`;
}

function pushToolLabel(labels: ToolEntry[], label: ToolEntry, cli: string, event: CliEventRecord, ctx: SpawnContext | null) {
    if (cli !== 'claude' || !ctx?.seenToolKeys) {
        labels.push(label);
        return;
    }
    const key = makeClaudeToolKey(event, label);
    if (ctx.seenToolKeys.has(key)) return;
    ctx.seenToolKeys.add(key);
    labels.push(label);
}

// Returns array of tool labels (supports multiple blocks per event)
function extractToolLabels(cli: string, event: CliEventRecord, ctx: SpawnContext | null = null): ToolEntry[] {
    const item = event.item || event.part || event;
    const labels: ToolEntry[] = [];

    if (cli === 'codex' && (event.type === 'item.started' || event.type === 'item.completed') && item) {
        if (event.type === 'item.completed' && item.type === 'web_search') {
            const action = item.action?.type || '';
            if (action === 'search') {
                const query = item.query || item.action?.query || 'search';
                labels.push({ icon: '🔍', label: buildPreview(query, 60), toolType: 'search', detail: query });
            } else if (action === 'open_page') {
                const url = item.action?.url || '';
                try {
                    labels.push({ icon: '🌐', label: new URL(url).hostname, toolType: 'search', detail: url });
                } catch {
                    labels.push({ icon: '🌐', label: 'page', toolType: 'search', detail: url });
                }
            } else {
                const query = item.query || 'web';
                labels.push({ icon: '🔍', label: buildPreview(query, 60), toolType: 'search', detail: query });
            }
        }
        if (event.type === 'item.completed' && item.type === 'reasoning') {
            const detail = String(item.text || '').replace(/\*+/g, '').trim();
            labels.push({ icon: '💭', label: buildPreview(detail, 60) || 'thinking...', toolType: 'thinking', detail });
        }
        if (event.type === 'item.completed' && item.type === 'command_execution') {
            const command = String(item.command || 'exec');
            const output = item.aggregated_output ? String(item.aggregated_output) : '';
            const detail = output ? `$ ${command}\n${output}` : command;
            // [P0-1.4] Use item.id for unique stepRef (not command string)
            const ref = `codex:item:${item.id || command}`;
            // [P1-2.4] Include exit_code in label status
            const exitCode = item.exit_code;
            const failed = exitCode != null && exitCode !== 0;
            labels.push({
                icon: failed ? '❌' : '⚡',
                label: buildPreview(command, 40) || 'exec',
                toolType: 'tool',
                detail,
                stepRef: ref,
                status: failed ? 'error' : 'done',
                ...(exitCode != null ? { exitCode } : {}),
            });
        }
        if (item.type === 'collab_tool_call') {
            const tool = String(item.tool || item.name || 'subagent');
            const ref = `codex:collab:${item.id || tool}`;
            const isStarted = event.type === 'item.started' || item.status === 'in_progress';
            const receiverIds = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.join(', ') : '';
            const detail = appendDetail(
                item["sender_thread_id"] ? `sender: ${item["sender_thread_id"]}` : '',
                receiverIds ? `receivers: ${receiverIds}` : '',
                formatJsonDetail('agents', item.agents_states),
                item.prompt ? `prompt: ${clipText(String(item.prompt), 300)}` : '',
            );
            labels.push({
                icon: isStarted ? '🤖' : '✅',
                label: isStarted ? `${tool}...` : `${tool} done`,
                toolType: 'subagent',
                stepRef: ref,
                status: isStarted ? 'running' : 'done',
                ...(detail ? { detail } : {}),
            });
        }
    }

    // [P0-1.3] Codex item.started: emit running label (paired with 1.4 stepRef)
    if (cli === 'codex' && event.type === 'item.started' && item) {
        if (item.type === 'command_execution') {
            const command = String(item.command || 'exec');
            const ref = `codex:item:${item.id || command}`;
            labels.push({ icon: '🔧', label: buildPreview(command, 40) || 'exec', toolType: 'tool', stepRef: ref, status: 'running' });
        }
    }

    if (cli === 'claude') {
        if (event.type === 'system') {
            const status = String(event.status || '');
            const subtype = String(event.subtype || event.event || '');
            if (subtype === 'task_started') {
                const taskId = event.task_id || event.id || event.tool_use_id || 'unknown';
                const description = event.description || event.input?.description || event.task_type || 'subagent';
                const detail = appendDetail(
                    event.task_type ? `type: ${event.task_type}` : '',
                    event.tool_use_id ? `tool_use_id: ${event.tool_use_id}` : '',
                    event.prompt ? `prompt: ${clipText(String(event.prompt), 300)}` : '',
                );
                pushToolLabel(labels, {
                    icon: '🤖',
                    label: `subagent: ${buildPreview(description, 60)}`,
                    toolType: 'subagent',
                    stepRef: `claude:task:${taskId}`,
                    status: 'running',
                    ...(detail ? { detail } : {}),
                }, cli, event, ctx);
            }
            if (subtype === 'task_notification') {
                const taskId = event.task_id || event.id || event.tool_use_id || 'unknown';
                const rawStatus = String(event.status || 'completed');
                const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(rawStatus);
                const description = event.description || event.summary || event.task_type || 'subagent';
                const usage = event.usage || {};
                const usageDetail = [
                    usage.total_tokens != null ? `${usage.total_tokens} tok` : '',
                    usage["tool_uses"] != null ? `${usage["tool_uses"]} tools` : '',
                    usage.duration_ms != null ? `${(Number(usage.duration_ms) / 1000).toFixed(1)}s` : '',
                ].filter(Boolean).join(' · ');
                const detail = appendDetail(
                    event.summary ? `summary: ${event.summary}` : '',
                    event.output_file ? `output_file: ${event.output_file}` : '',
                    usageDetail,
                );
                pushToolLabel(labels, {
                    icon: failed ? '❌' : '✅',
                    label: `subagent: ${buildPreview(description, 60)}`,
                    toolType: 'subagent',
                    stepRef: `claude:task:${taskId}`,
                    status: failed ? 'error' : 'done',
                    ...(detail ? { detail } : {}),
                }, cli, event, ctx);
            }
            if (status === 'compacting' || subtype === 'compacting') {
                pushToolLabel(labels, { icon: '🗜️', label: 'compacting...', toolType: 'tool' }, cli, event, ctx);
            }
            if (status === 'compact_boundary' || subtype === 'compact_boundary' || event.compact_boundary === true) {
                pushToolLabel(labels, { icon: '✅', label: 'conversation compacted', toolType: 'tool', status: 'done' }, cli, event, ctx);
                if (ctx) ctx.cliNativeCompactDetected = true;
            }
        }
        if (event.type === 'stream_event' && event.event?.type === 'content_block_start') {
            if (ctx) ctx.hasClaudeStreamEvents = true;
            const cb = event.event.content_block;
            if (cb?.type === 'tool_use') {
                const isAgent = cb.name === 'Agent';
                pushToolLabel(labels, stripUndefined({
                    icon: isAgent ? '🤖' : '🔧',
                    label: isAgent ? 'subagent' : (cb.name || 'tool'),
                    toolType: isAgent ? 'subagent' : 'tool',
                    stepRef: cb.id ? `claude:tooluse:${cb.id}` : undefined,
                }), cli, event, ctx);
            }
            // thinking: don't emit placeholder — buffer in extractFromEvent will emit with real content
        }
        if (event.type === 'assistant' && event.message?.content && !ctx?.hasClaudeStreamEvents) {
            for (const block of event.message.content) {
                if (block.type === 'tool_use') {
                    const isAgent = block.name === 'Agent';
                    const description = block.input?.description || block.input?.["subagent_type"] || 'subagent';
                    pushToolLabel(labels, stripUndefined({
                        icon: isAgent ? '🤖' : '🔧',
                        label: isAgent ? `subagent: ${buildPreview(description, 60)}` : (block.name || 'tool'),
                        toolType: isAgent ? 'subagent' : 'tool',
                        stepRef: block.id ? `claude:tooluse:${block.id}` : undefined,
                        ...(isAgent && block.input?.prompt ? { detail: `prompt: ${clipText(String(block.input.prompt), 300)}` } : {}),
                    }), cli, event, ctx);
                }
                if (block.type === 'thinking') {
                    const text = (block.thinking || '').trim();
                    pushToolLabel(labels, { icon: '💭', label: buildPreview(text, 80) || 'thinking...', toolType: 'thinking', detail: text }, cli, event, ctx);
                }
            }
        }
    }

    if (cli === 'gemini') {
        if (event.type === 'tool_use') {
            const detail = event.parameters?.command || summarizeToolInput(event.tool_name || '', event.parameters || {}, 0);
            const suffix = event.parameters?.command ? `: ${buildPreview(event.parameters.command, 40)}` : '';
            const ref = event.tool_id
                ? `gemini:toolid:${event.tool_id}`
                : `gemini:tool:${event.tool_name || 'tool'}`;
            labels.push({ icon: '🔧', label: `${event.tool_name || 'tool'}${suffix}`, toolType: 'tool', detail, stepRef: ref });
        }
        if (event.type === 'tool_result') {
            const ref = event.tool_id
                ? `gemini:toolid:${event.tool_id}`
                : `gemini:tool:${event.tool_name || 'tool'}`;
            // [P1-2.5] Include tool result output in detail
            const output = event.output ? buildPreview(event.output, 200) : '';
            labels.push({
                icon: event.status === 'success' ? '✅' : '❌',
                label: `${event.status || 'done'}`,
                toolType: 'tool',
                stepRef: ref,
                status: event.status === 'success' ? 'done' : 'error',
                ...(output ? { detail: output } : {}),
            });
        }
    }

    if (cli === 'opencode') {
        const isTaskToolUse = event.type === 'tool_use' && event.part?.tool === 'task';
        const isTaskToolResult = event.type === 'tool_result'
            && event.part?.callID
            && ctx?.opencodeTaskCallIds?.has(event.part.callID);

        if (isTaskToolUse || isTaskToolResult) {
            const part = asCliEventRecord(event.part);
            const callID = part.callID || part.id || 'task';
            if (isTaskToolResult && !part.state) return labels;
            if (isTaskToolUse && ctx) {
                if (!ctx.opencodeTaskCallIds) ctx.opencodeTaskCallIds = new Set();
                ctx.opencodeTaskCallIds.add(callID);
            }
            const state = part.state || {};
            const input = state.input || {};
            const status = String(state.status || (event.type === 'tool_result' ? 'completed' : 'completed'));
            const failed = isOpencodeToolFailure(part) || ['error', 'failed', 'cancelled', 'canceled'].includes(status);
            const subagentType = input["subagent_type"] || 'general';
            const description = input.description || state.title || part.tool || 'task';
            const resultText = event.type === 'tool_result'
                ? extractText(part.content || part.output || state.output)
                : '';
            const detail = appendDetail(
                formatOpenCodeTaskDetail(part),
                resultText ? `result: ${resultText}` : '',
            );
            labels.push({
                icon: failed ? '❌' : (status === 'running' || status === 'in_progress' ? '🤖' : '✅'),
                label: `subagent[${subagentType}]: ${buildPreview(description, 60)}`,
                toolType: 'subagent',
                stepRef: `opencode:call:${callID}`,
                ...(detail ? { detail } : {}),
                status: failed ? 'error' : (status === 'running' || status === 'in_progress' ? 'running' : 'done'),
            });
            return labels;
        }

        if (event.type === 'tool_use' && event.part) {
            const ref = event.part.callID
                ? `opencode:call:${event.part.callID}`
                : `opencode:tool:${event.part.tool || 'tool'}`;
            const detail = summarizeToolInput(event.part.tool || '', event.part.state?.input || {}, 0)
                || String(event.part.state?.output || '').trim();
            const isDone = event.part.state?.status === 'completed';
            const exitCode = fieldNumber(event.part.state?.metadata?.["exit"]);
            const isFailed = isOpencodeToolFailure(event.part);
            const displayLabel = fieldString(event.part.state?.title || event.part.tool, 'tool');
            labels.push(stripUndefined({
                icon: isFailed ? '❌' : (isDone ? '✅' : '🔧'),
                label: displayLabel,
                toolType: 'tool',
                stepRef: ref,
                detail,
                status: isFailed ? 'error' : (isDone ? 'done' : undefined),
                ...(exitCode != null ? { exitCode } : {}),
            }));
        }
        if (event.type === 'tool_result' && event.part) {
            const ref = event.part.callID
                ? `opencode:call:${event.part.callID}`
                : `opencode:tool:${event.part.tool || 'tool'}`;
            labels.push({ icon: '✅', label: fieldString(event.part.tool, 'done'), toolType: 'tool', stepRef: ref, status: 'done' });
        }
    }

    return labels;
}

/** [P1-2.10] Map Copilot ACP tool kind to semantic icon */
function toolKindIcon(kind: string | undefined): string {
    if (!kind) return '';
    const map: Record<string, string> = {
        read: '📖', view: '📖', file_read: '📖',
        write: '✏️', edit: '✏️', file_write: '✏️', create: '✏️',
        execute: '⚡', command: '⚡', bash: '⚡', terminal: '⚡',
        search: '🔍', grep: '🔍', find: '🔍',
        web: '🌐', browse: '🌐', fetch: '🌐',
    };
    return map[kind.toLowerCase()] || '';
}

/** Summarise a tool's input into a short one-liner for the ProcessBlock UI. */
export function summarizeToolInput(toolName: string, input: unknown, max = 0): string {
    if (!input) return '';
    if (typeof input !== 'object') return max ? clipText(String(input), max) : String(input);
    const data = asCliEventRecord(input);
    const s = (v: unknown) => (typeof v === 'string' ? v : v != null ? String(v) : '');
    const name = (toolName || '').toLowerCase();
    let result = '';
    if (name.includes('bash') || name.includes('terminal') || name === 'execute_command')
        result = s(data.command || data.cmd);
    else if (name.includes('read') || name === 'read_file' || name === 'view') {
        const fullPath = s(data["path"] || data["file_path"] || data["filename"]);
        result = max ? (fullPath.split('/').pop() || fullPath) : fullPath;
    } else if (name.includes('write') || name.includes('edit') || name === 'create_file') {
        const fullPath = s(data["path"] || data["file_path"]);
        result = max ? (fullPath.split('/').pop() || fullPath) : fullPath;
    } else if (name.includes('search') || name.includes('grep') || name === 'codebase_search')
        result = s(data.query || data["pattern"] || data["search_query"]);
    else if (name.includes('web') || name === 'web_search')
        result = s(data.query);
    // Fallback: show first meaningful key-value if specific extraction yielded nothing
    if (!result) {
        try { result = JSON.stringify(input); } catch { /* ignore */ }
    }
    return max ? clipText(result, max) : result;
}

// Backward-compat: return first label or null
export function extractToolLabel(cli: string, event: CliEventRecord): ToolEntry | null {
    const labels = extractToolLabels(cli, event);
    return labels[0] ?? null;
}

// Test-only helpers (keep parser logic private for runtime flow)
export function extractToolLabelsForTest(cli: string, event: CliEventRecord, ctx: SpawnContext = {
    fullText: '',
    traceLog: [],
    toolLog: [],
    seenToolKeys: new Set<string>(),
    hasClaudeStreamEvents: false,
    sessionId: null,
    cost: null,
    turns: null,
    duration: null,
    tokens: null,
    stderrBuf: '',
}) {
    return extractToolLabels(cli, event, ctx);
}

export function makeClaudeToolKeyForTest(event: CliEventRecord, label: ToolEntry) {
    return makeClaudeToolKey(event, label);
}

// ─── ACP session/update → cli-jaw internal event ────────────────
// Official ACP schema: update.sessionUpdate is the discriminator field.
// Types: agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan

function extractText(content: unknown) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(isCliEventRecord)
            .filter(c => c.type === 'text')
            .map(c => c.text || '')
            .join('');
    }
    // Single content object: {type: 'text', text: '...'}
    if (isCliEventRecord(content) && content.type === 'text') {
        return content.text || '';
    }
    return '';
}

export function extractFromAcpUpdate(params: AcpUpdateParams | unknown, ctx: SpawnContext | null = null): ExtractedEventResult {
    const envelope = asCliEventRecord(params);
    const update = asCliEventRecord(envelope["update"]);
    if (!isCliEventRecord(envelope["update"])) return null;

    const type = update.sessionUpdate;

    switch (type) {
        case 'agent_thought_chunk': {
            const text = extractText(update.content);
            return {
                tool: {
                    icon: '💭',
                    label: buildPreview(text, 60) || 'thinking...',
                    toolType: 'thinking',
                    detail: text,
                },
            };
        }

        case 'tool_call': {
            const toolName = fieldString(update.name, 'tool');
            const rawInput = asCliEventRecord(update.rawInput || update.input);
            const isSubagentTask = rawInput?.["agent_type"] === 'task' || rawInput?.["agentType"] === 'task';
            const displayLabel = isSubagentTask
                ? `subagent: ${update.title || rawInput.description || rawInput.name || toolName}`
                : update.title || toolName;
            if (isSubagentTask && update.toolCallId && ctx) {
                if (!ctx.acpSubagentToolCallIds) ctx.acpSubagentToolCallIds = new Set();
                if (!ctx.acpSubagentLabels) ctx.acpSubagentLabels = new Map();
                ctx.acpSubagentToolCallIds.add(update.toolCallId);
                ctx.acpSubagentLabels.set(update.toolCallId, fieldString(displayLabel));
            }
            const fullInput = update.input != null
                ? (typeof update.input === 'object' ? JSON.stringify(update.input, null, 2) : String(update.input))
                : update.rawInput != null
                    ? (typeof update.rawInput === 'object' ? JSON.stringify(update.rawInput, null, 2) : String(update.rawInput))
                : '';
            // [P1-2.10] Semantic icon from tool kind/title
            const kindIcon = toolKindIcon(fieldString(update["kind"]) || undefined);
            // [P0-1.11] Use toolCallId for unique stepRef
            return {
                tool: {
                    icon: isSubagentTask ? '🤖' : (kindIcon || '🔧'),
                    label: fieldString(displayLabel),
                    toolType: isSubagentTask ? 'subagent' : 'tool',
                    detail: fullInput,
                    stepRef: `acp:callid:${update.toolCallId || update.id || toolName}`,
                    ...(isSubagentTask ? { status: 'running' } : {}),
                },
            };
        }

        // [P0-1.10] Map actual status instead of hardcoding ✅/done
        case 'tool_call_update': {
            const statusMap: Record<string, { icon: string; status: string }> = {
                pending: { icon: '⏳', status: 'pending' },
                running: { icon: '🔧', status: 'running' },
                in_progress: { icon: '🔧', status: 'running' },
                completed: { icon: '✅', status: 'done' },
                failed: { icon: '❌', status: 'error' },
            };
            const statusKey = fieldString(update.status);
            const mapped = statusMap[statusKey] || { icon: '❔', status: statusKey || 'unknown' };
            const toolCallId = fieldString(update.toolCallId || update.id || update.name, 'done');
            const isSubagentTask = !!(toolCallId && ctx?.acpSubagentToolCallIds?.has(toolCallId));
            const subagentLabel = toolCallId ? ctx?.acpSubagentLabels?.get(toolCallId) : '';
            // [P1-2.9] Extract content from tool result
            const resultText = update.content ? extractText(update.content) : '';
            return {
                tool: {
                    icon: mapped.icon,
                    label: isSubagentTask ? (subagentLabel || `subagent: ${update.name || update.title || 'task'}`) : fieldString(update.name || update.id, 'done'),
                    toolType: isSubagentTask ? 'subagent' : 'tool',
                    stepRef: `acp:callid:${toolCallId}`,
                    status: mapped.status,
                    ...(resultText ? { detail: buildPreview(resultText, 200) } : {}),
                },
            };
        }

        case 'agent_message_chunk': {
            const text = extractText(update.content);
            return { text };
        }

        case 'plan':
            return {
                tool: {
                    icon: '📝',
                    label: 'planning...',
                    toolType: 'thinking',
                },
            };

        // [P2-3.14] session/cancelled → UI notification
        case 'session_cancelled':
        case 'cancelled': {
            const reason = update.reason || update.message || 'session cancelled';
            return {
                tool: {
                    icon: '⏹️',
                    label: buildPreview(reason, 60),
                    toolType: 'tool',
                    status: 'cancelled',
                },
            };
        }

        // [P2-3.15] session/request_permission → audit record
        case 'request_permission': {
            const perm = update.permission || update.scope || 'unknown';
            return {
                tool: {
                    icon: '🔐',
                    label: `permission: ${buildPreview(perm, 50)}`,
                    toolType: 'tool',
                    status: 'pending',
                },
            };
        }

        default:
            if (process.env["DEBUG"]) {
                console.log(`[acp] unknown sessionUpdate: ${type}`, JSON.stringify(update).slice(0, 100));
            }
            return null;
    }
}

export function extractFromAcpSubagent(event: AcpSubagentEvent | unknown): ExtractedEventResult {
    const record = asCliEventRecord(event);
    if (!record.type || !String(record.type).startsWith('subagent.')) return null;
    const data = asCliEventRecord(record["data"]);
    const display = fieldString(data.agentDisplayName || data.agentName, 'subagent');
    const agentName = fieldString(data.agentName, display);

    switch (record.type) {
        case 'subagent.selected':
            return {
                tool: {
                    icon: '🎯',
                    label: `selected: ${display}`,
                    toolType: 'subagent',
                    stepRef: `acp:subagent:selection:${agentName}`,
                    status: 'done',
                    detail: `tools: ${Array.isArray(data.tools) ? data.tools.join(', ') : 'all'}`,
                },
            };
        case 'subagent.deselected':
            return {
                tool: {
                    icon: '⏭',
                    label: `deselected: ${display}`,
                    toolType: 'subagent',
                    stepRef: `acp:subagent:selection:${agentName}`,
                    status: 'done',
                },
            };
        case 'subagent.started': {
            const agentDescription = fieldString(data["agentDescription"]);
            return {
                tool: {
                    icon: '🤖',
                    label: `subagent: ${display}`,
                    toolType: 'subagent',
                    stepRef: `acp:subagent:${data.toolCallId || agentName}`,
                    status: 'running',
                    ...(agentDescription ? { detail: agentDescription } : {}),
                },
            };
        }
        case 'subagent.completed':
            return {
                tool: {
                    icon: '✅',
                    label: `subagent: ${display}`,
                    toolType: 'subagent',
                    stepRef: `acp:subagent:${data.toolCallId || agentName}`,
                    status: 'done',
                },
            };
        case 'subagent.failed':
            return {
                tool: {
                    icon: '❌',
                    label: `subagent: ${display}`,
                    toolType: 'subagent',
                    stepRef: `acp:subagent:${data.toolCallId || agentName}`,
                    status: 'error',
                    detail: `error: ${data.error || ''}`,
                },
            };
        default:
            return null;
    }
}
