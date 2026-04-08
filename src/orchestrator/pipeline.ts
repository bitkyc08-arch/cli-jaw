// ─── PABCD Orchestration ────────────────────────────
// Old round-loop pipeline fully removed.
// PABCD state machine is the sole orchestration system.

import { broadcast } from '../core/bus.js';
import { settings } from '../core/config.js';
import {
    insertMessage, getEmployees,
    clearAllEmployeeSessions,
    upsertEmployeeSession,
} from '../core/db.js';
import { clearMainSessionState, clearBossSessionOnly } from '../core/main-session.js';
import { clearPromptCache } from '../prompt/builder.js';
import { spawnAgent } from '../agent/spawn.js';
import {
    readLatestWorklog,
    appendToWorklog, updateWorklogStatus,
} from '../memory/worklog.js';
import { findEmployee, runSingleAgent } from './distribute.js';
import {
    claimWorker, finishWorker, failWorker,
    listPendingWorkerResults, claimWorkerReplay, markWorkerReplayed, releaseWorkerReplay,
    getActiveWorkers, cancelWorker, clearAllWorkers,
} from './worker-registry.js';
import { messageQueue } from '../agent/spawn.js';
import {
    getState, getPrefix, resetState, setState, getStatePrompt,
    getCtx,
    type OrcStateName,
    type OrcContext,
} from './state-machine.js';
import {
    dispatchResearchTask,
    injectResearchIntoPlanningPrompt,
    shouldRunResearch,
} from './research.js';
import { buildTaskSnapshot, getMemoryStatus } from '../memory/runtime.js';

// ─── Parser re-exports ─────────────────────────────
import {
    isContinueIntent, isResetIntent, isApproveIntent,
    parseSubtasks, parseDirectAnswer, stripSubtaskJSON,
} from './parser.js';
export {
    isContinueIntent, isResetIntent, isApproveIntent,
    parseSubtasks, parseDirectAnswer, stripSubtaskJSON,
};

type SpawnAgentLike = typeof spawnAgent;

function pickPlanningTask(userText: string, _prompt: string, ctx: Record<string, any> | null) {
    const ctxPrompt = String(ctx?.originalPrompt || '').trim();
    if (ctxPrompt) return ctxPrompt;
    const userPrompt = String(userText || '').trim();
    if (userPrompt) return userPrompt;
    return '';
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
        const pendingResults = listPendingWorkerResults();
        for (const pr of pendingResults) {
            if (!claimWorkerReplay(pr.agentId)) continue;
            try {
                await orchestrate(pr.text, { ...meta, _workerResult: true, _skipInsert: true, _skipReplayDrain: true });
                markWorkerReplayed(pr.agentId);
            } catch {
                releaseWorkerReplay(pr.agentId);
                break;
            }
        }
    }
    const runSpawnAgent: SpawnAgentLike = typeof meta._spawnAgent === 'function'
        ? meta._spawnAgent
        : spawnAgent;
    const runDispatchResearch = typeof meta._dispatchResearchTask === 'function'
        ? meta._dispatchResearchTask
        : dispatchResearchTask;
    let state = getState();
    let skipPrefix = !!meta._skipPrefix;

    // Skip session clear during active PABCD (preserve resume)
    if (!meta._skipClear && state === 'IDLE') {
        clearAllEmployeeSessions.run();
    }

    // PABCD entry is explicit only — via `/orchestrate`, `/pabcd`, or LLM tool call.
    // Auto-entry and auto-advance removed per user request.

    clearPromptCache();

    let ctx = getCtx();
    const planningTask = pickPlanningTask(userText, prompt, ctx);
    const isInitialPlanningTurn = state === 'P'
        && !meta._workerResult
        && !ctx?.plan
        && !!planningTask;

    if (isInitialPlanningTurn) {
        prompt = `${getStatePrompt('P')}\n\nUser request:\n${planningTask}`;
        skipPrefix = true;

        const nextCtx: OrcContext = {
            ...(ctx || {
                originalPrompt: '',
                workingDir: settings.workingDir || null,
                plan: null,
                workerResults: [],
                origin,
                chatId,
            }),
            originalPrompt: planningTask,
            workingDir: settings.workingDir || null,
            origin,
            chatId,
        };

        if (shouldRunResearch(planningTask, meta) && !ctx?.researchReport) {
            const report = await runDispatchResearch(planningTask, { ...meta, origin, _researchInjected: true });
            if (report.rawText) {
                prompt = injectResearchIntoPlanningPrompt(prompt, report);
            }
            nextCtx.researchNeeded = true;
            nextCtx.researchReport = report.rawText || null;
        }

        setState('P', nextCtx);
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
        const mem = getMemoryStatus();
        if (mem.routing?.searchRead === 'advanced' && !meta._workerResult) {
            memorySnapshot = buildTaskSnapshot(userText || prompt, 2800);
        }
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
    state = getState();

    if (state === 'P' && !meta._workerResult) {
        const savedCtx = getCtx();
        if (savedCtx) {
            setState('P', {
                ...savedCtx,
                plan: stripSubtaskJSON(result.text) || result.text || savedCtx.plan,
            });
        }
    }

    // Worker JSON detected → spawn workers → feed results back
    const workerTasks = parseSubtasks(result.text);
    // Research subtasks use phase 1 and can run from any state (including IDLE).
    // Non-Research subtasks only dispatch during active PABCD (P/A/B/C).
    const isResearchOnly = workerTasks?.length && workerTasks.every(
        (wt: Record<string, any>) => /^research$/i.test(wt.agent || ''),
    );
    if (workerTasks?.length && (state !== 'IDLE' || isResearchOnly)) {
        console.log(`[jaw:pabcd] worker JSON detected (${workerTasks.length} tasks, research=${!!isResearchOnly})`);

        // Map PABCD state → worker phase context
        const PABCD_PHASE_MAP: Record<string, number> = { A: 2, B: 3, C: 4 };
        const defaultPhase = PABCD_PHASE_MAP[state] || 3;

        let anyWorkerRan = false;
        for (const wt of workerTasks) {
            const emp = findEmployee(
                getEmployees.all() as Record<string, any>[],
                wt,
            );
            if (!emp) {
                console.warn(`[jaw:pabcd] worker not found: ${wt.agent}`);
                continue;
            }
            // Research workers always use phase 1 semantics
            const workerPhase = /^research$/i.test(wt.agent || '') ? 1 : defaultPhase;

            // Force fresh session for PABCD workers (prevent context contamination)
            upsertEmployeeSession.run(emp.id, null, emp.cli);

            claimWorker(emp, wt.task);
            let wResult;
            try {
                wResult = await runSingleAgent(
                    {
                        ...wt,
                        phaseProfile: [workerPhase],
                        currentPhaseIdx: 0,
                        currentPhase: workerPhase,
                        completed: false,
                        history: [],
                    },
                    emp,
                    { path: '' },
                    1,
                    { origin },
                    [],  // priorResults (empty — worker runs independently)
                );
                finishWorker(emp.id, wResult.text || '');
            } catch (err) {
                failWorker(emp.id, (err as Error).message || String(err));
                throw err;
            }
            anyWorkerRan = true;
            // Inject the worker result exactly once through the replay contract.
            // This keeps durable handoff semantics while avoiding duplicate boss processing.
            if (claimWorkerReplay(emp.id)) {
                try {
                    await orchestrate(wResult.text, {
                        ...meta,
                        _skipClear: true,
                        _workerResult: true,
                        _skipReplayDrain: true,
                    });
                    markWorkerReplayed(emp.id);
                } catch (err) {
                    releaseWorkerReplay(emp.id);
                    throw err;
                }
            }
        }
        // If no workers could be found, broadcast the original response
        if (!anyWorkerRan) {
            const stripped = stripSubtaskJSON(result.text);
            broadcast('orchestrate_done', {
                text: `[Worker dispatch failed — no matching employees]\n${stripped || result.text || ''}`,
                origin,
                chatId,
                target,
                requestId,
            });
        }
        return;
    }

    // Normal response → broadcast
    const stripped = stripSubtaskJSON(result.text);
    broadcast('orchestrate_done', {
        text: stripped || result.text || '',
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
    const state = getState();

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
    // --- cancel running workers and clear replay state on reset ---
    for (const w of getActiveWorkers()) {
        cancelWorker(w.agentId);
    }
    clearAllWorkers();
    messageQueue.length = 0;

    clearAllEmployeeSessions.run();
    // Reset boss session ID (prevents stale --resume) but keep message history
    clearBossSessionOnly();
    resetState();
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
