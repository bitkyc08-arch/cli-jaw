// ─── Event Extraction (NDJSON parser) ────────────────

import { broadcast } from '../core/bus.js';
import type { SpawnContext } from '../types/agent.js';

/** Flush Claude-specific stream buffers (thinking + input_json).
 *  Call on stream close to avoid data loss if content_block_stop never arrives. */
export function flushClaudeBuffers(ctx: SpawnContext, agentLabel?: string) {
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
            broadcast('agent_tool', { agentId: agentLabel, ...tool });
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
                    (t: any) => t.icon === '🔧' && t.label === toolName && !t.detail
                );
                if (existing) {
                    existing.detail = detail;
                    broadcast('agent_tool', { agentId: agentLabel, ...existing });
                }
            }
        } catch { /* partial JSON — best effort */ }
        ctx.claudeInputJsonBuf = '';
        ctx.claudeCurrentToolName = '';
    }
}

function pushTrace(ctx: SpawnContext, line: string) {
    if (!ctx?.traceLog || !line) return;
    ctx.traceLog.push(line);
}

function logLine(line: string, ctx: SpawnContext) {
    console.log(line);
    pushTrace(ctx, line);
}

function toSingleLine(text: any) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function clipText(text: string, max: number) {
    if (!max || max < 1) return text;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildPreview(text: any, max = 80) {
    return clipText(toSingleLine(text), max);
}

function toIndentedPreview(text: any, max = 200) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const clipped = raw.length > max ? `${raw.slice(0, max)}…` : raw;
    return clipped.replace(/\n/g, '\n  ');
}

export function extractSessionId(cli: string, event: any) {
    switch (cli) {
        case 'claude': return event.type === 'system' ? event.session_id : null;
        case 'codex': return event.type === 'thread.started' ? event.thread_id : null;
        case 'gemini': return event.type === 'init' ? event.session_id : null;
        case 'opencode': return event.sessionID || null;
        default: return null;
    }
}

export function extractOutputChunk(cli: string, event: any): string {
    if (cli === 'gemini') {
        if (event.type === 'message' && event.role === 'assistant' && event.content) {
            return String(event.content);
        }
        return '';
    }
    if (cli === 'opencode') {
        if (event.type === 'text' && event.part?.text) {
            return String(event.part.text);
        }
        return '';
    }
    // [P0-1.5] Codex: emit agent_message text as live chunk
    if (cli === 'codex') {
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
            return String(event.item.text || '');
        }
        return '';
    }
    return '';
}

export function extractFromEvent(cli: string, event: any, ctx: SpawnContext, agentLabel: string) {
    // [P2-3.1] Claude system/init metadata: store model, tools, version
    if (cli === 'claude' && event.type === 'system') {
        if (event.model) ctx.model = event.model;
        if (!ctx.metadata) ctx.metadata = {};
        if (event.tools) ctx.metadata.tools = event.tools;
        if (event.mcp_servers) ctx.metadata.mcp_servers = event.mcp_servers;
        if (event.version) ctx.metadata.version = event.version;
    }

    // ── Claude stream buffer: thinking_delta + input_json_delta ──
    if (cli === 'claude' && event.type === 'stream_event') {
        const inner = event.event;

        // [P0-1.1] signature_delta: discard silently, do NOT trigger thinking flush
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'signature_delta') {
            return;
        }

        // [P2-3.2] message_start: capture per-message input_tokens
        if (inner?.type === 'message_start' && inner.message?.usage) {
            if (!ctx.tokens) ctx.tokens = { input_tokens: 0, output_tokens: 0 };
            ctx.tokens.input_tokens = inner.message.usage.input_tokens ?? ctx.tokens.input_tokens;
        }

        // Buffer thinking deltas
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta') {
            if (!ctx.claudeThinkingBuf) ctx.claudeThinkingBuf = '';
            ctx.claudeThinkingBuf += inner.delta.thinking || '';
            return;
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
                ctx.tokens.output_tokens = inner.usage.output_tokens;
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
                    broadcast('agent_tool', { agentId: agentLabel, ...tool });
                }
                ctx.claudeThinkingBuf = '';
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
                            (t: any) => t.icon === '🔧' && t.label === toolName && !t.detail
                        );
                        if (existing) {
                            existing.detail = detail;
                            // Re-broadcast with detail
                            broadcast('agent_tool', { agentId: agentLabel, ...existing });
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
                broadcast('agent_tool', { agentId: agentLabel, ...tool });
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
                (t: any) => t.stepRef === toolLabel.stepRef && t.status === 'running'
            );
            if (runIdx !== -1) {
                ctx.toolLog[runIdx] = toolLabel;
                broadcast('agent_tool', { agentId: agentLabel, ...toolLabel });
                continue;
            }
        }

        ctx.toolLog.push(toolLabel);
        broadcast('agent_tool', { agentId: agentLabel, ...toolLabel });
    }

    switch (cli) {
        case 'claude':
            if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.type === 'text') ctx.fullText += block.text;
                }
            } else if (event.type === 'result') {
                ctx.cost = event.total_cost_usd;
                ctx.turns = event.num_turns;
                ctx.duration = event.duration_ms;
                if (event.session_id) ctx.sessionId = event.session_id;
                // [P1-2.3] Store modelUsage for per-model token/cache breakdown
                if (event.usage) {
                    ctx.tokens = {
                        input_tokens: event.usage.input_tokens ?? 0,
                        output_tokens: event.usage.output_tokens ?? ctx.tokens?.output_tokens ?? 0,
                        cache_read: event.usage.cache_read_input_tokens ?? 0,
                        cache_creation: event.usage.cache_creation_input_tokens ?? 0,
                    };
                }
            // [P1-2.2] rate_limit_event: emit quota warning
            } else if (event.type === 'rate_limit_event') {
                const msg = event.message || event.reason || 'rate limited';
                const tool = { icon: '⚠️', label: buildPreview(msg, 60), toolType: 'tool' as const, status: 'warning' };
                ctx.toolLog.push(tool);
                broadcast('agent_tool', { agentId: agentLabel, ...tool });
            // [P0-1.2] Parse user/tool_result feedback (stdout/stderr/is_error)
            } else if (event.type === 'user' && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const existing = [...ctx.toolLog].reverse().find(
                            (t: any) => t.stepRef === `claude:tooluse:${block.tool_use_id}`
                        );
                        if (existing) {
                            existing.status = block.is_error ? 'error' : 'done';
                            existing.icon = block.is_error ? '❌' : '✅';
                            const resultText = extractText(block.content);
                            if (resultText) existing.detail = (existing.detail || '') + '\n' + resultText;
                            broadcast('agent_tool', { agentId: agentLabel, ...existing });
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
                if (event.item?.type === 'agent_message') ctx.fullText += event.item.text || '';
                if (event.item?.type === 'collab_tool_call') {
                    ctx.hasActiveSubAgent = (event.item.status === 'in_progress');
                }
            } else if (event.type === 'turn.completed' && event.usage) {
                // [P2-3.6] Include cached_input_tokens in token storage
                ctx.tokens = {
                    input_tokens: event.usage.input_tokens ?? 0,
                    output_tokens: event.usage.output_tokens ?? 0,
                    cached_input_tokens: event.usage.cached_input_tokens ?? 0,
                };
            }
            break;
        case 'gemini':
            // [P2-3.7] Store model from init event
            if (event.type === 'init' && event.model) {
                ctx.model = event.model;
            }
            if (event.type === 'message' && event.role === 'assistant') {
                // [P2-3.8] Track delta vs full message (pre/post tool text)
                if (event.delta) {
                    pushTrace(ctx, `[${agentLabel}] gemini delta text`);
                }
                ctx.fullText += event.content || '';
            } else if (event.type === 'result') {
                ctx.duration = event.stats?.duration_ms;
                ctx.turns = event.stats?.tool_calls;
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
            // [P2-3.10] step_start: emit UI indicator for step boundary
            if (event.type === 'step_start') {
                const model = event.part?.model || event.model;
                if (model) ctx.model = model;
                pushTrace(ctx, `[${agentLabel}] opencode step_start${model ? ` model=${model}` : ''}`);
            }
            if (event.type === 'text' && event.part?.text) {
                ctx.fullText += event.part.text;
            } else if (event.type === 'step_finish' && event.part) {
                ctx.sessionId = event.sessionID;
                // [P0-1.7] Accumulate tokens across steps (not overwrite)
                if (event.part.tokens) {
                    if (!ctx.tokens) ctx.tokens = { input_tokens: 0, output_tokens: 0, cached_read: 0, cached_write: 0 };
                    ctx.tokens.input_tokens += event.part.tokens.input ?? 0;
                    ctx.tokens.output_tokens += event.part.tokens.output ?? 0;
                    // [P0-1.8] Cache token accumulation
                    if (event.part.tokens.cache) {
                        ctx.tokens.cached_read += event.part.tokens.cache.read ?? 0;
                        ctx.tokens.cached_write += event.part.tokens.cache.write ?? 0;
                    }
                    // [P2-3.13] Accumulate total tokens across steps
                    if (event.part.tokens.total != null) {
                        ctx.tokens.total_tokens = (ctx.tokens.total_tokens ?? 0) + event.part.tokens.total;
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
                // [P2-3.12] Store step timing
                if (event.part.time) {
                    if (!ctx.metadata) ctx.metadata = {};
                    ctx.metadata.lastStepTime = event.part.time;
                }
            }
            break;
    }
}

export function logEventSummary(agentLabel: string, cli: string, event: any, ctx: any = null) {
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

function makeClaudeToolKey(event: any, label: any) {
    const idx = event.event?.index;
    if (idx !== undefined && idx !== null) return `claude:idx:${idx}:${label.icon}:${label.label}`;
    const msgId = event.message?.id || '';
    if (msgId) return `claude:msg:${msgId}:${label.icon}:${label.label}`;
    return `claude:type:${event.type}:${label.icon}:${label.label}`;
}

function pushToolLabel(labels: any[], label: any, cli: string, event: any, ctx: any) {
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
function extractToolLabels(cli: string, event: any, ctx: SpawnContext | null = null) {
    const item = event.item || event.part || event;
    const labels = [];

    if (cli === 'codex' && event.type === 'item.completed' && item) {
        if (item.type === 'web_search') {
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
        if (item.type === 'reasoning') {
            const detail = String(item.text || '').replace(/\*+/g, '').trim();
            labels.push({ icon: '💭', label: buildPreview(detail, 60) || 'thinking...', toolType: 'thinking', detail });
        }
        if (item.type === 'command_execution') {
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
            const name = item.name || 'sub-agent';
            const status = item.status || '';
            if (status === 'in_progress') {
                labels.push({ icon: '🔀', label: `waiting: ${name}`, toolType: 'tool' });
            } else {
                labels.push({ icon: '✅', label: `sub-agent: ${name}`, toolType: 'tool', status: 'done' });
            }
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
            if (status === 'compacting' || subtype === 'compacting') {
                pushToolLabel(labels, { icon: '🗜️', label: 'compacting...', toolType: 'tool' }, cli, event, ctx);
            }
            if (status === 'compact_boundary' || subtype === 'compact_boundary' || event.compact_boundary === true) {
                pushToolLabel(labels, { icon: '✅', label: 'conversation compacted', toolType: 'tool', status: 'done' }, cli, event, ctx);
            }
        }
        if (event.type === 'stream_event' && event.event?.type === 'content_block_start') {
            if (ctx) ctx.hasClaudeStreamEvents = true;
            const cb = event.event.content_block;
            if (cb?.type === 'tool_use') pushToolLabel(labels, { icon: '🔧', label: cb.name || 'tool', toolType: 'tool', stepRef: cb.id ? `claude:tooluse:${cb.id}` : undefined }, cli, event, ctx);
            // thinking: don't emit placeholder — buffer in extractFromEvent will emit with real content
        }
        if (event.type === 'assistant' && event.message?.content && !ctx?.hasClaudeStreamEvents) {
            for (const block of event.message.content) {
                if (block.type === 'tool_use') pushToolLabel(labels, { icon: '🔧', label: block.name || 'tool', toolType: 'tool', stepRef: block.id ? `claude:tooluse:${block.id}` : undefined }, cli, event, ctx);
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
        if (event.type === 'tool_use' && event.part) {
            const ref = event.part.callID
                ? `opencode:call:${event.part.callID}`
                : `opencode:tool:${event.part.tool || 'tool'}`;
            const detail = summarizeToolInput(event.part.tool || '', event.part.state?.input || {}, 0)
                || String(event.part.state?.output || '').trim();
            // [P0-1.9] Single label per event: icon reflects actual status
            const isDone = event.part.state?.status === 'completed';
            // [P1-2.6] Check exit code from state.metadata
            const exitCode = event.part.state?.metadata?.exit;
            const isFailed = exitCode != null && exitCode !== 0;
            const displayLabel = event.part.state?.title || event.part.tool || 'tool';
            labels.push({
                icon: isFailed ? '❌' : (isDone ? '✅' : '🔧'),
                label: displayLabel,
                toolType: 'tool',
                stepRef: ref,
                detail,
                status: isFailed ? 'error' : (isDone ? 'done' : undefined),
                ...(exitCode != null ? { exitCode } : {}),
            });
        }
        if (event.type === 'tool_result' && event.part) {
            const ref = event.part.callID
                ? `opencode:call:${event.part.callID}`
                : `opencode:tool:${event.part.tool || 'tool'}`;
            labels.push({ icon: '✅', label: event.part.tool || 'done', toolType: 'tool', stepRef: ref, status: 'done' });
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
export function summarizeToolInput(toolName: string, input: any, max = 0): string {
    if (!input) return '';
    if (typeof input !== 'object') return max ? clipText(String(input), max) : String(input);
    const s = (v: any) => (typeof v === 'string' ? v : v != null ? String(v) : '');
    const name = (toolName || '').toLowerCase();
    let result = '';
    if (name.includes('bash') || name.includes('terminal') || name === 'execute_command')
        result = s(input.command || input.cmd);
    else if (name.includes('read') || name === 'read_file' || name === 'view') {
        const fullPath = s(input.path || input.file_path || input.filename);
        result = max ? (fullPath.split('/').pop() || fullPath) : fullPath;
    } else if (name.includes('write') || name.includes('edit') || name === 'create_file') {
        const fullPath = s(input.path || input.file_path);
        result = max ? (fullPath.split('/').pop() || fullPath) : fullPath;
    } else if (name.includes('search') || name.includes('grep') || name === 'codebase_search')
        result = s(input.query || input.pattern || input.search_query);
    else if (name.includes('web') || name === 'web_search')
        result = s(input.query);
    // Fallback: show first meaningful key-value if specific extraction yielded nothing
    if (!result) {
        try { result = JSON.stringify(input); } catch { /* ignore */ }
    }
    return max ? clipText(result, max) : result;
}

// Backward-compat: return first label or null
export function extractToolLabel(cli: string, event: any) {
    const labels = extractToolLabels(cli, event);
    return labels.length ? labels[0] : null;
}

// Test-only helpers (keep parser logic private for runtime flow)
export function extractToolLabelsForTest(cli: string, event: any, ctx: any = {}) {
    return extractToolLabels(cli, event, ctx);
}

export function makeClaudeToolKeyForTest(event: any, label: any) {
    return makeClaudeToolKey(event, label);
}

// ─── ACP session/update → cli-jaw internal event ────────────────
// Official ACP schema: update.sessionUpdate is the discriminator field.
// Types: agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan

function extractText(content: any) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(c => c.type === 'text')
            .map(c => c.text || '')
            .join('');
    }
    // Single content object: {type: 'text', text: '...'}
    if (content && typeof content === 'object' && content.type === 'text') {
        return content.text || '';
    }
    return '';
}

export function extractFromAcpUpdate(params: any) {
    const update = params?.update;
    if (!update) return null;

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
            const toolName = update.name || 'tool';
            const fullInput = update.input != null
                ? (typeof update.input === 'object' ? JSON.stringify(update.input, null, 2) : String(update.input))
                : '';
            // [P1-2.10] Semantic icon from tool kind/title
            const kindIcon = toolKindIcon(update.kind);
            const displayLabel = update.title || toolName;
            // [P0-1.11] Use toolCallId for unique stepRef
            return {
                tool: {
                    icon: kindIcon || '🔧',
                    label: displayLabel,
                    toolType: 'tool',
                    detail: fullInput,
                    stepRef: `acp:callid:${update.toolCallId || update.id || toolName}`,
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
            const mapped = statusMap[update.status] || { icon: '❔', status: update.status || 'unknown' };
            // [P1-2.9] Extract content from tool result
            const resultText = update.content ? extractText(update.content) : '';
            return {
                tool: {
                    icon: mapped.icon,
                    label: update.name || update.id || 'done',
                    toolType: 'tool',
                    stepRef: `acp:callid:${update.toolCallId || update.id || update.name || 'done'}`,
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
            if (process.env.DEBUG) {
                console.log(`[acp] unknown sessionUpdate: ${type}`, JSON.stringify(update).slice(0, 100));
            }
            return null;
    }
}
