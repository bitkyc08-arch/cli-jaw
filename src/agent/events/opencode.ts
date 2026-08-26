// OpenCode CLI event adapter

import { asCliEventRecord } from '../../types/cli-events.js';
import type { CliEventRecord } from './types.js';
import type { SpawnContext, ToolEntry } from './types.js';
import {
    syncLiveTools,
    emitAgentTool,
    pushTrace,
    buildPreview,
    appendAssistantTextSegment,
    isOpencodeToolFailure,
    formatPostToolAssistantLead,
} from './helpers.js';

function flushOpenCodeStepText(
    ctx: SpawnContext,
    agentLabel: string | undefined,
    empTag: Record<string, unknown>,
    reason: string,
): void {
    const preToolText = ctx.opencodePreToolText || '';
    const postToolText = ctx.opencodePostToolText || '';
    const isToolCallStep = reason === 'tool-calls';
    const textToCommit = isToolCallStep
        ? postToolText
        : `${preToolText}${postToolText}`;
    const suppressedText = isToolCallStep ? preToolText : '';
    if (textToCommit) {
        const streamText = ctx.liveOutputText ?? ctx.fullText;
        const lead = isToolCallStep && !streamText.trim()
            ? formatPostToolAssistantLead(textToCommit)
            : textToCommit;
        const segment = appendAssistantTextSegment(ctx, lead);
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
        emitAgentTool(ctx, agentLabel, thinkingTool, empTag);
        ctx.opencodeStepThinkingToolEmitted = true;
        pushTrace(ctx, `[${agentLabel || 'agent'}] opencode pre-tool intermediate text (${suppressedText.length} chars)`);
    }
}

function resetOpenCodeStepState(ctx: SpawnContext): void {
    ctx.opencodePreToolText = '';
    ctx.opencodePostToolText = '';
    ctx.opencodeSawToolInStep = false;
    ctx.opencodeHadToolErrorInStep = false;
    ctx.opencodePendingToolRefs = [];
    ctx.opencodeStepThinkingToolEmitted = false;
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
        emitAgentTool(ctx, agentLabel, existing, empTag);
    }
}

export function flushOpenCodeBuffers(ctx: SpawnContext, agentLabel?: string, empTag: Record<string, unknown> = {}): void {
    const hasBufferedText = Boolean(ctx.opencodePreToolText || ctx.opencodePostToolText);
    const hasPendingTools = Boolean(ctx.opencodePendingToolRefs?.length);
    if (!hasBufferedText && !hasPendingTools) return;

    const reason = ctx.opencodeSawToolInStep ? 'tool-calls' : 'stop';
    if (hasBufferedText) {
        flushOpenCodeStepText(ctx, agentLabel, empTag, reason);
    }
    finalizeOpencodePendingTools(ctx, agentLabel || 'agent', empTag);
    resetOpenCodeStepState(ctx);
}

export function handleOpenCodeEvent(
    evt: CliEventRecord,
    ctx: SpawnContext,
    agentLabel: string,
    empTag: Record<string, unknown>,
): void {
    if (typeof evt.type === 'string' && ![
        'step_start',
        'text',
        'tool_use',
        'step_finish',
        'reasoning',
        'error',
    ].includes(evt.type)) {
        pushTrace(ctx, `[${agentLabel}] opencode unknown event type=${evt.type}`);
    }
    if (evt.type === 'error') {
        const msg = String(evt.part?.message || evt.message || evt.error || JSON.stringify(evt));
        ctx.stderrBuf += `[opencode:error] ${msg}\n`;
        pushTrace(ctx, `[${agentLabel}] opencode error event: ${msg}`);
        return;
    }
    if (evt.type === 'step_start') {
        const model = evt.part?.model || evt.model;
        if (model) ctx.model = model;
        // LAST-STEP-WINS (NARRATION-BOUNDARY-01): a NEW step means the text the
        // previous step committed was not this turn's answer — otherwise the run
        // would have ended there. External channels deliver text derived from
        // ctx.fullText, so mid-turn narration must not accumulate into it; the
        // live UI still has it via pendingOutputChunk/agent_output.
        // Unconditional on purpose: 'stop' ends the step loop, so nothing follows
        // a terminal step, and if a step_start DOES follow, its existence proves
        // the earlier text was not terminal.
        if (ctx.fullText || ctx.outputTextStarted) {
            ctx.fullText = '';
            ctx.outputTextStarted = false;
        }
        ctx.opencodePreToolText = '';
        ctx.opencodePostToolText = '';
        ctx.opencodeSawToolInStep = false;
        ctx.opencodeHadToolErrorInStep = false;
        ctx.opencodePendingToolRefs = [];
        ctx.opencodeStepThinkingToolEmitted = false;
        pushTrace(ctx, `[${agentLabel}] opencode step_start${model ? ` model=${model}` : ''}`);
    }
    if (evt.type === 'reasoning') {
        const text = String(evt.part?.text || evt.text || '').trim();
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
            emitAgentTool(ctx, agentLabel, thinkingTool, empTag);
            ctx.opencodeStepThinkingToolEmitted = true;
            pushTrace(ctx, `[${agentLabel}] opencode reasoning (${text.length} chars)`);
        }
    } else if (evt.type === 'text' && evt.part?.text) {
        if (ctx.opencodeSawToolInStep) {
            ctx.opencodePostToolText = (ctx.opencodePostToolText || '') + String(evt.part.text);
        } else {
            ctx.opencodePreToolText = (ctx.opencodePreToolText || '') + String(evt.part.text);
        }
    } else if (evt.type === 'tool_use') {
        ctx.opencodeSawToolInStep = true;
        if (isOpencodeToolFailure(asCliEventRecord(evt.part))) ctx.opencodeHadToolErrorInStep = true;
    } else if (evt.type === 'step_finish' && evt.part) {
        if (evt.sessionID) ctx.sessionId = evt.sessionID;
        if (evt.part.tokens) {
            if (!ctx.tokens) ctx.tokens = { input_tokens: 0, output_tokens: 0, cached_read: 0, cached_write: 0 };
            ctx.tokens["input_tokens"] = (ctx.tokens["input_tokens"] ?? 0) + (evt.part.tokens.input ?? 0);
            ctx.tokens["output_tokens"] = (ctx.tokens["output_tokens"] ?? 0) + (evt.part.tokens.output ?? 0);
            if (evt.part.tokens.cache) {
                ctx.tokens["cached_read"] = (ctx.tokens["cached_read"] ?? 0) + (evt.part.tokens.cache.read ?? 0);
                ctx.tokens["cached_write"] = (ctx.tokens["cached_write"] ?? 0) + (evt.part.tokens.cache.write ?? 0);
            }
            if (evt.part.tokens.total != null) {
                ctx.tokens["total_tokens"] = (ctx.tokens["total_tokens"] ?? 0) + evt.part.tokens.total;
            }
            if (evt.part.tokens.reasoning != null) {
                ctx.tokens["reasoning_tokens"] = (ctx.tokens["reasoning_tokens"] ?? 0) + evt.part.tokens.reasoning;
            }
        }
        if (evt.part.cost != null) {
            ctx.cost = (ctx.cost ?? 0) + evt.part.cost;
        }
        if (evt.part.reason) {
            ctx.finishReason = evt.part.reason;
        }
        flushOpenCodeStepText(ctx, agentLabel, empTag, String(evt.part.reason || 'stop'));
        const reasoningTokens = Number(evt.part.tokens?.reasoning || 0);
        if (reasoningTokens > 0 && !ctx.opencodeStepThinkingToolEmitted) {
            const reason = String(evt.part.reason || 'unknown');
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
            emitAgentTool(ctx, agentLabel, thinkingTool, empTag);
            ctx.opencodeStepThinkingToolEmitted = true;
            pushTrace(ctx, `[${agentLabel}] opencode reasoning token fallback (${reasoningTokens} tokens)`);
        }
        finalizeOpencodePendingTools(ctx, agentLabel, empTag);
        resetOpenCodeStepState(ctx);
        if (evt.part["time"]) {
            if (!ctx.metadata) ctx.metadata = {};
            ctx.metadata["lastStepTime"] = evt.part["time"];
        }
    }
}
