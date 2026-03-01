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
    type OrcStateName,
} from './state-machine.js';

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

    // prefix injection
    const source = meta._workerResult ? 'worker' : 'user';
    const prefix = getPrefix(state, source as 'user' | 'worker');
    if (prefix && !skipPrefix) {
        prompt = prefix + '\n' + prompt;
    }

    // spawn/resume agent
    console.log(`[jaw:pabcd] state=${state}, spawning/resuming agent`);
    const { promise } = spawnAgent(prompt, {
        origin,
        _skipInsert: !!meta._skipInsert,
    });
    const result = await promise as Record<string, any>;

    // Worker JSON detected → spawn workers → feed results back
    const workerTasks = parseSubtasks(result.text);
    if (workerTasks?.length && state !== 'IDLE') {
        // Only dispatch workers during active PABCD (P/A/B/C).
        // In IDLE, subtask JSON is handled by the middleware, not here.
        console.log(`[jaw:pabcd] worker JSON detected (${workerTasks.length} tasks)`);

        // Map PABCD state → worker phase context
        const PABCD_PHASE_MAP: Record<string, number> = { A: 2, B: 3, C: 4 };
        const workerPhase = PABCD_PHASE_MAP[state] || 3;

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
