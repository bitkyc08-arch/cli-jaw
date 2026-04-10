// ─── Event Extraction (NDJSON parser) ────────────────

import { broadcast } from '../core/bus.js';
import type { SpawnContext } from '../types/agent.js';

/** Flush Claude-specific stream buffers (thinking + input_json).
 *  Call on stream close to avoid data loss if content_block_stop never arrives. */
export function flushClaudeBuffers(ctx: SpawnContext, agentLabel?: string) {
    if (ctx.claudeThinkingBuf) {
        const merged = ctx.claudeThinkingBuf.trim();
        if (merged) {
            pushTrace(ctx, `[${agentLabel || 'agent'}] 💭 ${merged.slice(0, 200)}`);
        }
        ctx.claudeThinkingBuf = '';
    }
    if (ctx.claudeInputJsonBuf) {
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

export function extractFromEvent(cli: string, event: any, ctx: SpawnContext, agentLabel: string) {
    // ── Claude stream buffer: thinking_delta + input_json_delta ──
    if (cli === 'claude' && event.type === 'stream_event') {
        const inner = event.event;

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
        const key = `${toolLabel.icon}:${toolLabel.label}`;
        if (ctx.seenToolKeys && ctx.seenToolKeys.has(key)) continue;
        if (ctx.seenToolKeys) ctx.seenToolKeys.add(key);
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
            }
            break;
        case 'codex':
            if (event.type === 'item.completed') {
                if (event.item?.type === 'agent_message') ctx.fullText += event.item.text || '';
            } else if (event.type === 'turn.completed' && event.usage) {
                ctx.tokens = event.usage;
            }
            break;
        case 'gemini':
            if (event.type === 'message' && event.role === 'assistant') {
                ctx.fullText += event.content || '';
            } else if (event.type === 'result') {
                ctx.duration = event.stats?.duration_ms;
                ctx.turns = event.stats?.tool_calls;
            }
            break;
        case 'opencode':
            if (event.type === 'text' && event.part?.text) {
                ctx.fullText += event.part.text;
            } else if (event.type === 'step_finish' && event.part) {
                ctx.sessionId = event.sessionID;
                if (event.part.tokens) {
                    ctx.tokens = { input_tokens: event.part.tokens.input, output_tokens: event.part.tokens.output };
                }
                if (event.part.cost) ctx.cost = event.part.cost;
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
            labels.push({ icon: '⚡', label: buildPreview(command, 40) || 'exec', toolType: 'tool', detail, stepRef: `codex:cmd:${command}` });
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
            if (cb?.type === 'tool_use') pushToolLabel(labels, { icon: '🔧', label: cb.name || 'tool', toolType: 'tool' }, cli, event, ctx);
            // thinking: don't emit placeholder — buffer in extractFromEvent will emit with real content
        }
        if (event.type === 'assistant' && event.message?.content && !ctx?.hasClaudeStreamEvents) {
            for (const block of event.message.content) {
                if (block.type === 'tool_use') pushToolLabel(labels, { icon: '🔧', label: block.name || 'tool', toolType: 'tool' }, cli, event, ctx);
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
            const ref = `gemini:tool:${event.tool_name || 'tool'}`;
            labels.push({ icon: '🔧', label: `${event.tool_name || 'tool'}${suffix}`, toolType: 'tool', detail, stepRef: ref });
        }
        if (event.type === 'tool_result') {
            const ref = `gemini:tool:${event.tool_name || 'tool'}`;
            labels.push({ icon: event.status === 'success' ? '✅' : '❌', label: `${event.status || 'done'}`, toolType: 'tool', stepRef: ref, status: event.status === 'success' ? 'done' : 'error' });
        }
    }

    if (cli === 'opencode') {
        if (event.type === 'tool_use' && event.part) {
            const ref = `opencode:tool:${event.part.tool || 'tool'}`;
            labels.push({ icon: '🔧', label: event.part.tool || 'tool', toolType: 'tool', stepRef: ref });
        }
        if (event.type === 'tool_result' && event.part) {
            const ref = `opencode:tool:${event.part.tool || 'tool'}`;
            labels.push({ icon: '✅', label: event.part.tool || 'done', toolType: 'tool', stepRef: ref, status: 'done' });
        }
    }

    return labels;
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
    else if (name.includes('read') || name === 'read_file' || name === 'view')
        result = s(input.path || input.file_path || input.filename).split('/').pop() || s(input.path);
    else if (name.includes('write') || name.includes('edit') || name === 'create_file')
        result = s(input.path || input.file_path).split('/').pop() || s(input.path);
    else if (name.includes('search') || name.includes('grep') || name === 'codebase_search')
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
            return {
                tool: {
                    icon: '🔧',
                    label: toolName,
                    toolType: 'tool',
                    detail: fullInput,
                    stepRef: `acp:tool:${toolName}`,
                },
            };
        }

        case 'tool_call_update':
            return {
                tool: {
                    icon: '✅',
                    label: update.name || update.id || 'done',
                    toolType: 'tool',
                    stepRef: `acp:tool:${update.name || update.id || 'done'}`,
                    status: 'done',
                },
            };

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

        default:
            if (process.env.DEBUG) {
                console.log(`[acp] unknown sessionUpdate: ${type}`, JSON.stringify(update).slice(0, 100));
            }
            return null;
    }
}
