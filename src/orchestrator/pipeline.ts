// ─── PABCD Orchestration ────────────────────────────
// Old round-loop pipeline fully removed.
// PABCD state machine is the sole orchestration system.

import { broadcast } from '../core/bus.js';
import {
    insertMessage, getEmployees,
    clearAllEmployeeSessions,
    upsertEmployeeSession,
} from '../core/db.js';
import { clearPromptCache } from '../prompt/builder.js';
import { spawnAgent } from '../agent/spawn.js';
import {
    readLatestWorklog,
    appendToWorklog, updateWorklogStatus,
} from '../memory/worklog.js';
import { findEmployee, runSingleAgent } from './distribute.js';
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
    isContinueIntent, isResetIntent, isApproveIntent, needsOrchestration,
    parseSubtasks, parseDirectAnswer, stripSubtaskJSON,
} from './parser.js';
export {
    isContinueIntent, isResetIntent, isApproveIntent, needsOrchestration,
    parseSubtasks, parseDirectAnswer, stripSubtaskJSON,
};

const PABCD_ACTIVATE_PATTERNS = [
    /^\/?orchestrate$/i,
    /^\/?pabcd$/i,
    /^지휘\s*모드$/i,
    /^오케스트레이션(?:\s*모드)?$/i,
    /^orchestration(?:\s*mode)?$/i,
];

const AUTO_APPROVE_NEXT: Partial<Record<OrcStateName, OrcStateName>> = {
    P: 'A',
    A: 'B',
    B: 'C',
};

type SpawnAgentLike = typeof spawnAgent;

function isPabcdActivationPrompt(text: string) {
    const t = String(text || '').trim();
    if (!t) return false;
    return PABCD_ACTIVATE_PATTERNS.some(re => re.test(t));
}

function pickPlanningTask(userText: string, _prompt: string, ctx: Record<string, any> | null) {
    const ctxPrompt = String(ctx?.originalPrompt || '').trim();
    if (ctxPrompt && !isPabcdActivationPrompt(ctxPrompt)) return ctxPrompt;

    const userPrompt = String(userText || '').trim();
    if (userPrompt && !isPabcdActivationPrompt(userPrompt)) return userPrompt;

    return '';
}

function shouldAutoActivatePABCD(prompt: string, meta: Record<string, any>) {
    const t = String(prompt || '').trim();
    if (!t) return false;
    if (meta._workerResult || meta._skipAutoP) return false;
    // Only activate via explicit trigger words — NOT auto for every complex message.
    return PABCD_ACTIVATE_PATTERNS.some(re => re.test(t));
}

// ─── orchestrate (PABCD sole entry point) ───────────

export async function orchestrate(
    prompt: string,
    meta: Record<string, any> = {},
) {
    const origin = meta.origin || 'web';
    const chatId = meta.chatId;
    const userText = String(prompt || '').trim();
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

    // Auto-enter P mode from IDLE for orchestration-worthy tasks.
    if (state === 'IDLE' && shouldAutoActivatePABCD(userText, meta)) {
        setState('P', {
            originalPrompt: userText || prompt,
            plan: null,
            workerResults: [],
            origin,
            chatId,
        });
        state = 'P';
        prompt = `${getStatePrompt('P')}\n\nUser request:\n${userText || prompt}`;
        skipPrefix = true;
        console.log('[jaw:pabcd] auto-transition IDLE -> P');
    }

    // Auto-advance by explicit approval intent (no shell command dependency).
    if (state !== 'IDLE' && !meta._workerResult && isApproveIntent(userText)) {
        const next = AUTO_APPROVE_NEXT[state as OrcStateName];
        if (next) {
            const prev = state;
            setState(next);
            state = next;
            prompt = `${getStatePrompt(next)}\n\nUser approval:\n${userText}`;
            skipPrefix = true;
            console.log(`[jaw:pabcd] auto-transition ${prev} -> ${next} (approve intent)`);
        }
    }

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
                plan: null,
                workerResults: [],
                origin,
                chatId,
            }),
            originalPrompt: planningTask,
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

            const wResult = await runSingleAgent(
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
            anyWorkerRan = true;
            // Feed worker results back to the main agent
            await orchestrate(wResult.text, {
                ...meta,
                _skipClear: true,
                _workerResult: true,
            });
        }
        // If no workers could be found, broadcast the original response
        if (!anyWorkerRan) {
            const stripped = stripSubtaskJSON(result.text);
            broadcast('orchestrate_done', {
                text: `[Worker dispatch failed — no matching employees]\n${stripped || result.text || ''}`,
                origin,
                chatId,
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
    });
}

// ─── Continue ───────────────────────────────────────

export async function orchestrateContinue(
    meta: Record<string, any> = {},
) {
    const origin = meta.origin || 'web';
    const chatId = meta.chatId;
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
    clearAllEmployeeSessions.run();
    resetState();
    const latest = readLatestWorklog();
    if (!latest) {
        broadcast('orchestrate_done', {
            text: 'Reset complete.',
            origin,
            chatId,
        });
        return;
    }
    updateWorklogStatus(latest.path, 'reset', 0);
    appendToWorklog(latest.path, 'Final Summary', 'Reset by user request.');
    broadcast('orchestrate_done', {
        text: 'Reset complete.',
        origin,
        chatId,
    });
}
