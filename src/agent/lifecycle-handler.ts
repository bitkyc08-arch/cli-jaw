// ─── Agent Lifecycle Handler (post-exit logic) ──────
// Extracted from spawn.ts to unify ACP + CLI exit handling.

import fs from 'fs';
import { broadcast } from '../core/bus.js';
import { settings, detectCli } from '../core/config.js';
import { clearEmployeeSession, insertMessageWithTrace, updateSession, clearSessionBucket } from '../core/db.js';
import { persistMainSession } from './session-persistence.js';
import { resolveSessionBucket } from './args.js';
import { buildContinuationPrompt } from './smoke-detector.js';
import { shouldInvalidateResumeSession } from './resume-classifier.js';
import { classifyExitError } from './error-classifier.js';
import { clearLiveRun } from './live-run-state.js';
import {
    incrementMemoryFlush,
    resetMemoryFlushCounter,
    triggerMemoryFlush,
    memoryFlushCounter,
} from './memory-flush-controller.js';

// Forward reference to spawnAgent (avoid circular import)
let _spawnAgent: Function;
export function setSpawnAgent(fn: Function): void {
    _spawnAgent = fn;
}

// Forward reference to setCurrentMainMeta — same reason.
let _setCurrentMainMeta: ((meta: any) => void) | null = null;
export function setMainMetaHandler(fn: (meta: any) => void): void {
    _setCurrentMainMeta = fn;
}

export interface ExitContext {
    fullText: string;
    sessionId: string | null;
    toolLog: any[];
    traceLog: any[];
    stderrBuf: string;
    liveScope?: string;
    cost?: { input?: number; output?: number } | number | null;
    turns?: number | null;
    duration?: number | null;
}

export interface ExitHandlerParams {
    ctx: ExitContext;
    code: number | null;
    cli: string;
    model: string;
    agentLabel: string;
    mainManaged: boolean;
    origin: string;
    prompt: string;
    opts: any;
    cfg: any;
    ownerGeneration: number;
    forceNew: boolean;
    empSid: string | null;
    isResume: boolean;
    wasKilled: boolean;
    wasSteer: boolean;
    smokeResult: any;
    /** ACP uses '' (from cfg.effort), CLI uses 'medium' */
    effortDefault: string;
    /** Optional cost display line (CLI builds this, ACP passes '') */
    costLine: string;
    resolve: (result: any) => void;
    activeProcesses: Map<string, any>;
    setActiveProcess: (v: any) => void;
    retryState: {
        timer: ReturnType<typeof setTimeout> | null;
        resolve: Function | null;
        origin: string | null;
        setTimer: (t: ReturnType<typeof setTimeout> | null) => void;
        setResolve: (r: any) => void;
        setOrigin: (o: string | null) => void;
        setIsEmployee: (v: boolean) => void;
    };
    fallbackState: Map<string, any>;
    fallbackMaxRetries: number;
    processQueue: () => void;
}

/**
 * Unified post-exit handler for both ACP and CLI branches.
 *
 * Handles: smoke continuation, process cleanup, session persistence,
 * fallback recovery, output save, error classification, 429 retry, fallback.
 */
export function handleAgentExit(params: ExitHandlerParams): void {
    const {
        ctx, code, cli, model, agentLabel, mainManaged, origin,
        prompt, opts, cfg, ownerGeneration, forceNew, empSid,
        isResume, wasKilled, wasSteer, smokeResult,
        effortDefault, costLine, resolve,
        activeProcesses, setActiveProcess,
        retryState, fallbackState, fallbackMaxRetries, processQueue,
    } = params;

    const effortVal = cfg.effort || effortDefault;
    const isEmployee = !mainManaged;
    const empTag = isEmployee ? { isEmployee: true } : {};
    const liveScope = ctx.liveScope || 'default';

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
                sessionId: smokeSessionId, isFallback: opts._isFallback,
                code, cli, model, effort: effortVal,
            });
            console.log(`[jaw:smoke] persisted session ${smokeSessionId.slice(0, 12)}... for continuation`);
        }

        activeProcesses.delete(agentLabel);
        setActiveProcess(null);
        broadcast('agent_status', { running: false, agentId: agentLabel, ...empTag });

        const contPrompt = buildContinuationPrompt(prompt, ctx.fullText);
        const { promise: contPromise } = _spawnAgent(contPrompt, {
            ...opts, _isSmokeContinuation: true, _skipInsert: true,
        });
        contPromise.then((r: any) => resolve(r)).catch(() => {
            broadcast('agent_done', {
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
    activeProcesses.delete(agentLabel);
    if (mainManaged) {
        setActiveProcess(null);
        // Clear Boss channel context — subsequent dispatches (if any) should
        // not inherit this session's meta.
        _setCurrentMainMeta?.(null);
        broadcast('agent_status', { running: false, agentId: agentLabel, ...empTag });
    }

    // ─── Post-flush reindex (3-C) ───
    if (agentLabel === 'memory-flush' && code === 0) {
        postFlushReindex();
    }

    // ─── Session persistence ───
    const persistedSessionId = ctx.sessionId;
    if (persistedSessionId && persistMainSession({
        ownerGeneration, forceNew, employeeSessionId: empSid,
        sessionId: persistedSessionId, isFallback: opts._isFallback,
        code, wasKilled, cli, model, effort: effortVal,
    })) {
        console.log(`[jaw:session] saved ${cli} session=${persistedSessionId.slice(0, 12)}...${wasKilled ? ' (post-kill)' : ''}`);
    }

    // ─── Success: clear fallback state (auto-recovery) ───
    if (code === 0 && fallbackState.has(cli)) {
        console.log(`[jaw:fallback] ${cli} recovered — clearing fallback state`);
        fallbackState.delete(cli);
    }

    // ─── Output handling ───
    if (ctx.fullText.trim()) {
        const cleaned = ctx.fullText.trim()
            .replace(/<\/?tool_call>/g, '')
            .replace(/<\/?tool_result>[\s\S]*?(?:<\/tool_result>|$)/g, '')
            // [#107] Strip inline thinking/reasoning blocks from any CLI
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        const displayText = cleaned || ctx.fullText.trim();
        let finalContent = displayText + costLine;
        let traceText = ctx.traceLog.join('\n');

        // Tag interrupted output
        if (wasSteer && mainManaged && !opts.internal) {
            finalContent = `⏹️ [interrupted]\n\n${finalContent}`;
            if (traceText) traceText = `⏹️ [interrupted]\n${traceText}`;
            console.log(`[jaw:steer] saving interrupted output (${finalContent.length} chars)`);
        }

        if (mainManaged && !opts.internal) {
            const toolLogJson = ctx.toolLog.length ? JSON.stringify(ctx.toolLog) : null;
            insertMessageWithTrace.run(
                'assistant', finalContent, cli, model,
                traceText || null, toolLogJson, settings.workingDir || null,
            );
            broadcast('agent_done', { text: finalContent, toolLog: ctx.toolLog, origin, ...empTag });

            incrementMemoryFlush();
            const threshold = settings.memory?.flushEvery ?? 10;
            if (settings.memory?.enabled !== false && memoryFlushCounter >= threshold) {
                resetMemoryFlushCounter();
                triggerMemoryFlush();
            }
        }
    } else if (mainManaged && code !== 0 && !wasKilled) {
        // ─── Error handling ───
        const { is429, message: errMsg } = classifyExitError(cli, code, ctx.stderrBuf);

        if (isResume && shouldInvalidateResumeSession(cli, code, ctx.stderrBuf, ctx.fullText)) {
            if (empSid && opts.agentId) {
                clearEmployeeSession.run(opts.agentId);
                console.log(`[jaw:session] invalidated stale employee resume — ${cli} agent=${opts.agentId}`);
            } else {
                updateSession.run(cli, null, model, settings.permissions, settings.workingDir, effortVal);
                // Also clear the per-bucket entry so the next turn doesn't pick the dead session_id again.
                const bucket = resolveSessionBucket(cli, model);
                if (bucket) clearSessionBucket.run(bucket);
                console.log(`[jaw:session] invalidated stale resume — ${cli}/${bucket} session cleared`);
            }
        }

        // ─── 429 delay retry (same engine, 1회만) ───
        if (!opts.internal && !opts._isFallback && is429 && !opts._isRetry) {
            console.log(`[jaw:retry] ${cli} 429 detected — waiting 10s before retry`);
            broadcast('agent_retry', { cli, delay: 10, reason: errMsg, ...empTag }, isEmployee ? 'internal' : 'public');
            retryState.setIsEmployee(isEmployee);
            retryState.setResolve(resolve);
            retryState.setOrigin(origin);
            retryState.setTimer(setTimeout(() => {
                retryState.setTimer(null);
                retryState.setResolve(null);
                retryState.setOrigin(null);
                const { promise: retryP } = _spawnAgent(prompt, {
                    ...opts, _isRetry: true, _skipInsert: true,
                });
                retryP.then((r: any) => resolve(r)).catch(() => {
                    broadcast('agent_done', { text: `❌ ${errMsg} (재시도 실패)`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
                    resolve({ text: '', code: 1 });
                    if (mainManaged) processQueue();
                });
            }, 10_000));
            return;
        }

        // ─── Fallback with retry tracking ───
        if (!opts.internal && !opts._isFallback) {
            const fallbackCli = (settings.fallbackOrder || [])
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
                const { promise: retryP } = _spawnAgent(prompt, {
                    ...opts, cli: fallbackCli, _isFallback: true, _skipInsert: true,
                });
                retryP.then((r: any) => resolve(r)).catch(() => {
                    broadcast('agent_done', {
                        text: `❌ Fallback (${fallbackCli}) failed`, error: true, origin,
                        ...empTag,
                    }, isEmployee ? 'internal' : 'public');
                    resolve({ text: '', code: 1 });
                    if (mainManaged) processQueue();
                });
                return;
            }
        }
        broadcast('agent_done', { text: `❌ ${errMsg}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
    }

    // ─── Final resolve ───
    const resolvedCode = code;
    if (mainManaged) clearLiveRun(liveScope);
    broadcast('agent_status', {
        status: (resolvedCode === 0 || resolvedCode === null) ? 'done' : 'error',
        agentId: agentLabel,
        ...empTag,
    });
    if (agentLabel !== 'main' || code !== null) {
        console.log(`[jaw:${agentLabel}] exited code=${code}, text=${ctx.fullText.length} chars`);
    }
    resolve({
        text: ctx.fullText, code: resolvedCode,
        sessionId: ctx.sessionId, cost: ctx.cost,
        tools: ctx.toolLog, smoke: smokeResult,
    });
    if (mainManaged) processQueue();
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
