// ACP (Agent Communication Protocol) event adapter

import {
    asCliEventRecord,
    fieldString,
    isCliEventRecord,
} from '../../types/cli-events.js';
import type { AcpUpdateParams, AcpSubagentEvent, ExtractedEventResult, SpawnContext } from './types.js';
import { buildPreview, extractText, summarizeToolInput } from './helpers.js';

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
            const rawInputObj = update.input ?? update.rawInput;
            const summarized = rawInputObj && typeof rawInputObj === 'object'
                ? summarizeToolInput(fieldString(update.name || update.title, 'tool'), rawInputObj as Record<string, unknown>)
                : '';
            const fullInput = summarized || (
                update.input != null
                    ? (typeof update.input === 'object' ? JSON.stringify(update.input, null, 2) : String(update.input))
                    : update.rawInput != null
                        ? (typeof update.rawInput === 'object' ? JSON.stringify(update.rawInput, null, 2) : String(update.rawInput))
                        : ''
            );
            const kindIcon = toolKindIcon(fieldString(update["kind"]) || undefined);
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
            // messageId is optional in the ACP session-update schema, but when the
            // agent sends it, chunks of one message share it and a change marks a
            // NEW assistant message. Preserving it lets the consumer apply
            // NARRATION-BOUNDARY-01; without it the chunks just accumulate, which
            // is the correct fallback (no signal, no boundary).
            const messageId = fieldString(update['messageId'] || update['message_id']);
            return messageId ? { text, messageId } : { text };
        }

        case 'plan':
            return {
                tool: {
                    icon: '📝',
                    label: 'planning...',
                    toolType: 'thinking',
                },
            };

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
