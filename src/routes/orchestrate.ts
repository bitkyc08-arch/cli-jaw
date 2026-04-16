import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import { ok, fail } from '../http/response.js';
import { isAgentBusy, messageQueue, getQueuedMessageSnapshotForScope } from '../agent/spawn.js';
import { getLiveRun } from '../agent/live-run-state.js';
import { orchestrateContinue, orchestrateReset } from '../orchestrator/pipeline.js';
import { getState, getCtx, setState, resetState, canTransition } from '../orchestrator/state-machine.js';
import type { OrcStateName } from '../orchestrator/state-machine.js';
import { resolveOrcScope } from '../orchestrator/scope.js';
import { getActiveWorkers, claimWorker, finishWorker, failWorker, markWorkerReplayed, getWorkerSlot, WorkerBusyError } from '../orchestrator/worker-registry.js';
import { findEmployee, runSingleAgent } from '../orchestrator/distribute.js';
import { getEmployees } from '../core/db.js';
import { settings } from '../core/config.js';
import { verifyBossToken } from '../core/boss-auth.js';

function getRuntimeSnapshot() {
    return {
        uptimeSec: Math.floor(process.uptime()),
        activeAgent: isAgentBusy(),
        queuePending: messageQueue.length,
    };
}

export function registerOrchestrateRoutes(app: Express, requireAuth: AuthMiddleware): void {
    app.post('/api/orchestrate/continue', requireAuth, (req, res) => {
        if (isAgentBusy()) {
            return res.status(409).json({ error: 'agent already running' });
        }
        orchestrateContinue({ origin: 'web' });
        res.json({ ok: true });
    });

    app.post('/api/orchestrate/reset', requireAuth, async (req, res) => {
        try {
            await orchestrateReset({ origin: 'web' });
            res.json({ ok: true });
        } catch (err) {
            console.error('[orchestrate:reset] error', err);
            res.status(500).json({ ok: false, error: String(err) });
        }
    });

    app.get('/api/orchestrate/state', (_req, res) => {
        const scope = resolveOrcScope({ origin: 'web', workingDir: settings.workingDir || null });
        res.json({ scope, state: getState(scope), ctx: getCtx(scope) });
    });

    app.get('/api/orchestrate/workers', (_req, res) => {
        res.json(getActiveWorkers());
    });

    app.get('/api/orchestrate/snapshot', (_req, res) => {
        const runtime = getRuntimeSnapshot();
        const scope = resolveOrcScope({ origin: 'web', workingDir: settings.workingDir || null });
        res.json({
            orc: { scope, state: getState(scope), ctx: getCtx(scope) },
            runtime: {
                ...runtime,
                busy: runtime.activeAgent || getActiveWorkers().some(w => w.state === 'running'),
            },
            workers: getActiveWorkers(),
            queued: getQueuedMessageSnapshotForScope(scope),
            activeRun: getLiveRun(scope),
        });
    });

    // Pipe-mode employee dispatch
    app.post('/api/orchestrate/dispatch', requireAuth, async (req, res) => {
        if (String(req.headers['x-jaw-dispatch-source'] || '').toLowerCase() === 'employee') {
            return fail(res, 409, 'Employee self-dispatch is blocked in employee sessions');
        }
        const { agent: agentName, task, phase } = req.body || {};
        if (!agentName || !task) return fail(res, 400, 'Missing agent or task');

        const PABCD_PHASE_MAP: Record<string, number> = { A: 2, B: 3, C: 4 };
        const dispatchScope = resolveOrcScope({ origin: 'web', workingDir: settings.workingDir || null });
        const currentOrcState = getState(dispatchScope);
        const resolvedPhase = phase ?? PABCD_PHASE_MAP[currentOrcState] ?? 3;

        const emps = getEmployees.all() as Record<string, any>[];
        const emp = findEmployee(emps, { agent: agentName });
        if (!emp) return fail(res, 404, `Employee not found: ${agentName}`);

        // Phase 7-2: reject concurrent dispatch of the same employee.
        // Caller should poll GET /api/orchestrate/worker/:agentId/result.
        let slot;
        try {
            slot = claimWorker(emp, task);
        } catch (err) {
            if (err instanceof WorkerBusyError) {
                return res.status(409).json({
                    ok: false,
                    error: 'worker_busy',
                    existing: {
                        agentId: err.existing.agentId,
                        employeeName: err.existing.employeeName,
                        task: err.existing.task.slice(0, 200),
                        startedAt: err.existing.startedAt,
                    },
                    hint: 'Poll GET /api/orchestrate/worker/:agentId/result for the in-flight run.',
                });
            }
            throw err;
        }

        // Phase 7-1: detect client disconnect so we keep pendingReplay=true
        // (so the next boss turn can drain the result) instead of discarding.
        let clientDisconnected = false;
        req.on('close', () => {
            if (!res.writableEnded) clientDisconnected = true;
        });

        try {
            const ap = {
                agent: emp.name, role: emp.role || 'general developer',
                task, parallel: false,
                currentPhase: resolvedPhase, currentPhaseIdx: 0,
                phaseProfile: [resolvedPhase],
            };
            const result = await runSingleAgent(ap, emp, {}, 1, { origin: 'api' }, []);
            finishWorker(slot.agentId, result.text || '');
            if (clientDisconnected) {
                console.warn(`[dispatch] client disconnected — keeping pendingReplay for ${slot.agentId}`);
                // pendingReplay stays true; next boss orchestrate() call drains it.
                return;
            }
            // Only clear replay flag after response is actually flushed to client.
            res.on('finish', () => markWorkerReplayed(slot.agentId));
            res.json({ ok: true, result });
        } catch (err: any) {
            failWorker(slot.agentId, err.message);
            if (!res.writableEnded) res.status(500).json({ ok: false, error: err.message });
        }
    });

    // Phase 7-4: explicit result polling for 409 retries and reconnects.
    app.get('/api/orchestrate/worker/:agentId/result', requireAuth, (req, res) => {
        const agentId = String(req.params.agentId || '');
        if (!agentId) return fail(res, 400, 'missing agentId');
        const slot = getWorkerSlot(agentId);
        if (!slot) return fail(res, 404, 'worker not found');
        if (slot.state === 'running') {
            return res.json({ ok: true, state: 'running', startedAt: slot.startedAt, task: slot.task });
        }
        // Consume pending replay — subsequent polls will return 404.
        if (slot.state === 'done' && slot.pendingReplay) {
            markWorkerReplayed(slot.agentId);
        }
        return res.json({ ok: true, state: slot.state, result: slot.result });
    });

    app.put('/api/orchestrate/state', requireAuth, (req, res) => {
        const target = String(req.body?.state || '').toUpperCase();
        const valid: OrcStateName[] = ['P', 'A', 'B', 'C', 'D'];
        if (!valid.includes(target as OrcStateName)) {
            return fail(res, 400, `Invalid state: ${target}. Must be one of: ${valid.join(', ')}`);
        }
        const scope = resolveOrcScope({ origin: 'web', workingDir: settings.workingDir || null });
        const current = getState(scope);
        const t = target as OrcStateName;
        if (!canTransition(current, t)) {
            return fail(res, 409, `Cannot transition: ${current} → ${t}`);
        }
        if (t === 'D') {
            setState(t, undefined, scope, 'Done');
            resetState(scope);
        } else {
            setState(
                t,
                t === 'P' ? { originalPrompt: '', workingDir: settings.workingDir || null, plan: null, workerResults: [], origin: 'api' } : undefined,
                scope,
                t === 'P' ? 'P' : t,
            );
        }
        res.json({ ok: true, state: getState(scope) });
    });
}
