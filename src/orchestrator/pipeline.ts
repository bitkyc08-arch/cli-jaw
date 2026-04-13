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

import { clearPromptCache } from '../prompt/builder.js';
import { spawnAgent, killAgentById, killActiveAgent } from '../agent/spawn.js';
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
import { messageQueue, processQueue } from '../agent/spawn.js';
import {
    getState, getPrefix, resetState, setState, getStatePrompt,
    getCtx,
    type OrcStateName,
    type OrcContext,
} from './state-machine.js';
import { resolveOrcScope, findActiveScope } from './scope.js';
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
                processQueue();
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

    // Resolve scope: compute candidate from params, check for active scope (handles workingDir changes)
    const candidateScope = resolveOrcScope({
        persistedScopeId: null,
        origin,
        target,
        chatId,
        workingDir: settings.workingDir || null,
    });
    let ctx = getCtx(candidateScope);
    // If candidate scope has no active ctx, check if an existing active scope matches this origin
    const scope = ctx?.scopeId || (ctx ? candidateScope : (findActiveScope(origin, chatId) || candidateScope));

    let state = getState(scope);
    let skipPrefix = !!meta._skipPrefix;

    // Skip session clear during active PABCD (preserve resume)
    if (!meta._skipClear && state === 'IDLE') {
        clearAllEmployeeSessions.run();
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

        if (shouldRunResearch(planningTask, meta) && !ctx?.researchReport) {
            const report = await runDispatchResearch(planningTask, { ...meta, origin, _researchInjected: true });
            if (report.rawText) {
                prompt = injectResearchIntoPlanningPrompt(prompt, report);
            }
            nextCtx.researchNeeded = true;
            nextCtx.researchReport = report.rawText || null;
        }

        // Create a fresh worklog before setState() so state/title reads the new latest worklog.
        const worklogSeed = pickWorklogSeed(nextCtx.originalPrompt, planningTask, userText);
        createWorklog(worklogSeed);
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
    state = getState(scope);

    if (state === 'P' && !meta._workerResult) {
        const savedCtx = getCtx(scope);
        if (savedCtx) {
            const newPlan = stripSubtaskJSON(result.text) || result.text || savedCtx.plan;
            if (newPlan) {
                // Re-derive title from this scope's original prompt to avoid cross-scope worklog bleed
                const title = pickWorklogSeed(savedCtx.originalPrompt);
                setState('P', {
                    ...savedCtx,
                    plan: newPlan,
                }, scope, title);
            }
        }
    }

    // Worker JSON detected → spawn workers → feed results back
    const workerTasks = parseSubtasks(result.text);
    // Research subtasks can run from any state. Non-research blocked only in D.
    const isResearchOnly = workerTasks?.length && workerTasks.every(
        (wt: Record<string, any>) => /^research$/i.test(wt.agent || ''),
    );
    const canDispatchWorkers = isResearchOnly || state !== 'D';
    if (workerTasks?.length && canDispatchWorkers) {
        console.log(`[jaw:pabcd] worker JSON detected (${workerTasks.length} tasks, research=${!!isResearchOnly})`);

        // Map PABCD state → worker phase context
        const PABCD_PHASE_MAP: Record<string, number> = { A: 2, B: 3, C: 4 };
        const defaultPhase = PABCD_PHASE_MAP[state] || 3;

        const worklogSeed = pickWorklogSeed(ctx?.originalPrompt, planningTask, userText);
        const activeWorklog = isInitialPlanningTurn
            ? readLatestWorklog()
            : (readLatestWorklog() || { path: createWorklog(worklogSeed).path });

        let anyWorkerRan = false;
        let anyWorkerDispatched = false;
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
                anyWorkerDispatched = true;
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
                    { path: activeWorklog?.path || '' },
                    1,
                    { origin },
                    [],  // priorResults (empty — worker runs independently)
                );
                if (wResult.status === 'done') {
                    finishWorker(emp.id, wResult.text || '');
                } else {
                    failWorker(emp.id, wResult.text || `[worker error] ${emp.id}`);
                }
            } catch (err) {
                failWorker(emp.id, (err as Error).message || String(err));
                console.error(`[jaw:pabcd] worker ${emp.id} failed:`, (err as Error).message);
                continue;  // Don't abort remaining workers
            }
            anyWorkerRan = true;
            // Inject the worker result exactly once through the replay contract.
            // This keeps durable handoff semantics while avoiding duplicate boss processing.
            if (wResult.status === 'done' && claimWorkerReplay(emp.id)) {
                try {
                    await orchestrate(wResult.text, {
                        ...meta,
                        _skipClear: true,
                        _workerResult: true,
                        _skipReplayDrain: true,
                    });
                    markWorkerReplayed(emp.id);
                    processQueue();
                } catch (err) {
                    releaseWorkerReplay(emp.id);
                    console.error(`[jaw:pabcd] worker ${emp.id} replay failed:`, (err as Error).message);
                    continue;  // Don't abort remaining worker replays
                }
            }
        }
        // If no workers could be found, broadcast the original response
        if (!anyWorkerRan && !anyWorkerDispatched) {
            const stripped = stripSubtaskJSON(result.text);
            broadcast('orchestrate_done', {
                text: `[Worker dispatch failed — no matching employees]\n${stripped || result.text || ''}`,
                origin, chatId, target, requestId,
            });
        } else if (!anyWorkerRan && anyWorkerDispatched) {
            const stripped = stripSubtaskJSON(result.text);
            broadcast('orchestrate_done', {
                text: `[All dispatched workers failed]\n${stripped || result.text || ''}`,
                origin, chatId, target, requestId,
            });
        }
        // Ensure queue drains after all worker replays are processed
        processQueue();
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
    const candidateScope = resolveOrcScope({
        persistedScopeId: null,
        origin,
        target,
        chatId,
        workingDir: settings.workingDir || null,
    });
    const ctxCandidate = getCtx(candidateScope);
    const scope = ctxCandidate?.scopeId || (ctxCandidate ? candidateScope : (findActiveScope(origin, chatId) || candidateScope));
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
    // --- cancel running workers and clear replay state on reset ---
    killActiveAgent('reset');
    for (const w of getActiveWorkers()) {
        killAgentById(w.agentId);
        cancelWorker(w.agentId);
    }
    clearAllWorkers();
    messageQueue.length = 0;

    clearAllEmployeeSessions.run();
    const candidateScope = resolveOrcScope({
        persistedScopeId: null,
        origin,
        target,
        chatId,
        workingDir: settings.workingDir || null,
    });
    const ctxReset = getCtx(candidateScope);
    const scope = ctxReset?.scopeId || (ctxReset ? candidateScope : (findActiveScope(origin, chatId) || candidateScope));
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
