import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JAW_HOME } from '../core/config.js';
import type { GoalState, GoalHistory, GoalCheckpoint, GoalBudget, GoalPauseAudit, GoalMode } from './types.js';

const GOAL_DIR = path.join(JAW_HOME, 'goal');
const ACTIVE_PATH = path.join(GOAL_DIR, 'active.json');
const HISTORY_PATH = path.join(GOAL_DIR, 'history.json');
export const MAX_GOAL_OBJECTIVE_CHARS = 10000;
export const MAX_GOAL_PLAN_HINT_CHARS = MAX_GOAL_OBJECTIVE_CHARS;

function ensureDir(): void {
    fs.mkdirSync(GOAL_DIR, { recursive: true });
}

function writeJson(filePath: string, data: unknown): void {
    ensureDir();
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch (error) {
        if (fs.existsSync(filePath)) {
            console.warn(`[goal] failed to read ${filePath}: ${(error as Error).message}`);
        }
        return null;
    }
}

export function getActiveGoal(): GoalState | null {
    return readJson<GoalState>(ACTIVE_PATH);
}

export function getGoalHistory(): GoalHistory {
    return readJson<GoalHistory>(HISTORY_PATH) ?? { goals: [] };
}

export function setGoal(objective: string, opts?: { repoRoot?: string | undefined; budget?: GoalBudget | undefined; replace?: boolean; goalMode?: GoalMode; planHint?: string | undefined }): GoalState {
    const normalizedObjective = objective.trim();
    if (!normalizedObjective) throw new Error('Goal objective is required.');
    if (normalizedObjective.length > MAX_GOAL_OBJECTIVE_CHARS) {
        throw new Error(`Goal objective exceeds ${MAX_GOAL_OBJECTIVE_CHARS} characters.`);
    }
    const normalizedPlanHint = opts?.planHint?.trim();
    if (normalizedPlanHint && normalizedPlanHint.length > MAX_GOAL_PLAN_HINT_CHARS) {
        throw new Error(`Goal plan hint exceeds ${MAX_GOAL_PLAN_HINT_CHARS} characters.`);
    }
    const existing = getActiveGoal();
    if (existing && (existing.status === 'active' || existing.status === 'paused')) {
        if (!opts?.replace) {
            throw new Error(`Active goal already exists: "${existing.objective.slice(0, 80)}". Cancel or complete it first, or pass replace: true.`);
        }
        archiveGoal(existing);
    }
    const now = new Date().toISOString();
    const goal: GoalState = {
        id: crypto.randomUUID().slice(0, 12),
        objective: normalizedObjective,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        repoRoot: opts?.repoRoot,
        goalMode: opts?.goalMode,
        ...(normalizedPlanHint ? { planHint: normalizedPlanHint } : {}),
        budget: opts?.budget,
        checkpoints: [],
    };
    writeJson(ACTIVE_PATH, goal);
    return goal;
}

export function refineObjective(newObjective: string): GoalState | null {
    const goal = getActiveGoal();
    if (!goal || goal.status !== 'active') return null;
    const trimmed = newObjective.trim();
    if (!trimmed || trimmed.length > MAX_GOAL_OBJECTIVE_CHARS) return null;
    goal.objective = trimmed;
    goal.goalMode = 'direct';
    goal.agentPauseCount = 0;
    delete goal.planHint;
    goal.updatedAt = new Date().toISOString();
    writeJson(ACTIVE_PATH, goal);
    return goal;
}

export function updateGoal(summary: string, nextAction = '', evidence: string[] = []): GoalState | null {
    const goal = getActiveGoal();
    if (!goal || goal.status !== 'active') return null;
    if (goal.goalMode === 'plan') return null;
    const cp: GoalCheckpoint = {
        summary,
        nextAction,
        evidencePaths: evidence,
        timestamp: new Date().toISOString(),
    };
    goal.checkpoints.push(cp);
    goal.lastCheckpoint = cp;
    goal.agentPauseCount = 0;
    goal.updatedAt = new Date().toISOString();
    writeJson(ACTIVE_PATH, goal);
    return goal;
}

export function completeGoal(note?: string): GoalState | null {
    const goal = getActiveGoal();
    if (!goal) {
        forceDeleteActive();
        return null;
    }
    goal.status = 'complete';
    if (note) goal.completionNote = note;
    goal.updatedAt = new Date().toISOString();
    archiveGoal(goal);
    forceDeleteActive();
    return goal;
}

export function cancelGoal(reason?: string): GoalState | null {
    const goal = getActiveGoal();
    if (!goal) {
        forceDeleteActive();
        return null;
    }
    goal.status = 'cancelled';
    if (reason) goal.cancelReason = reason;
    goal.updatedAt = new Date().toISOString();
    archiveGoal(goal);
    forceDeleteActive();
    return goal;
}

export function pauseGoal(opts?: { reason?: string | undefined; audit?: GoalPauseAudit | undefined }): GoalState | null {
    const goal = getActiveGoal();
    if (!goal) return null;
    if (goal.status === 'paused' && opts?.audit) {
        if (opts.reason) goal.pauseReason = opts.reason;
        goal.pauseAudit = opts.audit;
        goal.agentPauseCount = 0;
        goal.updatedAt = new Date().toISOString();
        writeJson(ACTIVE_PATH, goal);
        return goal;
    }
    if (goal.status !== 'active') return null;
    goal.status = 'paused';
    if (opts?.reason) goal.pauseReason = opts.reason;
    if (opts?.audit) goal.pauseAudit = opts.audit;
    goal.agentPauseCount = 0;
    goal.updatedAt = new Date().toISOString();
    writeJson(ACTIVE_PATH, goal);
    return goal;
}

export function resumeGoal(): GoalState | null {
    const goal = getActiveGoal();
    if (!goal || goal.status !== 'paused') return null;
    goal.status = 'active';
    goal.agentPauseCount = 0;
    goal.updatedAt = new Date().toISOString();
    writeJson(ACTIVE_PATH, goal);
    return goal;
}

export function clearGoal(): boolean {
    const goal = getActiveGoal();
    if (!goal) {
        forceDeleteActive();
        return false;
    }
    goal.status = 'cancelled';
    goal.updatedAt = new Date().toISOString();
    archiveGoal(goal);
    forceDeleteActive();
    return true;
}

export function resetGoalStore(): void {
    try { fs.unlinkSync(ACTIVE_PATH); } catch { /* noop */ }
    try { fs.unlinkSync(HISTORY_PATH); } catch { /* noop */ }
}

function forceDeleteActive(): void {
    try { fs.unlinkSync(ACTIVE_PATH); } catch { /* file may not exist */ }
}

function archiveGoal(goal: GoalState): void {
    const history = getGoalHistory();
    history.goals.unshift(goal);
    if (history.goals.length > 50) history.goals.length = 50;
    writeJson(HISTORY_PATH, history);
}

export function getAgentPauseCount(): number {
    const goal = getActiveGoal();
    return goal?.agentPauseCount ?? 0;
}

export function incrementAgentPauseCount(): GoalState | null {
    const goal = getActiveGoal();
    if (!goal || goal.status !== 'active') return null;
    goal.agentPauseCount = (goal.agentPauseCount ?? 0) + 1;
    goal.updatedAt = new Date().toISOString();
    writeJson(ACTIVE_PATH, goal);
    return goal;
}

export function resetAgentPauseCount(): void {
    const goal = getActiveGoal();
    if (!goal || !goal.agentPauseCount) return;
    goal.agentPauseCount = 0;
    goal.updatedAt = new Date().toISOString();
    writeJson(ACTIVE_PATH, goal);
}

/** Completion-gate predicate: AI may complete only if the latest checkpoint carries at least one NON-BLANK verification evidence entry (blank/whitespace entries never satisfy the gate, regardless of how they were inserted). */
export function goalHasCompletionEvidence(goal: GoalState | null): boolean {
    return (goal?.lastCheckpoint?.evidencePaths ?? []).some(e => typeof e === 'string' && e.trim().length > 0);
}
