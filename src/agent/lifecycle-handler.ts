// ─── Agent Lifecycle Handler (post-exit logic) ──────
// Extracted from spawn.ts to unify ACP + CLI exit handling.

import fs from 'fs';
import type { ChildProcess } from 'child_process';
import { broadcast } from '../core/bus.js';
import { settings, detectCli } from '../core/config.js';
import { clearEmployeeSession, insertMessage, insertMessageWithTraceRun, updateSession, clearSessionBucket, markAnchorConsumed } from '../core/db.js';
import { getActiveChatSession } from '../core/chat-sessions.js';
import { persistMainSession } from './session-persistence.js';
import { resolveSessionBucket } from './args.js';
import { buildContinuationPrompt, type SmokeDetectionResult } from './smoke-detector.js';
import { shouldInvalidateResumeSession } from './resume-classifier.js';
import { classifyExitError } from './error-classifier.js';
import { backfillGrokTraceTools } from './grok-trace-backfill.js';
import { recordError, clearErrors } from './alert-escalation.js';
import { stripInterviewTracker } from '../orchestrator/sanitize.js';
import { clearLiveRun, getLiveRun } from './live-run-state.js';
import { sanitizeToolLogForDurableStorage, serializeSanitizedToolLog } from '../shared/tool-log-sanitize.js';
import { scanStructuredFence } from '../shared/structured-fence.js';
import { finalizeTraceRun, linkTraceRunToMessage } from '../trace/store.js';
import type { ToolEntry } from '../types/agent.js';
import { resolveSpawnOutputText } from './events/helpers.js';
import { isKiroPlainTextCli, isKiroResumeDegradedOutput } from './kiro-runtime.js';
import {
    incrementMemoryFlush,
    resetMemoryFlushCounter,
    triggerMemoryFlush,
    memoryFlushCounter,
} from './memory-flush-controller.js';
import { buildGoalContinuation } from '../goal/heartbeat.js';
import { completeGoal, cancelGoal, getActiveGoal, goalHasCompletionEvidence, resetAgentPauseCount } from '../goal/store.js';
import { recordTurn } from '../goal-run/controller.js';

const GOAL_CONT_MAX_ATTEMPTS = 20;
let _goalContAttempts = 0;
let _goalContGoalId: string | null = null;
export function resetGoalContAttempts(): void { _goalContAttempts = 0; _goalContGoalId = null; }

const _goalTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function clearGoalTimers(): void {
    for (const t of _goalTimers.values()) clearTimeout(t);
    _goalTimers.clear();
    _goalContAttempts = 0;
    _goalContGoalId = null;
    try {
        insertMessage.run('system', '[goal_boundary]', 'goal_boundary', '', settings['workingDir'] || null, getActiveChatSession());
    } catch { /* DB may not be ready during early init */ }
}

export function kickGoalContinuation(): boolean {
    if (!_spawnAgent) {
        console.warn('[jaw:goal] kickGoalContinuation called but _spawnAgent is not registered');
        return false;
    }
    const goalCont = buildGoalContinuation();
    if (goalCont.shouldContinue && goalCont.prompt) {
        const contGoal = getActiveGoal();
        const contGoalId = contGoal?.id ?? '__none__';
        _goalContAttempts = 1;
        _goalContGoalId = contGoalId;
        console.log(`[jaw:goal] kicking manual goal continuation`);
        broadcast('goal_continuation', { reason: 'manual_kick', attempt: 1 });
        const existingCont = _goalTimers.get(contGoalId);
        if (existingCont) clearTimeout(existingCont);
        const { promise: contP } = _spawnAgent(goalCont.prompt!, {
            _isGoalContinuation: true,
            _skipInsert: true,
        });
        contP.catch((err: Error) => {
            console.warn('[jaw:goal] kicked goal continuation failed:', err.message);
            broadcast('goal_continuation_failed', { error: err.message });
        });
        return true;
    }
    return false;
}


// Match /goal done|cancel or cli-jaw goal done|cancel at line start or after whitespace
const GOAL_DONE_RE = /(?:^|\n)\s*(?:\/goal|cli-jaw\s+goal)\s+done\b/im;
const GOAL_CANCEL_RE = /(?:^|\n)\s*(?:\/goal|cli-jaw\s+goal)\s+cancel\b/im;
const GOAL_PAUSE_RE = /(?:^|\n)\s*(?:\/goal|cli-jaw\s+goal)\s+pause\b/im;

function computeBackoff(attempt: number, base = 5000, max = 120_000): number {
    const delay = Math.min(base * 2 ** attempt, max);
    return Math.round(delay * (0.5 + Math.random() * 0.5));
}

const MAIN_MAX_RETRIES = 3;
const EMP_MAX_RETRIES = 2;

type LifecycleSpawnOptions = {
    internal?: boolean;
    _isFallback?: boolean;
    _retryAttempt?: number;
    _isGoalContinuation?: boolean;
    _isCapacityFallback?: boolean;
    _isSmokeContinuation?: boolean;
    _skipInsert?: boolean;
    _skipResume?: boolean;
    _skipSessionPersist?: boolean;
    _employeeFreshSessionRetry?: boolean;
    _kiroFreshRetry?: boolean;
    agentId?: string;
    employeeSessionId?: string;
    cli?: string;
    model?: string;
    _heartbeatAnchorId?: number;
};

type LifecycleResolveResult = {
    text: string;
    code: number;
    sessionId?: string | null;
    cost?: ExitContext['cost'];
    tools?: ToolEntry[];
    smoke?: SmokeDetectionResult;
    diagnostic?: string;
};

type SpawnAgentRef = (
    prompt: string,
    opts?: LifecycleSpawnOptions,
) => { promise: Promise<LifecycleResolveResult> };

interface LifecycleConfig {
    effort?: string;
}

interface FallbackStateEntry {
    fallbackCli?: string;
    retriesLeft: number;
}

// Forward reference to spawnAgent (avoid circular import)
let _spawnAgent: SpawnAgentRef;
export function setSpawnAgent(fn: SpawnAgentRef): void {
    _spawnAgent = fn;
}

// Forward reference to setCurrentMainMeta — same reason.
interface MainSessionMetaRef {
    origin: string;
    target?: string;
    chatId?: string | number;
    requestId?: string;
    scopeId?: string;
    effectiveProvider?: string;
}

let _setCurrentMainMeta: ((meta: MainSessionMetaRef | null) => void) | null = null;
export function setMainMetaHandler(fn: (meta: MainSessionMetaRef | null) => void): void {
    _setCurrentMainMeta = fn;
}

function isForcedGeminiProModel(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    return normalized !== ''
        && normalized !== 'default'
        && normalized !== 'auto'
        && normalized.includes('pro');
}

function lifecycleRuntimeCli(cli: string, provider?: string): string {
    if (cli !== 'ai-e') return cli;
    return provider === 'claude' ? 'claude-e' : (provider || cli);
}

/** Tag agent_done with the trace run that produced it so the web UI can drop
 *  SSE replays of already-finished turns instead of mid-turn-finalizing the
 *  in-flight one (devlog 260612 manager_stream_hidden_state_audit 06-08). */
function runTag(ctx: { traceRunId?: string | null }): Record<string, unknown> {
    return ctx.traceRunId ? { traceRunId: ctx.traceRunId } : {};
}

export interface ExitContext {
    fullText: string;
    sessionId: string | null;
    toolLog: ToolEntry[];
    traceLog: string[];
    stderrBuf: string;
    liveScope?: string | null;
    traceRunId?: string | null;
    liveOutputText?: string;
    kiroDisplayedText?: string;
    cost?: { input?: number; output?: number } | number | null;
    turns?: number | null;
    duration?: number | null;
    cliNativeCompactDetected?: boolean;
    stallReason?: string;
    scheduleWakeup?: {
        delaySeconds: number;
        prompt: string;
        reason: string;
    };
}

export interface ExitHandlerParams {
    ctx: ExitContext;
    code: number | null;
    cli: string;
    model: string;
    effectiveProvider?: string;
    resumeKey: string | null;
    agentLabel: string;
    mainManaged: boolean;
    origin: string;
    prompt: string;
    opts: LifecycleSpawnOptions;
    cfg: LifecycleConfig;
    ownerGeneration: number;
    forceNew: boolean;
    empSid: string | null;
    isResume: boolean;
    wasKilled: boolean;
    wasSteer: boolean;
    smokeResult: SmokeDetectionResult;
    /** ACP uses '' (from cfg.effort), CLI uses 'medium' */
    effortDefault: string;
    /** Optional cost display line (CLI builds this, ACP passes '') */
    costLine: string;
    resolve: (result: LifecycleResolveResult) => void;
    activeProcesses: Map<string, ChildProcess>;
    setActiveProcess: (v: ChildProcess | null) => void;
    retryState: {
        setTimer: (t: ReturnType<typeof setTimeout> | null) => void;
        setResolve: (r: ((result: LifecycleResolveResult) => void) | null) => void;
        setOrigin: (o: string | null) => void;
        setIsEmployee: (v: boolean) => void;
    };
    fallbackState: Map<string, FallbackStateEntry>;
    fallbackMaxRetries: number;
    processQueue: () => void;
    outputLen?: number;
}

/**
 * Unified post-exit handler for both ACP and CLI branches.
 *
 * Handles: smoke continuation, process cleanup, session persistence,
 * fallback recovery, output save, error classification, 429 retry, fallback.
 */
export async function handleAgentExit(params: ExitHandlerParams): Promise<void> {
    const {
        ctx, code, cli, model, agentLabel, mainManaged, origin,
        prompt, opts, cfg, ownerGeneration, forceNew, empSid,
        isResume, wasKilled, wasSteer, smokeResult,
        effortDefault, costLine, resolve,
        activeProcesses, setActiveProcess,
        retryState, fallbackState, fallbackMaxRetries, processQueue,
    } = params;

    const effectiveProvider = params.effectiveProvider;
    const runtimeCli = lifecycleRuntimeCli(cli, effectiveProvider);
    const effortVal = cfg.effort || effortDefault;
    const isEmployee = !mainManaged;
    const empTag = isEmployee ? { isEmployee: true } : {};
    const liveScope = ctx.liveScope || 'default';
    const traceStatus = code === 0 ? 'done' : wasKilled ? 'interrupted' : 'error';

    // ─── Smoke response auto-continuation ───
    if (
        smokeResult.isSmoke
        && smokeResult.confidence !== 'low'
        && !opts._isSmokeContinuation
        && !opts.internal
        && mainManaged
        && !wasSteer
    ) {
        console.warn(
            `[jaw:smoke] ${cli} smoke detected (${smokeResult.confidence}). Auto-continuing.`,
        );
        broadcast('agent_smoke', {
            cli, confidence: smokeResult.confidence,
            reason: smokeResult.reason, agentId: agentLabel,
            ...empTag,
        }, isEmployee ? 'internal' : 'public');

        const smokeSessionId = ctx.sessionId;
        if (smokeSessionId) {
            persistMainSession({
                ownerGeneration, forceNew, employeeSessionId: empSid,
                sessionId: smokeSessionId, isFallback: opts._isFallback === true,
                code, cli, model, provider: effectiveProvider, resumeKey: params.resumeKey, effort: effortVal,
                skipSessionPersist: opts._skipSessionPersist === true,
                outputLen: params.outputLen,
            });
            console.log(`[jaw:smoke] persisted session ${smokeSessionId.slice(0, 12)}... for continuation`);
        }

        activeProcesses.delete(agentLabel);
        setActiveProcess(null);
        broadcast('agent_status', { running: false, agentId: agentLabel, ...empTag });
        finalizeTraceRun(ctx.traceRunId, 'done');

        const contPrompt = buildContinuationPrompt(prompt, ctx.fullText);
        const { promise: contPromise } = _spawnAgent(contPrompt, {
            ...opts, _isSmokeContinuation: true, _skipInsert: true,
        });
        contPromise.then((r) => resolve(r)).catch(() => {
            broadcast('agent_done', { ...runTag(ctx),
                text: `❌ Smoke continuation failed. Original: ${ctx.fullText.slice(0, 200)}`,
                error: true, origin,
                ...empTag,
            }, isEmployee ? 'internal' : 'public');
            resolve({
                text: ctx.fullText, code: code ?? 1,
                sessionId: ctx.sessionId, cost: ctx.cost,
                tools: ctx.toolLog, smoke: smokeResult,
            });
            processQueue();
        });
        return;
    }

    // ─── Process cleanup ───
    // When wasSteer, killActiveAgent already cleared activeProcess synchronously
    // and a replacement agent is being spawned. The stale exit handler must NOT
    // overwrite the new agent's references in activeProcesses / activeProcess / meta.
    if (mainManaged) {
        if (!wasSteer) {
            activeProcesses.delete(agentLabel);
            setActiveProcess(null);
            _setCurrentMainMeta?.(null);
            broadcast('agent_status', { running: false, agentId: agentLabel, ...empTag });
        }
    } else {
        activeProcesses.delete(agentLabel);
    }

    // ─── Post-flush reindex (3-C) ───
    if (agentLabel === 'memory-flush' && code === 0) {
        postFlushReindex();
    }

    // ─── CLI-native compact → auto session refresh (awaited to avoid race with processQueue) ───
    if (ctx.cliNativeCompactDetected && mainManaged && !opts.internal) {
        console.log('[jaw:compact] CLI-native compaction detected — auto-refreshing session');
        try {
            const { autoCompactRefresh } = await import('../core/compact.js');
            await autoCompactRefresh({
                workDir: settings["workingDir"] || '',
                instructions: prompt || '',
                cli,
                model,
            });
        } catch (e) {
            console.warn('[jaw:compact] auto-refresh failed:', (e as Error).message);
        }
    }

    // ─── Session persistence ───
    const persistedSessionId = ctx.sessionId;
    if (persistedSessionId && persistMainSession({
        ownerGeneration, forceNew, employeeSessionId: empSid,
        sessionId: persistedSessionId, isFallback: opts._isFallback === true,
        code, wasKilled, cli, model, provider: effectiveProvider, resumeKey: params.resumeKey, effort: effortVal,
        skipSessionPersist: opts._skipSessionPersist === true,
        outputLen: params.outputLen,
    })) {
        console.log(`[jaw:session] saved ${cli} session=${persistedSessionId.slice(0, 12)}...${wasKilled ? ' (post-kill)' : ''}`);
    }

    // ─── Phase 54-A: Proactive compact by turn count (Codex/Gemini) ───
    // Non-Claude CLIs lack compact events. Suggest at 25 turns; force refresh at 35.
    if (mainManaged && !opts.internal && code === 0 && !ctx.cliNativeCompactDetected) {
        const turns = ctx.turns ?? memoryFlushCounter;
        const isNonClaude = runtimeCli !== 'claude' && runtimeCli !== 'claude-e';
        if (isNonClaude && turns >= 35) {
            console.log(`[jaw:compact] ${cli} reached ${turns} turns — forcing auto-refresh`);
            try {
                const { autoCompactRefresh } = await import('../core/compact.js');
                await autoCompactRefresh({
                    workDir: settings["workingDir"] || '',
                    instructions: prompt || '',
                    cli,
                    model,
                });
            } catch (e) {
                console.warn('[jaw:compact] turn-count auto-refresh failed:', (e as Error).message);
            }
        } else if (isNonClaude && turns >= 25) {
            console.log(`[jaw:compact] ${cli} at ${turns} turns — suggesting compact`);
            broadcast('system_notice', {
                code: 'compact_suggest',
                text: `Session is at ${turns} turns. Consider running /compact to preserve context.`,
            }, 'public');
        }
    }

    // ─── Phase 54-C: Codex high-turn auto-compact coordination ───
    // Codex may internally compact at high turn counts without notifying jaw.
    // Force a fresh session on next spawn to avoid stale resume.
    if (mainManaged && !opts.internal && code === 0 && !ctx.cliNativeCompactDetected) {
        const turns = ctx.turns ?? memoryFlushCounter;
        if ((runtimeCli === 'codex' || runtimeCli === 'opencode' || runtimeCli === 'gemini' || runtimeCli === 'grok' || runtimeCli === 'agy') && turns > 15) {
            console.log(`[jaw:compact] ${cli} exited after ${turns} turns — clearing session bucket for fresh start`);
            try {
                const bucket = resolveSessionBucket(cli, model, effectiveProvider);
                clearSessionBucket.run(bucket);
            } catch (e) {
                console.warn('[jaw:compact] session bucket clear failed:', (e as Error).message);
            }
        }
    }

    // ─── Success: clear fallback state (auto-recovery) ───
    if (code === 0 && fallbackState.has(cli)) {
        console.log(`[jaw:fallback] ${cli} recovered — clearing fallback state`);
        fallbackState.delete(cli);
    }
    if (code === 0) clearErrors(cli);

    if (code === 0 && runtimeCli === 'grok') {
        const recovered = backfillGrokTraceTools(ctx);
        if (recovered > 0) {
            console.log(`[jaw:grok] recovered ${recovered} tool event(s) from Grok trace export`);
        }
    }

    // ─── Kiro stale resume on exit 0 (stdout carries "no saved chat sessions", etc.) ───
    // Only inspect the CLI diagnostic channels (stderr + assistant body) — never tool
    // output (ctx.traceLog), which is arbitrary content that can quote stale phrases.
    // A genuine stale resume does ZERO work, so require an empty toolLog: a turn that
    // actually ran tools must never be reclassified as stale and silently discarded.
    const kiroDiagnosticText = `${ctx.stderrBuf}\n${ctx.fullText}`;
    if (
        isKiroPlainTextCli(cli, effectiveProvider)
        && isResume
        && mainManaged
        && !opts.internal
        && !opts._isFallback
        && !opts._skipResume
        && !opts._kiroFreshRetry
        && !wasKilled
        && !wasSteer
        && (code === 0 || code === null)
        && ctx.toolLog.length === 0
        && shouldInvalidateResumeSession(runtimeCli, code, ctx.stderrBuf, kiroDiagnosticText)
    ) {
        const bucket = resolveSessionBucket(cli, model, effectiveProvider);
        if (bucket) {
            try { clearSessionBucket.run(bucket); } catch { /* ignore */ }
        }
        console.log('[jaw:kiro] stale resume detected on success exit — retrying fresh with history');
        try {
            const { peekPendingBootstrapPrompt } = await import('../core/main-session.js');
            if (!peekPendingBootstrapPrompt()) {
                const { autoCompactRefresh } = await import('../core/compact.js');
                await autoCompactRefresh({ workDir: settings["workingDir"] || null, instructions: '', cli, model });
            }
        } catch {}
        broadcast('agent_retry', {
            cli,
            delay: 0,
            reason: 'kiro stale resume — fresh with history',
            ...empTag,
        }, isEmployee ? 'internal' : 'public');
        finalizeTraceRun(ctx.traceRunId, 'error', 'kiro stale resume');
        const { promise: retryP } = _spawnAgent(prompt, {
            ...opts,
            _skipResume: true,
            _kiroFreshRetry: true,
            _skipInsert: true,
        });
        retryP.then(resolve).catch(() => {
            broadcast('agent_done', { ...runTag(ctx),
                text: '❌ kiro stale resume and fresh retry failed',
                error: true,
                origin,
                ...empTag,
            }, isEmployee ? 'internal' : 'public');
            resolve({ text: '', code: 1 });
            if (mainManaged && !opts.internal) processQueue();
        });
        return;
    }

    // ─── Output handling ───
    const outputText = resolveSpawnOutputText(ctx);
    if (outputText || (code === 0 && ctx.toolLog.length > 0)) {
        const cleaned = (outputText || ctx.fullText.trim())
            .replace(/<\/?tool_call>/g, '')
            .replace(/<\/?tool_result>[\s\S]*?(?:<\/tool_result>|$)/g, '')
            // [#107] Strip inline thinking/reasoning blocks from any CLI
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        const displayText = stripInterviewTracker(cleaned || outputText || ctx.fullText.trim());
        let finalContent = displayText + costLine;
        let traceText = ctx.traceLog.join('\n');

        // Tag interrupted output
        if (wasSteer && mainManaged && !opts.internal) {
            finalContent = `⏹️ [interrupted]\n\n${finalContent}`;
            if (traceText) traceText = `⏹️ [interrupted]\n${traceText}`;
            console.log(`[jaw:steer] saving interrupted output (${finalContent.length} chars)`);
        }

        if (mainManaged && !opts.internal) {
            const structuredFence = scanStructuredFence(finalContent);
            if (structuredFence.status === 'incomplete') {
                console.warn('[lifecycle] assistant output contains incomplete structured fence before durable insert', {
                    cli,
                    model,
                    traceRunId: ctx.traceRunId || null,
                    chars: finalContent.length,
                    langs: structuredFence.langs,
                    incompleteCount: structuredFence.incompleteCount,
                });
            }
            const liveRun = getLiveRun(liveScope);
            const mergedToolLog = liveRun.toolLog.length > ctx.toolLog.length ? liveRun.toolLog : ctx.toolLog;
            const sanitizedToolLog = sanitizeToolLogForDurableStorage(mergedToolLog);
            const toolLogJson = serializeSanitizedToolLog(sanitizedToolLog);
            const info = insertMessageWithTraceRun.run(
                'assistant', finalContent, cli, model,
                traceText || null, toolLogJson, settings["workingDir"] || null,
                ctx.traceRunId || null, getActiveChatSession(),
            );
            const messageId = Number(info.lastInsertRowid || 0);
            if (ctx.traceRunId && Number.isInteger(messageId) && messageId > 0) linkTraceRunToMessage(ctx.traceRunId, messageId);
            broadcast('agent_done', { ...runTag(ctx), text: finalContent, toolLog: sanitizedToolLog, origin, ...empTag, ...(wasSteer ? { steered: true } : {}) });

            if (opts._heartbeatAnchorId) {
                try {
                    markAnchorConsumed.run(Date.now(), opts._heartbeatAnchorId);
                } catch (e) {
                    console.error('[lifecycle] Failed to mark heartbeat anchor consumed:', (e as Error).message);
                }
            }

            incrementMemoryFlush();
            const threshold = settings["memory"]?.flushEvery ?? 10;
            if (settings["memory"]?.enabled !== false && memoryFlushCounter >= threshold) {
                resetMemoryFlushCounter();
                triggerMemoryFlush();
            }
        }
    } else if (mainManaged && code !== 0 && !wasKilled) {
        // ─── Error handling ───
        const diagnosticText = `${ctx.fullText}\n${ctx.traceLog.join('\n')}`;
        const { is429, isStall, isModelCapacity, isClaudeRateLimit, isTransientStartup, message: errMsg } = classifyExitError(
            runtimeCli,
            code,
            ctx.stderrBuf,
            ctx.stallReason,
            diagnosticText,
        );
        const suppressClaudeRateLimitFallback = isClaudeRateLimit;
        const effectiveIs429 = is429 || isClaudeRateLimit || isTransientStartup;
        recordError(cli, isStall ? 'stall' : isModelCapacity ? 'model_capacity' : effectiveIs429 ? '429' : 'error');

        const invalidatedResume = isResume
            && shouldInvalidateResumeSession(runtimeCli, code, ctx.stderrBuf, diagnosticText);
        if (invalidatedResume) {
            if (empSid && opts.agentId) {
                clearEmployeeSession.run(opts.agentId);
                console.log(`[jaw:session] invalidated stale employee resume — ${cli} agent=${opts.agentId}`);
            } else {
                updateSession.run(cli, null, model, settings["permissions"], settings["workingDir"], effortVal);
                const bucket = resolveSessionBucket(cli, model, effectiveProvider);
                if (bucket) clearSessionBucket.run(bucket);
                console.log(`[jaw:session] invalidated stale resume — ${cli}/${bucket} session cleared`);
            }
        }

        if (
            invalidatedResume
            && mainManaged
            && !opts.internal
            && !opts._isFallback
            && !opts._skipResume
            && !opts._kiroFreshRetry
        ) {
            console.log(`[jaw:resume] ${cli} stale resume invalidated — retrying current request without resume`);
            broadcast('agent_retry', {
                cli,
                delay: 0,
                reason: `${errMsg} (retry without stale resume)`,
                ...empTag,
            }, isEmployee ? 'internal' : 'public');
            finalizeTraceRun(ctx.traceRunId, 'error', errMsg);
            const { promise: retryP } = _spawnAgent(prompt, {
                ...opts,
                _skipResume: true,
                _skipInsert: true,
            }) as { promise: Promise<{ text: string; code: number }> };
            retryP.then(resolve).catch(() => {
                broadcast('agent_done', { ...runTag(ctx), text: `❌ ${errMsg} (fresh-session retry failed)`, error: true, origin, ...empTag, ...(wasSteer ? { steered: true } : {}) }, isEmployee ? 'internal' : 'public');
                resolve({ text: '', code: 1 });
                if (mainManaged && !opts.internal) processQueue();
            });
            return;
        }

        // ─── Stall kills: do NOT retry — escalate immediately ───
        if (isStall) {
            if (mainManaged && !opts.internal) {
                try {
                    const { autoCompactRefresh } = await import('../core/compact.js');
                    await autoCompactRefresh({ workDir: settings["workingDir"] || null, instructions: '', cli, model });
                } catch {}
                insertMessage.run('assistant', `⏱️ ${errMsg}`, cli, model, settings["workingDir"] || null, getActiveChatSession());
            }
            broadcast('agent_done', { ...runTag(ctx), text: `❌ ${errMsg}`, error: true, origin, ...empTag, ...(wasSteer ? { steered: true } : {}) }, isEmployee ? 'internal' : 'public');
            finalizeTraceRun(ctx.traceRunId, 'error', errMsg);
            resolve({ text: '', code: 1 });
            if (mainManaged && !opts.internal) processQueue();
            return;
        }

        // ─── Gemini resumed capacity failure: clear stale vendor session and retry once ───
        if (
            runtimeCli === 'gemini'
            && isModelCapacity
            && isResume
            && !opts.internal
            && !opts._isFallback
            && !opts._isCapacityFallback
        ) {
            const bucket = resolveSessionBucket(cli, model, effectiveProvider);
            if (bucket) clearSessionBucket.run(bucket);
            console.log(`[jaw:gemini] resumed session capacity exhausted — cleared ${bucket || 'gemini'} bucket and retrying without resume`);
            broadcast('agent_fallback', {
                from: cli,
                to: cli,
                reason: `${errMsg} (retry without stale Gemini resume)`,
                model,
                fallbackModel: model,
                ...empTag,
            }, isEmployee ? 'internal' : 'public');
            finalizeTraceRun(ctx.traceRunId, 'error', errMsg);
            const { promise: retryP } = _spawnAgent(prompt, {
                ...opts,
                _skipResume: true,
                _isCapacityFallback: true,
                _skipInsert: true,
                _skipSessionPersist: true,
            }) as { promise: Promise<{ text: string; code: number }> };
            retryP.then(resolve).catch(() => {
                broadcast('agent_done', { ...runTag(ctx), text: `❌ ${errMsg} (Gemini fresh-session retry failed)`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
                resolve({ text: '', code: 1 });
                if (mainManaged && !opts.internal) processQueue();
            });
            return;
        }

        // ─── Gemini model capacity: one-request Auto fallback, preserving configured model ───
        if (
            runtimeCli === 'gemini'
            && isModelCapacity
            && isForcedGeminiProModel(model)
            && !opts.internal
            && !opts._isFallback
            && !opts._isCapacityFallback
        ) {
            console.log(`[jaw:gemini] ${model} capacity exhausted — retrying current request with Auto`);
            broadcast('agent_fallback', {
                from: cli,
                to: cli,
                reason: `${errMsg} (Auto fallback for this request only)`,
                model,
                fallbackModel: 'default',
                ...empTag,
            }, isEmployee ? 'internal' : 'public');
            finalizeTraceRun(ctx.traceRunId, 'error', errMsg);
            const { promise: retryP } = _spawnAgent(prompt, {
                ...opts,
                model: 'default',
                _skipResume: true,
                _isCapacityFallback: true,
                _skipInsert: true,
                _skipSessionPersist: true,
            }) as { promise: Promise<{ text: string; code: number }> };
            retryP.then(resolve).catch(() => {
                broadcast('agent_done', { ...runTag(ctx), text: `❌ ${errMsg} (Auto fallback failed)`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
                resolve({ text: '', code: 1 });
                if (mainManaged && !opts.internal) processQueue();
            });
            return;
        }

        // ─── 429 delay retry (exponential backoff, up to MAIN_MAX_RETRIES) ───
        const mainAttempt = opts._retryAttempt ?? 0;
        if (!opts.internal && !opts._isFallback && effectiveIs429 && mainAttempt < MAIN_MAX_RETRIES) {
            const delayMs = computeBackoff(mainAttempt);
            const delaySec = Math.round(delayMs / 1000);
            console.log(`[jaw:retry] ${cli} 429 detected — waiting ${delaySec}s before retry (attempt ${mainAttempt + 1}/${MAIN_MAX_RETRIES})`);
            broadcast('agent_retry', { cli, delay: delaySec, reason: errMsg, attempt: mainAttempt + 1, maxRetries: MAIN_MAX_RETRIES, ...empTag }, isEmployee ? 'internal' : 'public');
            finalizeTraceRun(ctx.traceRunId, 'error', errMsg);
            retryState.setIsEmployee(isEmployee);
            retryState.setResolve(resolve);
            retryState.setOrigin(origin);
            retryState.setTimer(setTimeout(() => {
                retryState.setTimer(null);
                retryState.setResolve(null);
                retryState.setOrigin(null);
                const { promise: retryP } = _spawnAgent(prompt, {
                    ...opts, _retryAttempt: mainAttempt + 1, _skipInsert: true,
                });
                retryP.then((r) => resolve(r)).catch(() => {
                    broadcast('agent_done', { ...runTag(ctx), text: `❌ ${errMsg} (재시도 실패, attempt ${mainAttempt + 1})`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
                    resolve({ text: '', code: 1 });
                    if (mainManaged && !opts.internal) processQueue();
                });
            }, delayMs));
            return;
        }

        // ─── Fallback with retry tracking ───
        if (!opts.internal && !opts._isFallback && !suppressClaudeRateLimitFallback) {
            const fallbackCli = (settings["fallbackOrder"] || [])
                .find((fc: string) => fc !== cli && detectCli(fc).available);
            if (fallbackCli) {
                const st = fallbackState.get(cli);
                if (st) {
                    st.retriesLeft = Math.max(0, st.retriesLeft - 1);
                    console.log(`[jaw:fallback] ${cli} retry consumed, ${st.retriesLeft} left`);
                } else {
                    fallbackState.set(cli, { fallbackCli, retriesLeft: fallbackMaxRetries });
                    console.log(`[jaw:fallback] ${cli} → ${fallbackCli}, ${fallbackMaxRetries} retries queued`);
                }
                broadcast('agent_fallback', { from: cli, to: fallbackCli, reason: errMsg, ...empTag }, isEmployee ? 'internal' : 'public');
                finalizeTraceRun(ctx.traceRunId, 'error', errMsg);
                try {
                    const { peekPendingBootstrapPrompt } = await import('../core/main-session.js');
                    if (!peekPendingBootstrapPrompt()) {
                        const { autoCompactRefresh } = await import('../core/compact.js');
                        await autoCompactRefresh({ workDir: settings["workingDir"] || null, instructions: '', cli, model });
                    }
                } catch {}
                const { promise: retryP } = _spawnAgent(prompt, {
                    ...opts, cli: fallbackCli, _isFallback: true, _skipInsert: true,
                });
                retryP.then((r) => resolve(r)).catch(() => {
                    broadcast('agent_done', { ...runTag(ctx),
                        text: `❌ Fallback (${fallbackCli}) failed`, error: true, origin,
                        ...empTag,
                    }, isEmployee ? 'internal' : 'public');
                    resolve({ text: '', code: 1 });
                    if (mainManaged && !opts.internal) processQueue();
                });
                return;
            }
        }
        broadcast('agent_done', { ...runTag(ctx), text: `❌ ${errMsg}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
    } else if (isEmployee && code !== 0 && !wasKilled && !opts._isFallback) {
        // ─── Employee transient retry (exponential backoff, up to EMP_MAX_RETRIES) ───
        const diagnosticText = `${ctx.fullText}\n${ctx.traceLog.join('\n')}`;
        const cls = classifyExitError(runtimeCli, code, ctx.stderrBuf, ctx.stallReason, diagnosticText);
        const empAttempt = opts._retryAttempt ?? 0;
        if (
            cls.isTransientStartup
            && isResume
            && empSid
            && opts.agentId
            && !opts._employeeFreshSessionRetry
            && empAttempt === 0
            && !cls.isStall
            && !cls.isAuth
        ) {
            clearEmployeeSession.run(opts.agentId);
            console.log(`[jaw:session] employee stale resume pre-SessionStart — cleared ${opts.agentId} and retrying fresh`);
            broadcast('agent_retry', {
                cli,
                delay: 0,
                reason: `${cls.message} (cleared stale employee resume; retrying fresh session)`,
                isEmployee: true,
                attempt: 1,
                maxRetries: 1,
            }, 'internal');
            finalizeTraceRun(ctx.traceRunId, 'error', cls.message);
            const { promise: retryP } = _spawnAgent(prompt, {
                ...opts,
                _skipInsert: true,
                _skipResume: true,
                _employeeFreshSessionRetry: true,
            });
            retryP.then((r) => resolve(r)).catch((retryErr: Error) => {
                const retryMessage = retryErr?.message ? `; retry=${retryErr.message}` : '';
                const diagnostic = `${cls.message} (fresh employee session retry failed${retryMessage})`;
                broadcast('agent_done', { ...runTag(ctx), text: `❌ ${diagnostic}`, error: true, origin, isEmployee: true }, 'internal');
                resolve({ text: '', code: 1, diagnostic });
            });
            return;
        }
        if ((cls.is429 || cls.isClaudeRateLimit || cls.isTransientStartup) && !cls.isStall && !cls.isAuth && !opts._employeeFreshSessionRetry && empAttempt < EMP_MAX_RETRIES) {
            recordError(cli, '429');
            const empDelayMs = computeBackoff(empAttempt, 3000, 60_000);
            const empDelaySec = Math.round(empDelayMs / 1000);
            console.log(`[jaw:retry] employee ${cli} transient exit — retry in ${empDelaySec}s (attempt ${empAttempt + 1}/${EMP_MAX_RETRIES}, ${cls.message})`);
            broadcast('agent_retry', { cli, delay: empDelaySec, reason: cls.message, isEmployee: true, attempt: empAttempt + 1 }, 'internal');
            finalizeTraceRun(ctx.traceRunId, 'error', cls.message);
            retryState.setIsEmployee(true);
            retryState.setResolve(resolve);
            retryState.setOrigin(origin);
            retryState.setTimer(setTimeout(() => {
                retryState.setTimer(null);
                retryState.setResolve(null);
                retryState.setOrigin(null);
                const { promise: retryP } = _spawnAgent(prompt, {
                    ...opts, _retryAttempt: empAttempt + 1, _skipInsert: true, _skipResume: true,
                });
                retryP.then((r) => resolve(r)).catch(() => {
                    broadcast('agent_done', { ...runTag(ctx), text: `❌ ${cls.message} (재시도 실패, attempt ${empAttempt + 1})`, error: true, origin, isEmployee: true }, 'internal');
                    resolve({ text: '', code: 1, diagnostic: cls.message });
                });
            }, empDelayMs));
            return;
        }
        // non-retryable employee error → fall through to Final resolve below
    }

    // ─── Kiro resume degraded (empty body) → fresh spawn with history fallback ───
    const kiroOutputText = resolveSpawnOutputText(ctx);
    if (
        isKiroPlainTextCli(cli, effectiveProvider)
        && isResume
        && mainManaged
        && !opts.internal
        && !opts._isFallback
        && !opts._kiroFreshRetry
        && !wasKilled
        && !wasSteer
        && (code === 0 || code === null)
        && isKiroResumeDegradedOutput(kiroOutputText, ctx.toolLog.length, isResume)
    ) {
        const bucket = resolveSessionBucket(cli, model, effectiveProvider);
        if (bucket) {
            try { clearSessionBucket.run(bucket); } catch { /* ignore */ }
        }
        console.log('[jaw:kiro] resume returned empty output — retrying fresh with history (original logic)');
        broadcast('agent_retry', {
            cli,
            delay: 0,
            reason: 'kiro resume empty — fresh with history',
            ...empTag,
        }, isEmployee ? 'internal' : 'public');
        finalizeTraceRun(ctx.traceRunId, 'error', 'kiro resume empty');
        const { promise: retryP } = _spawnAgent(prompt, {
            ...opts,
            _skipResume: true,
            _kiroFreshRetry: true,
            _skipInsert: true,
            _skipSessionPersist: true,
        });
        retryP.then(resolve).catch(() => {
            broadcast('agent_done', { ...runTag(ctx),
                text: '❌ kiro resume empty and fresh retry failed',
                error: true,
                origin,
                ...empTag,
            }, isEmployee ? 'internal' : 'public');
            resolve({ text: '', code: 1 });
            if (mainManaged && !opts.internal) processQueue();
        });
        return;
    }

    // ─── Final resolve ───
    const resolvedCode = code;
    finalizeTraceRun(
        ctx.traceRunId,
        traceStatus,
        traceStatus === 'error' ? classifyExitError(runtimeCli, resolvedCode ?? 1, ctx.stderrBuf).message : null,
    );
    if (mainManaged && !wasSteer) clearLiveRun(liveScope);
    if (!opts.internal && !wasSteer) {
        broadcast('agent_status', {
            status: (resolvedCode === 0 || resolvedCode === null) ? 'done' : 'error',
            agentId: agentLabel,
            ...empTag,
        }, isEmployee ? 'internal' : 'public');
    }
    if (agentLabel !== 'main' || code !== null) {
        console.log(`[jaw:${agentLabel}] exited code=${code}, text=${ctx.fullText.length} chars`);
    }
    const diagnostic = resolvedCode !== 0 && resolvedCode !== null
        ? classifyExitError(runtimeCli, resolvedCode, ctx.stderrBuf).message
        : ctx.stderrBuf.trim().slice(0, 500);
    resolve({
        text: ctx.fullText, code: resolvedCode ?? 0,
        sessionId: ctx.sessionId, cost: ctx.cost,
        tools: ctx.toolLog, smoke: smokeResult,
        diagnostic,
        ...(params.outputLen ? { outputLen: params.outputLen } : {}),
    });

    // ─── AI-initiated /goal done or /goal cancel ───
    // The AI can't execute slash commands directly. Detect the pattern in output
    // and execute it so the continuation loop stops.
    let goalDoneRejected = false;
    if (mainManaged && !opts.internal && ctx.fullText) {
        const activeGoal = getActiveGoal();
        if (activeGoal && activeGoal.status === 'active') {
            if (GOAL_DONE_RE.test(ctx.fullText)) {
                if (goalHasCompletionEvidence(activeGoal)) {
                    completeGoal();
                    clearGoalTimers();
                    console.log('[jaw:goal] AI /goal done — evidence present, goal marked complete');
                    broadcast('goal_done', { goalId: activeGoal.id, source: 'ai_output' });
                } else {
                    goalDoneRejected = true;
                    console.warn('[jaw:goal] AI /goal done REJECTED — no verification evidence on latest checkpoint');
                    broadcast('goal_done_rejected', { goalId: activeGoal.id, reason: 'no_evidence' });
                }
            } else if (GOAL_CANCEL_RE.test(ctx.fullText)) {
                cancelGoal();
                clearGoalTimers();
                console.log('[jaw:goal] AI output contained /goal cancel — goal cancelled');
                broadcast('goal_cancel', { goalId: activeGoal.id, source: 'ai_output' });
            } else if (GOAL_PAUSE_RE.test(ctx.fullText)) {
                clearGoalTimers();
                console.log('[jaw:goal] AI output contained /goal pause — timers cleared');
                broadcast('goal_pause_detected', { goalId: activeGoal.id, source: 'ai_output' });
            }
        }
    }

    // ─── ScheduleWakeup server intercept ───
    // When the AI called ScheduleWakeup, the CLI ignores it (only works in /loop).
    // cli-jaw intercepts the params and schedules a delayed --resume of the same session.
    if (
        ctx.scheduleWakeup
        && ctx.scheduleWakeup.prompt.trim()
        && mainManaged
        && !opts.internal
        && !wasKilled
        && (resolvedCode === 0 || resolvedCode === null)
    ) {
        const { delaySeconds, prompt: wakeupPrompt, reason: wakeupReason } = ctx.scheduleWakeup;
        const clampedDelay = Math.max(60, Math.min(3600, delaySeconds)) * 1000;
        if (clampedDelay !== delaySeconds * 1000) {
            console.log(`[jaw:wakeup] delay clamped: ${delaySeconds}s → ${clampedDelay / 1000}s`);
        }
        const goalAtWakeup = getActiveGoal();
        const goalIdAtWakeup = goalAtWakeup?.id ?? '__none__';
        if (_goalContGoalId !== goalIdAtWakeup) {
            _goalContAttempts = 0;
            _goalContGoalId = goalIdAtWakeup;
        }
        _goalContAttempts++;
        console.log(`[jaw:wakeup] ScheduleWakeup intercepted — resuming in ${clampedDelay / 1000}s (${wakeupReason}) [goal=${goalIdAtWakeup}, attempt=${_goalContAttempts}/${GOAL_CONT_MAX_ATTEMPTS}]`);
        if (_goalContAttempts > GOAL_CONT_MAX_ATTEMPTS) {
            console.warn(`[jaw:wakeup] max attempts reached — not scheduling`);
            broadcast('goal_continuation_limit', { attempts: _goalContAttempts });
            _goalContAttempts = 0;
        } else {
            broadcast('schedule_wakeup', { delaySeconds: clampedDelay / 1000, reason: wakeupReason });
            const existingWakeup = _goalTimers.get(goalIdAtWakeup);
            if (existingWakeup) clearTimeout(existingWakeup);
            const tid = setTimeout(() => {
                _goalTimers.delete(goalIdAtWakeup);
                const currentGoal = getActiveGoal();
                if (!currentGoal || currentGoal.id !== goalIdAtWakeup || currentGoal.status !== 'active') {
                    console.log(`[jaw:wakeup] goal changed or inactive — skipping resume`);
                    return;
                }
                console.log(`[jaw:wakeup] firing delayed resume (${wakeupReason})`);
                const { promise: wakeP } = _spawnAgent(wakeupPrompt, {
                    _skipInsert: true,
                });
                wakeP.catch((err: Error) => {
                    console.warn('[jaw:wakeup] delayed resume failed:', err.message);
                    broadcast('schedule_wakeup_failed', { reason: wakeupReason, error: err.message });
                });
            }, clampedDelay);
            _goalTimers.set(goalIdAtWakeup, tid);
        }
    } else if (
    // ─── Goal auto-continuation (max 20 consecutive attempts) ───
        mainManaged
        && !opts.internal
        && !wasKilled
        && !wasSteer
        && (resolvedCode === 0 || resolvedCode === null)
    ) {
        const goalCont = buildGoalContinuation();
        if (goalCont.shouldContinue && goalCont.prompt) {
            const contGoal = getActiveGoal();
            const contGoalId = contGoal?.id ?? '__none__';
            if (_goalContGoalId !== contGoalId) {
                _goalContAttempts = 0;
                _goalContGoalId = contGoalId;
            }
            _goalContAttempts++;
            if (_goalContAttempts > GOAL_CONT_MAX_ATTEMPTS) {
                console.warn(`[jaw:goal] max continuation attempts (${GOAL_CONT_MAX_ATTEMPTS}) reached — stopping`);
                broadcast('goal_continuation_limit', { attempts: _goalContAttempts });
                _goalContAttempts = 0;
            } else {
                recordTurn();
                if (!GOAL_PAUSE_RE.test(ctx.fullText ?? '')) {
                    resetAgentPauseCount();
                }
                const delay = opts._isGoalContinuation ? 10000 : 2000;
                console.log(`[jaw:goal] active goal — continuation ${_goalContAttempts}/${GOAL_CONT_MAX_ATTEMPTS} in ${delay}ms`);
                broadcast('goal_continuation', { reason: goalCont.reason, attempt: _goalContAttempts });
                const existingCont = _goalTimers.get(contGoalId);
                if (existingCont) clearTimeout(existingCont);
                const tid = setTimeout(() => {
                    _goalTimers.delete(contGoalId);
                    const currentGoal = getActiveGoal();
                    if (!currentGoal || currentGoal.id !== contGoalId || currentGoal.status !== 'active') {
                        console.log(`[jaw:goal] goal changed or inactive — skipping continuation`);
                        _goalContAttempts = 0;
                        return;
                    }
                    const contPrompt = goalDoneRejected
                        ? `[goal-gate] Your previous \`/goal done\` was REJECTED: the latest checkpoint had no verification evidence. Before declaring done again, run \`cli-jaw goal update "<summary>" --evidence "<test result / changed file>"\` with concrete evidence, and metacognitively confirm every part of the objective is truly finished.\n\n${goalCont.prompt!}`
                        : goalCont.prompt!;
                    const { promise: contP } = _spawnAgent(contPrompt, {
                        ...opts,
                        _isGoalContinuation: true,
                        _skipInsert: true,
                    });
                    contP.catch((err: Error) => {
                        console.warn('[jaw:goal] auto-continuation failed:', err.message);
                        broadcast('goal_continuation_failed', { error: err.message });
                    });
                }, delay);
                _goalTimers.set(contGoalId, tid);
            }
        } else {
            _goalContAttempts = 0;
        }
    }

    if (mainManaged && !wasSteer) processQueue();
}

// ─── Post-flush reindex (3-C) ────────────────────────

async function postFlushReindex(): Promise<void> {
    try {
        await new Promise(r => setTimeout(r, 200));
        const { reindexIntegratedMemoryFile } = await import('../memory/indexing.js');
        const { getMemoryFlushFilePath } = await import('../memory/runtime.js');
        const today = new Date().toISOString().slice(0, 10);
        const flushedFile = getMemoryFlushFilePath(today);
        if (fs.existsSync(flushedFile)) {
            reindexIntegratedMemoryFile(flushedFile);
            console.log('[memory:flush] post-flush reindex done');
        }
    } catch (err) {
        console.warn('[memory:flush] post-flush reindex failed:', (err as Error).message);
    }
}
