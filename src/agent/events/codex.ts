// Codex CLI event adapter

import { stripUndefined } from '../../core/strip-undefined.js';
import { detectLongRunningToolTimeout } from '../tool-timeout.js';
import type { CliEventRecord } from './types.js';
import type { SpawnContext } from './types.js';
import {
    syncLiveTools,
    emitAgentTool,
    pushTrace,
    buildPreview,
    appendAssistantTextSegment,
} from './helpers.js';

export function handleCodexEvent(
    evt: CliEventRecord,
    ctx: SpawnContext,
    agentLabel: string,
    empTag: Record<string, unknown>,
): void {
    if (evt.type === 'turn.started') {
        pushTrace(ctx, `[${agentLabel}] codex turn started`);
    }
    if (evt.type === 'item.completed') {
        if (evt.item?.type === 'agent_message') {
            const text = String(evt.item.text || '');
            const channel = evt.item?.['channel'] || (evt.item?.['annotations'] as Record<string, unknown> | undefined)?.['channel'];
            // Commentary-channel messages are transient progress updates — do NOT
            // persist them in fullText so they stay out of agent_done and therefore
            // out of Slack/Telegram/Discord delivery.
            if (channel === 'commentary') {
                // Still emit as a tool indicator for live web UI
                if (text.trim()) {
                    const tool = stripUndefined({
                        icon: '💬',
                        label: buildPreview(text, 80) || 'working...',
                        // 'thinking', not 'tool': external channel status lines
                        // (Slack progress, Telegram tool log) drop thinking-type
                        // entries, so narration stays a live-UI-only affordance.
                        toolType: 'thinking' as const,
                        detail: text,
                        status: 'done' as const,
                    });
                    ctx.toolLog.push(tool);
                    syncLiveTools(ctx);
                    emitAgentTool(ctx, agentLabel, tool, empTag);
                }
                return;
            }
            // Untagged agent_message: current Codex builds often omit the
            // channel tag, so progress narration ("확인하겠습니다...") and the
            // real answer arrive shaped identically. Treat them as LAST-WINS:
            // each new untagged message REPLACES the durable text instead of
            // being joined with "\n- ", which is exactly the
            // "확인합니다.- <답변>" artifact users saw in Slack. Earlier
            // messages remain visible live via pendingOutputChunk/agent_output
            // and the 💬 toolLog entry below.
            ctx.fullText = '';
            ctx.outputTextStarted = false;
            const segment = appendAssistantTextSegment(ctx, text);
            ctx.pendingOutputChunk = (ctx.pendingOutputChunk || '') + segment;
            if (segment.trim()) {
                const itemId = evt.item.id || '';
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
                    emitAgentTool(ctx, agentLabel, tool, empTag);
                }
            }
        }
        if (evt.item?.type === 'collab_tool_call'
            && ['spawn_agent', 'wait'].includes(String(evt.item.tool || evt.item.name || ''))) {
            ctx.hasActiveSubAgent = false;
        }
    } else if (evt.type === 'item.started') {
        if (evt.item?.type === 'command_execution') {
            const fullCommand = String(evt.item.command || '');
            const detectedTimeout = detectLongRunningToolTimeout(fullCommand);
            if (detectedTimeout) {
                const bufferMs = 600_000;
                ctx.stallWatchdog?.extendDeadline(
                    detectedTimeout.timeoutMs + bufferMs,
                    detectedTimeout.commandKind,
                );
                pushTrace(
                    ctx,
                    `[watchdog] extended for ${detectedTimeout.commandKind} by ${Math.round((detectedTimeout.timeoutMs + bufferMs) / 1000)}s`,
                );
            }
        }
        if (evt.item?.type === 'collab_tool_call'
            && ['spawn_agent', 'wait'].includes(String(evt.item.tool || evt.item.name || ''))) {
            ctx.hasActiveSubAgent = true;
        }
    } else if (evt.type === 'turn.completed' && evt.usage) {
        ctx.tokens = {
            input_tokens: evt.usage.input_tokens ?? 0,
            output_tokens: evt.usage.output_tokens ?? 0,
            cached_input_tokens: evt.usage.cached_input_tokens ?? 0,
        };
    } else if (evt.type === 'error' || evt.type === 'turn.failed') {
        const raw = evt.error?.message ?? evt.message ?? '';
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
        emitAgentTool(ctx, agentLabel, tool, empTag);
        pushTrace(ctx, `[${agentLabel}] codex ${evt.type}: ${msg.slice(0, 200)}`);
    }
}
