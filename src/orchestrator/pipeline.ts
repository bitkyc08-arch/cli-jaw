// ─── PABCD Orchestration ────────────────────────────
// Old round-loop pipeline fully removed.
// PABCD state machine is the sole orchestration system.

import crypto from 'crypto';
import { broadcast } from '../core/bus.js';
import { settings } from '../core/config.js';
import {
    insertMessage, getEmployees,
    clearAllEmployeeSessions,
    upsertEmployeeSession,
    getRecentMessages,
    getLatestUnconsumedAnchor,
} from '../core/db.js';

import { clearPromptCache } from '../prompt/builder.js';
import { spawnAgent, killAgentById } from '../agent/spawn.js';
import {
    createWorklog,
    readLatestWorklog,
    appendToWorklog, upsertWorklogSection, updateWorklogStatus,
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
    parseDirectAnswer, stripSubtaskJSON, resolveNumericReference,
} from './parser.js';
export {
    isContinueIntent, isResetIntent, isApproveIntent,
    parseDirectAnswer,
};

type SpawnAgentLike = typeof spawnAgent;

function pickPlanningTask(userText: string, _prompt: string, ctx: Record<string, any> | null) {
    const ctxPrompt = String(ctx?.["originalPrompt"] || '').trim();
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

export function buildApprovedPlanPromptBlock(
    ctx: OrcContext | null,
    state: OrcStateName,
): string {
    if (!ctx?.plan) return '';
    if (!['A', 'B', 'C'].includes(state)) return '';
    return [
        '## Approved Plan (authoritative)',
        ctx.plan,
        '---',
        '## Plan consistency guard',
        '- Treat the Approved Plan as the source of truth.',
        '- Do not invent or change numeric targets, paths, resource IDs, dates, limits, or destructive operation parameters.',
        '- If your intended action conflicts with the Approved Plan, STOP and ask the user to confirm.',
        '---',
    ].join('\n');
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
    upsertEmployeeSession.run(emp["id"], null, emp["cli"], String(emp["model"] || ''));
    claimWorker(emp as { id: string; name?: string }, task["task"]);

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

        if (result["status"] === 'done') {
            finishWorker(emp["id"], String(result["text"] || ''));
        } else {
            failWorker(emp["id"], String(result["text"] || `[worker error] ${emp["id"]}`));
        }

        return { emp, result, dispatched: true, ran: true };
    } catch (err) {
        failWorker(emp["id"], (err as Error).message || String(err));
        console.error(`[jaw:pabcd] worker ${emp["id"]} failed:`, (err as Error).message);
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
    const origin = meta["origin"] || 'web';
    const chatId = meta["chatId"];
    const target = meta["target"];
    const requestId = meta["requestId"];
    const userText = String(prompt || '').trim();

    // --- drain pending worker results before normal processing ---
    if (!meta["_skipReplayDrain"]) {
        await drainPendingReplays(meta);
    }
    const runSpawnAgent: SpawnAgentLike = typeof meta["_spawnAgent"] === 'function'
        ? meta["_spawnAgent"]
        : spawnAgent;
    const scope = 'default';
    let ctx = getCtx(scope);

    let state = getState(scope);
    let skipPrefix = !!meta["_skipPrefix"];

    // Skip session clear during active PABCD (preserve resume)
    // Employee sessions are preserved across normal prompts to maintain resume state
    if (!meta["_skipClear"] && state === 'IDLE') {
        // Removed: clearAllEmployeeSessions.run()
        // Employee sessions should only be cleared on explicit /reset, not every message
    }

    // PABCD entry is explicit only — via `/orchestrate`, `/pabcd`, or LLM tool call.
    // Auto-entry and auto-advance removed per user request.

    clearPromptCache();

    ctx = getCtx(scope);
    const numericResolution = state === 'P' && !ctx?.plan
        ? resolveNumericReference(
            userText,
            getRecentMessages.all(settings["workingDir"] || null, 20) as Array<{ role?: string; content?: string }>,
        )
        : null;
    if (numericResolution?.needsConfirmation) {
        broadcast('orchestrate_done', {
            text: `${numericResolution.matchedIndex}번이 어떤 항목인지 확실하지 않습니다. 직전 목록을 다시 보여주거나 항목 이름을 직접 말해주세요.`,
            origin,
            chatId,
            target,
            requestId,
        });
        return;
    }
    const planningTask = numericResolution?.resolved || pickPlanningTask(userText, prompt, ctx);
    const isInitialPlanningTurn = state === 'P'
        && !meta["_workerResult"]
        && !meta["_skipPrefix"]
        && !ctx?.plan
        && !!planningTask;

    if (isInitialPlanningTurn) {
        prompt = `${getStatePrompt('P')}\n\nUser request:\n${planningTask}`;
        skipPrefix = true;

        const nextCtx: OrcContext = {
            ...(ctx || {
                originalPrompt: '',
                workingDir: settings["workingDir"] || null,
                scopeId: scope,
                plan: null,
                workerResults: [],
                origin,
                chatId,
            }),
            originalPrompt: planningTask,
            workingDir: settings["workingDir"] || null,
            scopeId: scope,
            origin,
            chatId,
            taskAnchor: planningTask,
            ...(numericResolution?.selection ? { resolvedSelection: numericResolution.selection } : {}),
        };

        // Create a fresh worklog before setState() so state/title reads the new latest worklog.
        const worklogSeed = pickWorklogSeed(nextCtx.originalPrompt, planningTask, userText);
        const worklogInfo = createWorklog(worklogSeed, nextCtx.taskAnchor);
        nextCtx.worklogPath = worklogInfo.path;
        setState('P', nextCtx, scope, pickWorklogSeed(nextCtx.originalPrompt));
        ctx = nextCtx;
    }

    // prefix injection
    if (origin === 'heartbeat') {
        skipPrefix = true;
    }

    // Inject heartbeat anchor for non-heartbeat user turns
    if (origin !== 'heartbeat' && !meta["_workerResult"] && !meta["_isSmokeContinuation"]) {
        type HeartbeatAnchorRow = { id?: number; created_at: number; delivered_at?: number | string | null; job_name: string; output: string };
        const anchor = getLatestUnconsumedAnchor.get(settings["workingDir"] || null) as HeartbeatAnchorRow | undefined;
        if (anchor) {
            const ageMs = Date.now() - anchor.created_at;
            if (ageMs < 30 * 60 * 1000) {
                const anchorBlock = [
                    `## Recent Heartbeat Output`,
                    `The following was generated by heartbeat job "${anchor.job_name}" and sent to you at ${new Date(anchor.delivered_at || anchor.created_at).toISOString()}.`,
                    `The user's current message may be responding to this. Ignore this block if the user clearly refers to another task.`,
                    ``,
                    `<heartbeat_output>`,
                    anchor.output.length > 4000 ? anchor.output.slice(0, 4000) + '\n[truncated]' : anchor.output,
                    `</heartbeat_output>`,
                    ``,
                    `## Current User Message`,
                ].join('\n');
                prompt = anchorBlock + '\n' + prompt;
                meta["_heartbeatAnchorId"] = anchor.id;
            }
        }
    }

    const source = meta["_workerResult"] ? 'worker' : 'user';
    const prefix = getPrefix(state, source as 'user' | 'worker');
    if (prefix && !skipPrefix) {
        prompt = prefix + '\n' + prompt;
    }
    const approvedPlanBlock = origin === 'heartbeat' ? '' : buildApprovedPlanPromptBlock(ctx, state);
    if (approvedPlanBlock) {
        prompt = `${approvedPlanBlock}\n${prompt}`;
    }

    // spawn/resume agent
    console.log(`[jaw:pabcd] state=${state}, spawning/resuming agent`);
    let memorySnapshot = '';
    try {
        const injection = buildMemoryInjection({
            role: meta["_workerResult"] ? 'employee' : 'boss',
            currentPrompt: userText || prompt,
            allowProfile: !meta["_workerResult"],
            allowSnapshot: !meta["_workerResult"],
        });
        memorySnapshot = injection.snapshot || '';
    } catch (err) {
        console.warn('[jaw:memory-snapshot]', (err as Error).message);
    }

    const { promise } = runSpawnAgent(prompt, {
        origin,
        _skipInsert: !!meta["_skipInsert"],
        memorySnapshot,
        _heartbeatAnchorId: meta["_heartbeatAnchorId"],
    });
    const result = await promise as Record<string, any>;

    // Re-read state from DB — it may have changed during agent execution
    // (phase transitions via CLI commands, user reset, etc.)
    state = getState(scope);

    if (state === 'P' && !meta["_workerResult"]) {
        const savedCtx = getCtx(scope);
        if (savedCtx) {
            const newPlan = stripSubtaskJSON(result["text"]) || result["text"] || savedCtx.plan;
            if (newPlan) {
                // Re-derive title from this scope's original prompt to avoid cross-scope worklog bleed
                const title = pickWorklogSeed(savedCtx.originalPrompt);

                // Phase 56.1: plan persists in worklog + ctx only. No project-root file.
                const updatedAt = new Date().toISOString();
                const planHash = crypto.createHash('sha256').update(newPlan).digest('hex').slice(0, 12);

                // Worklog ## Plan section (upsert — replaces "(대기 중)" and never accumulates)
                if (savedCtx.worklogPath) {
                    upsertWorklogSection(savedCtx.worklogPath, 'Plan', newPlan);
                }

                // Phase 56.1: explicitly omit legacy sharedPlanPath from DB row carry-over.
                const { sharedPlanPath: _legacy, ...restCtx } = savedCtx as typeof savedCtx & { sharedPlanPath?: string };
                void _legacy;
                setState('P', {
                    ...restCtx,
                    plan: newPlan,
                    planHash,
                    planUpdatedAt: updatedAt,
                }, scope, title);
            }
        }
    }

    // Normal response → broadcast
    // (Worker JSON dispatch removed in patch3 — Boss calls `cli-jaw dispatch` directly)
    broadcast('orchestrate_done', {
        text: result["text"] || '',
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
    const origin = meta["origin"] || 'web';
    const chatId = meta["chatId"];
    const target = meta["target"];
    const requestId = meta["requestId"];
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
    const origin = meta["origin"] || 'web';
    const chatId = meta["chatId"];
    const target = meta["target"];
    const requestId = meta["requestId"];
    // --- cancel PABCD workers only — preserve main agent + message queue ---
    for (const w of getActiveWorkers()) {
        killAgentById(w.agentId);
        cancelWorker(w.agentId);
    }
    clearAllWorkers();
    clearAllEmployeeSessions.run();
    const scope = 'default';
    resetState(scope);
    try {
        const { drainPending } = await import('../memory/heartbeat.js');
        await drainPending();
    } catch (err) {
        console.warn('[jaw:pabcd] heartbeat drain after reset failed:', (err as Error).message);
    }
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
