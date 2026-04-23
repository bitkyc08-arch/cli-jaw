// ─── PABCD Orchestration ────────────────────────────
// Old round-loop pipeline fully removed.
// PABCD state machine is the sole orchestration system.

import fs from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import { broadcast } from '../core/bus.js';
import { settings } from '../core/config.js';
import {
    insertMessage, getEmployees,
    clearAllEmployeeSessions,
    upsertEmployeeSession,
} from '../core/db.js';

import { clearPromptCache } from '../prompt/builder.js';
import { spawnAgent, killAgentById } from '../agent/spawn.js';
import {
    createWorklog,
    readLatestWorklog,
    appendToWorklog, updateWorklogStatus,
} from '../memory/worklog.js';
import { findEmployee, runSingleAgent, validateParallelSafety } from './distribute.js';
import {
    claimWorker, finishWorker, failWorker,
    listPendingWorkerResults, claimWorkerReplay, markWorkerReplayed, releaseWorkerReplay,
    getActiveWorkers, cancelWorker, clearAllWorkers,
} from './worker-registry.js';
import { processQueue } from '../agent/spawn.js';
import {
    getState, getPrefix, resetState, setState, getStatePrompt,
    getCtx,
    type OrcStateName,
    type OrcContext,
} from './state-machine.js';
// scope is globally 'default' — resolveOrcScope/findActiveScope no longer needed here
import { buildTaskSnapshot, getMemoryStatus } from '../memory/runtime.js';
import { buildMemoryInjection } from '../memory/injection.js';

// ─── Parser re-exports ─────────────────────────────
import {
    isContinueIntent, isResetIntent, isApproveIntent,
    parseDirectAnswer, stripSubtaskJSON,
} from './parser.js';
export {
    isContinueIntent, isResetIntent, isApproveIntent,
    parseDirectAnswer,
};

type SpawnAgentLike = typeof spawnAgent;

function pickPlanningTask(userText: string, _prompt: string, ctx: Record<string, any> | null) {
    const ctxPrompt = String(ctx?.originalPrompt || '').trim();
    if (ctxPrompt) return ctxPrompt;
    const userPrompt = String(userText || '').trim();
    if (userPrompt) return userPrompt;
    return '';
}

function pickWorklogSeed(...candidates: Array<string | null | undefined>) {
    for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (value) return value;
    }
    return 'orchestration';
}

type WorkerTaskLike = Record<string, any>;
type RunSingleAgentLike = typeof runSingleAgent;
type FindEmployeeLike = typeof findEmployee;

interface PreparedWorkerTask {
    task: WorkerTaskLike;
    emp: Record<string, any>;
    workerPhase: number;
}

async function executePreparedWorkerTask(
    prepared: PreparedWorkerTask,
    args: {
        worklogPath: string;
        origin: string;
        priorResults?: Record<string, any>[];
        parallelPeers?: Record<string, any>[];
        runSingle: RunSingleAgentLike;
    },
) {
    const { task, emp, workerPhase } = prepared;
    upsertEmployeeSession.run(emp.id, null, emp.cli);
    claimWorker(emp, task.task);

    try {
        const result = await args.runSingle(
            {
                ...task,
                phaseProfile: [workerPhase],
                currentPhaseIdx: 0,
                currentPhase: workerPhase,
                completed: false,
                history: [],
            },
            emp,
            { path: args.worklogPath },
            1,
            { origin: args.origin },
            args.priorResults || [],
            args.parallelPeers || [],
        );

        if (result.status === 'done') {
            finishWorker(emp.id, result.text || '');
        } else {
            failWorker(emp.id, result.text || `[worker error] ${emp.id}`);
        }

        return { emp, result, dispatched: true, ran: true };
    } catch (err) {
        failWorker(emp.id, (err as Error).message || String(err));
        console.error(`[jaw:pabcd] worker ${emp.id} failed:`, (err as Error).message);
        return { emp, result: null, dispatched: true, ran: false };
    }
}

const ACTIVE_PABCD_DISPATCH_STATES = new Set<OrcStateName>(['P', 'A', 'B', 'C']);

// ─── drainPendingReplays ─────────────────────────────
// Feed completed-but-unreceived worker results back to Boss. Safe to call
// from any idle caller (dispatch route on client-disconnect, processQueue
// entry, orchestrate entry). Bookkeeping via claim/mark/releaseWorkerReplay
// prevents double-injection. Each iteration recurses into orchestrate() with
// _skipReplayDrain:true so we don't re-enter this loop.
export async function drainPendingReplays(fallbackMeta: Record<string, any> = {}): Promise<void> {
    const pendingResults = listPendingWorkerResults();
    for (const pr of pendingResults) {
        if (!claimWorkerReplay(pr.agentId)) continue;
        // Prefer per-slot replayMeta captured at dispatch time so the result
        // routes back to the original channel (web/telegram/discord + chatId).
        // Fallback meta (caller-supplied) only fills in when slot meta is absent.
        const slotMeta = pr.meta || {};
        const meta = {
            ...fallbackMeta,
            ...(slotMeta.origin ? { origin: slotMeta.origin } : {}),
            ...(slotMeta.target ? { target: slotMeta.target } : {}),
            ...(slotMeta.chatId != null ? { chatId: slotMeta.chatId } : {}),
            ...(slotMeta.requestId ? { requestId: slotMeta.requestId } : {}),
        };
        try {
            await orchestrate(pr.text, { ...meta, _workerResult: true, _skipInsert: true, _skipReplayDrain: true });
            markWorkerReplayed(pr.agentId);
            processQueue();
        } catch {
            releaseWorkerReplay(pr.agentId);
            break;
        }
    }
}

// ─── orchestrate (PABCD sole entry point) ───────────

export async function orchestrate(
    prompt: string,
    meta: Record<string, any> = {},
) {
    const origin = meta.origin || 'web';
    const chatId = meta.chatId;
    const target = meta.target;
    const requestId = meta.requestId;
    const userText = String(prompt || '').trim();

    // --- drain pending worker results before normal processing ---
    if (!meta._skipReplayDrain) {
        await drainPendingReplays(meta);
    }
    const runSpawnAgent: SpawnAgentLike = typeof meta._spawnAgent === 'function'
        ? meta._spawnAgent
        : spawnAgent;
    const scope = 'default';
    let ctx = getCtx(scope);

    let state = getState(scope);
    let skipPrefix = !!meta._skipPrefix;

    // Skip session clear during active PABCD (preserve resume)
    // Employee sessions are preserved across normal prompts to maintain resume state
    if (!meta._skipClear && state === 'IDLE') {
        // Removed: clearAllEmployeeSessions.run()
        // Employee sessions should only be cleared on explicit /reset, not every message
    }

    // PABCD entry is explicit only — via `/orchestrate`, `/pabcd`, or LLM tool call.
    // Auto-entry and auto-advance removed per user request.

    clearPromptCache();

    ctx = getCtx(scope);
    const planningTask = pickPlanningTask(userText, prompt, ctx);
    const isInitialPlanningTurn = state === 'P'
        && !meta._workerResult
        && !meta._skipPrefix
        && !ctx?.plan
        && !!planningTask;

    if (isInitialPlanningTurn) {
        prompt = `${getStatePrompt('P')}\n\nUser request:\n${planningTask}`;
        skipPrefix = true;

        const nextCtx: OrcContext = {
            ...(ctx || {
                originalPrompt: '',
                workingDir: settings.workingDir || null,
                scopeId: scope,
                plan: null,
                workerResults: [],
                origin,
                chatId,
            }),
            originalPrompt: planningTask,
            workingDir: settings.workingDir || null,
            scopeId: scope,
            origin,
            chatId,
        };

        // Create a fresh worklog before setState() so state/title reads the new latest worklog.
        const worklogSeed = pickWorklogSeed(nextCtx.originalPrompt, planningTask, userText);
        const worklogInfo = createWorklog(worklogSeed);
        nextCtx.worklogPath = worklogInfo.path;
        setState('P', nextCtx, scope, pickWorklogSeed(nextCtx.originalPrompt));
        ctx = nextCtx;
    }

    // prefix injection
    const source = meta._workerResult ? 'worker' : 'user';
    const prefix = getPrefix(state, source as 'user' | 'worker');
    if (prefix && !skipPrefix) {
        prompt = prefix + '\n' + prompt;
    }

    // spawn/resume agent
    console.log(`[jaw:pabcd] state=${state}, spawning/resuming agent`);
    let memorySnapshot = '';
    try {
        const injection = buildMemoryInjection({
            role: meta._workerResult ? 'employee' : 'boss',
            currentPrompt: userText || prompt,
            allowProfile: !meta._workerResult,
            allowSnapshot: !meta._workerResult,
        });
        memorySnapshot = injection.snapshot || '';
    } catch (err) {
        console.warn('[jaw:memory-snapshot]', (err as Error).message);
    }

    const { promise } = runSpawnAgent(prompt, {
        origin,
        _skipInsert: !!meta._skipInsert,
        memorySnapshot,
    });
    const result = await promise as Record<string, any>;

    // Re-read state from DB — it may have changed during agent execution
    // (phase transitions via CLI commands, user reset, etc.)
    state = getState(scope);

    if (state === 'P' && !meta._workerResult) {
        const savedCtx = getCtx(scope);
        if (savedCtx) {
            const newPlan = stripSubtaskJSON(result.text) || result.text || savedCtx.plan;
            if (newPlan) {
                // Re-derive title from this scope's original prompt to avoid cross-scope worklog bleed
                const title = pickWorklogSeed(savedCtx.originalPrompt);

                // Phase 56: Write .shared_plan.md so workers (in isolated dirs) can read the plan.
                let sharedPlanPath: string | undefined;
                let planHash: string | undefined;
                const updatedAt = new Date().toISOString();
                try {
                    const planDir = savedCtx.workingDir || settings.workingDir || process.cwd();
                    sharedPlanPath = join(planDir, '.shared_plan.md');
                    const content = [
                        `# Shared Plan`,
                        `> Generated: ${updatedAt}`,
                        `> Scope: ${scope}`,
                        ``,
                        newPlan,
                    ].join('\n');
                    fs.writeFileSync(sharedPlanPath, content);
                    planHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
                } catch (err) {
                    console.warn('[jaw:shared-plan] write failed:', (err as Error).message);
                }

                // Phase 56: append plan body to worklog ## Plan section (replaces "(대기 중)")
                if (savedCtx.worklogPath) {
                    try {
                        appendToWorklog(savedCtx.worklogPath, 'Plan', newPlan);
                    } catch (err) {
                        console.warn('[jaw:shared-plan] worklog append failed:', (err as Error).message);
                    }
                }

                setState('P', {
                    ...savedCtx,
                    plan: newPlan,
                    sharedPlanPath,
                    planHash,
                    planUpdatedAt: updatedAt,
                }, scope, title);
            }
        }
    }

    // Normal response → broadcast
    // (Worker JSON dispatch removed in patch3 — Boss calls `cli-jaw dispatch` directly)
    broadcast('orchestrate_done', {
        text: result.text || '',
        origin,
        chatId,
        target,
        requestId,
    });
}

// ─── Continue ───────────────────────────────────────

export async function orchestrateContinue(
    meta: Record<string, any> = {},
) {
    const origin = meta.origin || 'web';
    const chatId = meta.chatId;
    const target = meta.target;
    const requestId = meta.requestId;
    const scope = 'default';
    const state = getState(scope);

    // Active PABCD → resume from current state
    if (state !== 'IDLE') {
        console.log(`[jaw:pabcd] continue in state=${state}`);
        return orchestrate('Please continue from where you left off.', {
            ...meta,
            _skipClear: true,
        });
    }

    // IDLE + incomplete worklog → worklog-based resume
    const latest = readLatestWorklog();
    if (
        !latest ||
        latest.content.includes('Status: done') ||
        latest.content.includes('Status: reset')
    ) {
        broadcast('orchestrate_done', {
            text: 'No pending work to continue.',
            origin,
            chatId,
            target,
            requestId,
        });
        return;
    }

    return orchestrate(
        `Read the previous worklog and continue any incomplete tasks.\nWorklog: ${latest.path}`,
        { ...meta, _skipClear: true },
    );
}

// ─── Reset ──────────────────────────────────────────

export async function orchestrateReset(
    meta: Record<string, any> = {},
) {
    const origin = meta.origin || 'web';
    const chatId = meta.chatId;
    const target = meta.target;
    const requestId = meta.requestId;
    // --- cancel PABCD workers only — preserve main agent + message queue ---
    for (const w of getActiveWorkers()) {
        killAgentById(w.agentId);
        cancelWorker(w.agentId);
    }
    clearAllWorkers();
    clearAllEmployeeSessions.run();
    const scope = 'default';
    resetState(scope);
    const latest = readLatestWorklog();
    if (!latest) {
        broadcast('orchestrate_done', {
            text: 'Reset complete.',
            origin,
            chatId,
            target,
            requestId,
        });
        return;
    }
    updateWorklogStatus(latest.path, 'reset', 0);
    appendToWorklog(latest.path, 'Final Summary', 'Reset by user request.');
    broadcast('orchestrate_done', {
        text: 'Reset complete.',
        origin,
        chatId,
        target,
        requestId,
    });
}
