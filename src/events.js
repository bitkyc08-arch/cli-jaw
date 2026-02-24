// ─── Event Extraction (NDJSON parser) ────────────────

import { broadcast } from './bus.js';

function pushTrace(ctx, line) {
    if (!ctx?.traceLog || !line) return;
    ctx.traceLog.push(line);
}

function logLine(line, ctx) {
    console.log(line);
    pushTrace(ctx, line);
}

function toSingleLine(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function toIndentedPreview(text, max = 200) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const clipped = raw.length > max ? `${raw.slice(0, max)}…` : raw;
    return clipped.replace(/\n/g, '\n  ');
}

export function extractSessionId(cli, event) {
    switch (cli) {
        case 'claude': return event.type === 'system' ? event.session_id : null;
        case 'codex': return event.type === 'thread.started' ? event.thread_id : null;
        case 'gemini': return event.type === 'init' ? event.session_id : null;
        case 'opencode': return event.sessionID || null;
        default: return null;
    }
}

export function extractFromEvent(cli, event, ctx, agentLabel) {
    const toolLabels = extractToolLabels(cli, event, ctx);
    for (const toolLabel of toolLabels) {
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

export function logEventSummary(agentLabel, cli, event, ctx = null) {
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

function makeClaudeToolKey(event, label) {
    const idx = event.event?.index;
    if (idx !== undefined && idx !== null) return `claude:idx:${idx}:${label.icon}:${label.label}`;
    const msgId = event.message?.id || '';
    if (msgId) return `claude:msg:${msgId}:${label.icon}:${label.label}`;
    return `claude:type:${event.type}:${label.icon}:${label.label}`;
}

function pushToolLabel(labels, label, cli, event, ctx) {
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
function extractToolLabels(cli, event, ctx) {
    const item = event.item || event.part || event;
    const labels = [];

    if (cli === 'codex' && event.type === 'item.completed' && item) {
        if (item.type === 'web_search') {
            const action = item.action?.type || '';
            if (action === 'search') labels.push({ icon: '🔍', label: (item.query || item.action?.query || 'search').slice(0, 60) });
            else if (action === 'open_page') { try { labels.push({ icon: '🌐', label: new URL(item.action.url).hostname }); } catch { labels.push({ icon: '🌐', label: 'page' }); } }
            else labels.push({ icon: '🔍', label: (item.query || 'web').slice(0, 60) });
        }
        if (item.type === 'reasoning') labels.push({ icon: '💭', label: (item.text || '').replace(/\*+/g, '').trim().slice(0, 60) });
        if (item.type === 'command_execution') labels.push({ icon: '⚡', label: (item.command || 'exec').slice(0, 40) });
    }

    if (cli === 'claude') {
        // Real-time streaming first (--include-partial-messages)
        if (event.type === 'stream_event' && event.event?.type === 'content_block_start') {
            if (ctx) ctx.hasClaudeStreamEvents = true;
            const cb = event.event.content_block;
            if (cb?.type === 'tool_use') pushToolLabel(labels, { icon: '🔧', label: cb.name || 'tool' }, cli, event, ctx);
            if (cb?.type === 'thinking') pushToolLabel(labels, { icon: '💭', label: 'thinking...' }, cli, event, ctx);
        }
        // Fallback path: if no partial stream received, parse assistant bulk blocks.
        if (event.type === 'assistant' && event.message?.content && !ctx?.hasClaudeStreamEvents) {
            for (const block of event.message.content) {
                if (block.type === 'tool_use') pushToolLabel(labels, { icon: '🔧', label: block.name || 'tool' }, cli, event, ctx);
                if (block.type === 'thinking') pushToolLabel(labels, { icon: '💭', label: 'thinking...' }, cli, event, ctx);
            }
        }
    }

    if (cli === 'gemini') {
        if (event.type === 'tool_use') labels.push({ icon: '🔧', label: `${event.tool_name || 'tool'}${event.parameters?.command ? ': ' + event.parameters.command.slice(0, 40) : ''}` });
        if (event.type === 'tool_result') labels.push({ icon: event.status === 'success' ? '✅' : '❌', label: `${event.status || 'done'}` });
    }

    if (cli === 'opencode') {
        if (event.type === 'tool_use' && event.part) labels.push({ icon: '🔧', label: event.part.tool || 'tool' });
        if (event.type === 'tool_result' && event.part) labels.push({ icon: '✅', label: event.part.tool || 'done' });
    }

    return labels;
}

// Backward-compat: return first label or null
export function extractToolLabel(cli, event) {
    const labels = extractToolLabels(cli, event);
    return labels.length ? labels[0] : null;
}

// Test-only helpers (keep parser logic private for runtime flow)
export function extractToolLabelsForTest(cli, event, ctx = {}) {
    return extractToolLabels(cli, event, ctx);
}

export function makeClaudeToolKeyForTest(event, label) {
    return makeClaudeToolKey(event, label);
}

// ─── ACP session/update → cli-claw internal event ────────────────
// Official ACP schema: update.sessionUpdate is the discriminator field.
// Types: agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan

function extractText(content) {
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

export function extractFromAcpUpdate(params) {
    const update = params?.update;
    if (!update) return null;

    const type = update.sessionUpdate;

    switch (type) {
        case 'agent_thought_chunk': {
            const text = extractText(update.content);
            return {
                tool: {
                    icon: '💭',
                    label: text.slice(0, 60) + (text.length > 60 ? '...' : '') || 'thinking...',
                },
            };
        }

        case 'tool_call':
            return {
                tool: {
                    icon: '🔧',
                    label: update.name || 'tool',
                },
            };

        case 'tool_call_update':
            return {
                tool: {
                    icon: '✅',
                    label: update.name || update.id || 'done',
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
                },
            };

        default:
            if (process.env.DEBUG) {
                console.log(`[acp] unknown sessionUpdate: ${type}`, JSON.stringify(update).slice(0, 100));
            }
            return null;
    }
}
