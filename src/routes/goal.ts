import { Router, type RequestHandler } from 'express';
import {
    getActiveGoal, getGoalHistory,
    setGoal, updateGoal, refineObjective, completeGoal, cancelGoal,
    pauseGoal, resumeGoal, clearGoal, resetGoalStore,
    goalHasCompletionEvidence,
    getAgentPauseCount, incrementAgentPauseCount,
    MAX_GOAL_OBJECTIVE_CHARS,
    MAX_GOAL_PLAN_HINT_CHARS,
} from '../goal/store.js';
import type { GoalMode } from '../goal/types.js';
import { describeGoalPauseGate } from '../goal/pause-gate.js';
import { clearGoalTimers, kickGoalContinuation } from '../agent/lifecycle-handler.js';

export function registerGoalRoutes(app: Router, requireAuth: RequestHandler): void {
    app.get('/api/goal', requireAuth, (_req, res) => {
        const goal = getActiveGoal();
        res.json({ ok: true, goal, pauseGate: describeGoalPauseGate(goal) });
    });

    app.get('/api/goal/history', requireAuth, (req, res) => {
        const limit = Math.min(Number(req.query['limit']) || 10, 50);
        const history = getGoalHistory();
        res.json({ ok: true, goals: history.goals.slice(0, limit) });
    });

    app.post('/api/goal', requireAuth, (req, res) => {
        const body = req.body as Record<string, unknown> | undefined;
        const action = String(body?.['action'] || 'set');
        try {
            switch (action) {
                case 'set': {
                    const objective = String(body?.['objective'] || '').trim();
                    if (!objective) {
                        res.status(400).json({ ok: false, error: 'objective is required' });
                        return;
                    }
                    if (objective.length > MAX_GOAL_OBJECTIVE_CHARS) {
                        res.status(400).json({ ok: false, error: `objective must be ${MAX_GOAL_OBJECTIVE_CHARS} characters or fewer` });
                        return;
                    }
                    const repoRoot = body?.['repoRoot'] as string | undefined;
                    const budget = body?.['budget'] as Record<string, number> | undefined;
                    const goalMode = body?.['goalMode'] as GoalMode | undefined;
                    const replace = body?.['replace'] === true;
                    const replaceExisting = replace || goalMode === 'plan';
                    const existing = getActiveGoal();
                    if (existing && (existing.status === 'active' || existing.status === 'paused') && !replaceExisting) {
                        res.status(409).json({ ok: false, error: `Active goal already exists: "${existing.objective}". Cancel or complete it first, or pass replace: true.` });
                        return;
                    }
                    clearGoalTimers();
                    const planHint = typeof body?.['planHint'] === 'string' ? String(body?.['planHint']).trim() : '';
                    if (planHint.length > MAX_GOAL_PLAN_HINT_CHARS) {
                        res.status(400).json({ ok: false, error: `planHint must be ${MAX_GOAL_PLAN_HINT_CHARS} characters or fewer` });
                        return;
                    }
                    const goal = setGoal(objective, {
                        ...(repoRoot ? { repoRoot } : {}),
                        ...(budget ? { budget } : {}),
                        ...(goalMode ? { goalMode } : {}),
                        ...(planHint ? { planHint } : {}),
                        ...(replaceExisting ? { replace: true } : {}),
                    });
                    res.json({ ok: true, goal });
                    return;
                }
                case 'update': {
                    const summary = String(body?.['summary'] || '').trim();
                    if (!summary) {
                        res.status(400).json({ ok: false, error: 'summary is required' });
                        return;
                    }
                    const ev = body?.['evidence'];
                    const evidence = Array.isArray(ev) ? ev.map(String) : (typeof ev === 'string' && ev ? [ev] : []);
                    const active = getActiveGoal();
                    if (active?.goalMode === 'plan') {
                        res.status(409).json({ ok: false, error: 'Goal plan must be refined before checkpoints. Run `cli-jaw goal refine "<specific objective>"` first.' });
                        return;
                    }
                    const goal = updateGoal(summary, String(body?.['nextAction'] || ''), evidence);
                    if (!goal) { res.status(404).json({ ok: false, error: 'No active goal' }); return; }
                    res.json({ ok: true, goal });
                    return;
                }
                case 'refine-objective': {
                    const newObjective = String(body?.['objective'] || '').trim();
                    if (!newObjective) {
                        res.status(400).json({ ok: false, error: 'objective is required' });
                        return;
                    }
                    const refined = refineObjective(newObjective);
                    if (!refined) { res.status(404).json({ ok: false, error: 'No active goal to refine' }); return; }
                    res.json({ ok: true, goal: refined });
                    return;
                }
                case 'done': {
                    const force = body?.['force'] === true;
                    if (!force && !goalHasCompletionEvidence(getActiveGoal())) {
                        res.status(409).json({ ok: false, error: 'Goal completion requires verification evidence on the latest checkpoint. Log it via `cli-jaw goal update "<summary>" --evidence "<test result / changed file>"`, then retry — or pass --force for an explicit manual override.' });
                        return;
                    }
                    const goal = completeGoal(body?.['note'] as string | undefined);
                    if (!goal) { res.status(404).json({ ok: false, error: 'No active goal' }); return; }
                    clearGoalTimers();
                    res.json({ ok: true, goal });
                    return;
                }
                case 'cancel': {
                    const goal = cancelGoal(body?.['reason'] as string | undefined);
                    if (!goal) { res.status(404).json({ ok: false, error: 'No active goal' }); return; }
                    clearGoalTimers();
                    res.json({ ok: true, goal });
                    return;
                }
                case 'pause': {
                    const actor = body?.['actor'] === 'agent' ? 'agent' : 'human';
                    const auditEvidence = String(body?.['audit'] || '').trim();
                    if (actor === 'agent' && !auditEvidence) {
                        res.status(409).json({ ok: false, error: 'Agent-initiated goal pause requires independent audit evidence. Run an independent reviewer first, then retry with `cli-jaw goal pause --agent --audit "<review summary>"`.' });
                        return;
                    }
                    if (actor === 'agent' && getAgentPauseCount() < 1) {
                        const armedGoal = incrementAgentPauseCount() ?? getActiveGoal();
                        res.status(409).json({
                            ok: false,
                            blocked: true,
                            pauseGate: describeGoalPauseGate(armedGoal),
                            error: 'First agent pause attempt recorded (1/2). Pause NOT executed. '
                                + 'Complete the dev-skill audit checklist injected in the next goal continuation, '
                                + 'then call `cli-jaw goal pause --agent --audit "<evidence>"` again to pause. '
                                + 'A productive checkpoint clears the pending pause gate.',
                        });
                        return;
                    }
                    const reason = String(body?.['reason'] || '').trim();
                    const goal = pauseGoal({
                        ...(reason ? { reason } : {}),
                        ...(auditEvidence ? {
                            audit: {
                                actor,
                                evidence: auditEvidence,
                                timestamp: new Date().toISOString(),
                            },
                        } : {}),
                    });
                    if (!goal) { res.status(400).json({ ok: false, error: 'No active goal to pause' }); return; }
                    clearGoalTimers();
                    res.json({ ok: true, goal });
                    return;
                }
                case 'resume': {
                    const existing = getActiveGoal();
                    if (existing && existing.status === 'active') {
                        res.json({ ok: true, goal: existing, alreadyActive: true });
                        return;
                    }
                    const goal = resumeGoal();
                    if (!goal) { res.status(400).json({ ok: false, error: 'No active or paused goal to resume' }); return; }
                    kickGoalContinuation();
                    res.json({ ok: true, goal });
                    return;
                }
                case 'clear': {
                    clearGoalTimers();
                    const ok = clearGoal();
                    res.json({ ok, cleared: ok });
                    return;
                }
                case 'reset': {
                    clearGoalTimers();
                    resetGoalStore();
                    res.json({ ok: true, reset: true });
                    return;
                }
                default:
                    res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
            }
        } catch (err) {
            res.status(500).json({ ok: false, error: (err as Error).message });
        }
    });
}
