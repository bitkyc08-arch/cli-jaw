import type { SpawnContext, ToolEntry } from '../types/agent.js';
import {
    agyTranscriptStepKey,
    classifyAgyTranscriptRow,
    parseTranscriptLine,
    readTranscriptDelta,
    resolveAgyTranscriptPathForCurrentTurn,
    resolveAgyTranscriptPath,
} from './agy-transcript.js';

export type AgyTranscriptWatcherHandle = { stop: () => void };

export type AgyTranscriptEmit = (
    ctx: SpawnContext,
    tool: ToolEntry,
    agentLabel: string,
    cli: string,
    empTag: Record<string, unknown>,
    traceAudience: 'public' | 'internal',
) => void;

const POLL_MS = 800;
const WAIT_PATH_MS = 120_000;
const CURRENT_TURN_LOOKBACK_MS = 5_000;
const RETARGET_SCAN_MS = 2_000;

function updateFinalPlannerFlag(ctx: SpawnContext, line: string, minCreatedAtMs: number): void {
    let rowType = '';
    let createdAtMs: number | null = null;
    let rowContent = '';
    try {
        const parsed = JSON.parse(line) as { content?: unknown; created_at?: unknown; type?: unknown };
        rowType = typeof parsed.type === 'string' ? parsed.type : '';
        rowContent = typeof parsed.content === 'string' ? parsed.content.trim() : '';
        if (typeof parsed.created_at === 'string') {
            const createdAt = Date.parse(parsed.created_at);
            if (Number.isFinite(createdAt)) {
                createdAtMs = createdAt;
                if (createdAt < minCreatedAtMs) return;
            }
        }
    } catch {
        return;
    }
    // A USER_INPUT row marks the current turn's start: any final-planner flag set by a
    // previous turn's row that slipped inside the lookback buffer (fast resume) is stale.
    if (rowType === 'USER_INPUT') {
        ctx.agyFinalPlannerSeen = false;
        ctx.agyFinalPlannerText = undefined;
        ctx.agyLastTranscriptError = undefined;
        return;
    }
    const { kind, error } = classifyAgyTranscriptRow(line);
    if (kind === 'provider-error' && error) {
        ctx.agyFinalPlannerSeen = false;
        ctx.agyFinalPlannerText = undefined;
        ctx.agyLastTranscriptError = error;
    } else if (kind === 'final-planner') {
        // The current turn's final answer row is always written after spawn, so require a
        // fresh timestamp (1s allowance for second-truncation). The wider minCreatedAtMs
        // lookback stays for tool display, but a previous turn's final planner inside that
        // buffer must never arm completion — agy may not have flushed any current-turn row
        // yet when the run resumes quickly (reproduced live in the v2 smoke).
        const freshThresholdMs = minCreatedAtMs + 4_000;
        if (createdAtMs !== null && createdAtMs >= freshThresholdMs) {
            ctx.agyFinalPlannerSeen = true;
            ctx.agyFinalPlannerText = rowContent;
            ctx.agyLastTranscriptError = undefined;
        }
    } else if (kind === 'tool' || kind === 'planner') {
        ctx.agyFinalPlannerSeen = false;
        ctx.agyFinalPlannerText = undefined;
        ctx.agyLastTranscriptError = undefined;
    }
}

function applyTranscriptTool(
    ctx: SpawnContext,
    line: string,
    minCreatedAtMs: number,
    onEmit: AgyTranscriptEmit,
    agentLabel: string,
    cli: string,
    empTag: Record<string, unknown>,
    traceAudience: 'public' | 'internal',
    conversationId: string | null,
): void {
    try {
        const parsed = JSON.parse(line) as { created_at?: unknown };
        if (typeof parsed.created_at === 'string') {
            const createdAt = Date.parse(parsed.created_at);
            if (Number.isFinite(createdAt) && createdAt < minCreatedAtMs) return;
        }
    } catch { /* parseTranscriptLine handles malformed rows */ }
    const tool = parseTranscriptLine(line);
    if (!tool?.stepRef) return;
    let dedupeKey = tool.stepRef;
    try {
        const parsed = JSON.parse(line) as { step_index?: unknown; type?: string };
        dedupeKey = agyTranscriptStepKey(parsed.step_index, parsed.type ?? '', conversationId);
        if (conversationId) {
            tool.stepRef = `agy:transcript:${conversationId}:${parsed.step_index ?? 'x'}:${parsed.type ?? ''}`;
        }
    } catch { /* stepRef */ }
    const existingIdx = ctx.toolLog.findIndex((e) => e.stepRef === tool.stepRef);
    if (existingIdx >= 0) {
        ctx.toolLog[existingIdx] = { ...ctx.toolLog[existingIdx], ...tool };
    } else if (!ctx.seenToolKeys.has(dedupeKey)) {
        ctx.seenToolKeys.add(dedupeKey);
        ctx.toolLog.push(tool);
    }
    ctx.stallWatchdog?.markProgress();
    onEmit(ctx, tool, agentLabel, cli, empTag, traceAudience);
}

export function startAgyTranscriptWatcher(options: {
    cwd: string;
    prompt?: string;
    getSessionId: () => string | null;
    ctx: SpawnContext;
    agentLabel: string;
    cli: string;
    empTag: Record<string, unknown>;
    traceAudience: 'public' | 'internal';
    onEmit: AgyTranscriptEmit;
    onActivity?: () => void;
}): AgyTranscriptWatcherHandle {
    let offset = 0;
    let transcriptPath: string | null = null;
    let conversationId: string | null = null;
    let stopped = false;
    const startedAt = Date.now();
    const minCreatedAtMs = startedAt - CURRENT_TURN_LOOKBACK_MS;
    let lastRetargetScanAt = 0;

    const resetSelection = () => {
        transcriptPath = null;
        conversationId = null;
        offset = 0;
        options.ctx.agyFinalPlannerSeen = false;
        options.ctx.agyFinalPlannerText = undefined;
        options.ctx.agyLastTranscriptError = undefined;
    };

    const selectTranscript = (currentSessionId: string | null, force: boolean): void => {
        const now = Date.now();
        if (!force && transcriptPath && now - lastRetargetScanAt < RETARGET_SCAN_MS) return;
        lastRetargetScanAt = now;

        const effectiveResolved = resolveAgyTranscriptPathForCurrentTurn(
            options.cwd,
            currentSessionId,
            minCreatedAtMs,
            options.prompt,
        );
        if (!effectiveResolved.ok || !effectiveResolved.transcriptPath) {
            if (!transcriptPath && Date.now() - startedAt > WAIT_PATH_MS) {
                console.warn(`[jaw:agy:transcript] gave up waiting (${effectiveResolved.reason ?? 'unknown'})`);
            }
            return;
        }
        if (transcriptPath === effectiveResolved.transcriptPath) return;
        transcriptPath = effectiveResolved.transcriptPath;
        conversationId = effectiveResolved.conversationId ?? currentSessionId ?? null;
        offset = 0;
        options.ctx.agyFinalPlannerSeen = false;
        options.ctx.agyFinalPlannerText = undefined;
        options.ctx.agyLastTranscriptError = undefined;
        console.log(`[jaw:agy:transcript] tailing ${transcriptPath} (current-turn filter from ${new Date(startedAt).toISOString()})`);
    };

    const tick = () => {
        if (stopped) return;
        const currentSessionId = options.getSessionId();
        if (transcriptPath && currentSessionId && conversationId && currentSessionId !== conversationId) {
            resetSelection();
        }
        selectTranscript(currentSessionId, !transcriptPath);
        if (!transcriptPath) return;
        try {
            const previousOffset = offset;
            const delta = readTranscriptDelta(transcriptPath, offset);
            offset = delta.offset;
            for (const line of delta.lines) {
                updateFinalPlannerFlag(options.ctx, line, minCreatedAtMs);
                applyTranscriptTool(
                    options.ctx,
                    line,
                    minCreatedAtMs,
                    options.onEmit,
                    options.agentLabel,
                    options.cli,
                    options.empTag,
                    options.traceAudience,
                    conversationId,
                );
            }
            if (delta.offset > previousOffset) {
                // Transcript growth = AGY is still working, regardless of row type
                // (planner/thinking rows are dropped by the tool parser but still count).
                options.ctx.agyTranscriptActive = true;
                options.onActivity?.();
            }
        } catch (e) {
            console.warn('[jaw:agy:transcript] read failed:', (e as Error).message);
        }
    };

    const interval = setInterval(tick, POLL_MS);
    tick();

    return {
        stop: () => {
            stopped = true;
            clearInterval(interval);
            if (!transcriptPath) {
                const resolved = resolveAgyTranscriptPath(options.cwd, options.getSessionId());
                const effectiveResolved = resolveAgyTranscriptPathForCurrentTurn(
                    options.cwd,
                    options.getSessionId(),
                    minCreatedAtMs,
                    options.prompt,
                );
                if (!effectiveResolved.ok || !effectiveResolved.transcriptPath) return;
                transcriptPath = effectiveResolved.transcriptPath;
                conversationId = effectiveResolved.conversationId ?? resolved.conversationId ?? options.getSessionId() ?? null;
                offset = 0;
            }
            try {
                const delta = readTranscriptDelta(transcriptPath, offset);
                for (const line of delta.lines) {
                    updateFinalPlannerFlag(options.ctx, line, minCreatedAtMs);
                    applyTranscriptTool(
                        options.ctx,
                        line,
                        minCreatedAtMs,
                        options.onEmit,
                        options.agentLabel,
                        options.cli,
                        options.empTag,
                        options.traceAudience,
                        conversationId,
                    );
                }
            } catch { /* best-effort final drain */ }
        },
    };
}
