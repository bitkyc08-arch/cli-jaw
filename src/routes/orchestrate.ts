import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import { ok, fail } from '../http/response.js';
import { isAgentBusy, messageQueue, getQueuedMessageSnapshotForScope, removeQueuedMessage, killActiveAgent, waitForProcessEnd, getCurrentMainMeta } from '../agent/spawn.js';
import { getLiveRun } from '../agent/live-run-state.js';
import { orchestrate, orchestrateContinue, orchestrateReset, isContinueIntent, isResetIntent, drainPendingReplays } from '../orchestrator/pipeline.js';
import { insertMessage } from '../core/db.js';
import { getState, getCtx, setState, resetState, canTransition, resetAllStaleStates } from '../orchestrator/state-machine.js';
import type { OrcStateName } from '../orchestrator/state-machine.js';
import { resolveOrcScope } from '../orchestrator/scope.js';
import { getActiveWorkers, claimWorker, finishWorker, failWorker, markWorkerReplayed, getWorkerSlot, WorkerBusyError } from '../orchestrator/worker-registry.js';
import { findEmployee, runSingleAgent } from '../orchestrator/distribute.js';
import { getEmployees } from '../core/db.js';
import { settings } from '../core/config.js';
import { verifyBossToken } from '../core/boss-auth.js';
import { resolveDispatchableEmployee, checkRuntimeHints, checkModelSupport } from '../core/employees.js';

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
            const all = req.query.all === 'true' || req.body?.all === true;
            if (all) {
                const cleared = resetAllStaleStates();
                return res.json({ ok: true, cleared, message: `Cleared ${cleared} stale state(s)` });
            }
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
        const ctx = getCtx(scope);
        res.json({
            orc: {
                scope,
                state: getState(scope),
                ctx,
                // Phase 56: explicit plan metadata for UI/worker reference
                sharedPlanPath: ctx?.sharedPlanPath || null,
                planHash: ctx?.planHash || null,
                planUpdatedAt: ctx?.planUpdatedAt || null,
            },
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
    app.delete('/api/orchestrate/queue/:id', requireAuth, (req, res) => {
        const id = String(req.params.id || '');
        if (!id) return fail(res, 400, 'missing id');
        const result = removeQueuedMessage(id);
        if (!result.removed) return fail(res, 404, 'queued item not found');
        return res.json({ ok: true, pending: result.pending });
    });

    app.post('/api/orchestrate/queue/:id/steer', requireAuth, async (req, res) => {
        const id = String(req.params.id || '');
        if (!id) return fail(res, 400, 'missing id');
        // Fix B (W-1+W-2): peek 먼저 → kill+wait → remove → DB insert (processQueue 미러)
        // → orchestrate(_skipInsert). submitMessage idle 분기를 거치지 않아 두 번째
        // insertMessage / broadcast('new_message')가 발생하지 않는다.
        const peek = messageQueue.find(item => item.id === id);
        if (!peek) return fail(res, 404, 'queued item not found');
        const prompt = peek.prompt;
        const origin = peek.source || 'web';
        if (isAgentBusy()) {
            killActiveAgent('steer');
            await waitForProcessEnd(3000);
        }
        const result = removeQueuedMessage(id);
        if (!result.removed) return fail(res, 404, 'queued item disappeared during steer');
        try {
            insertMessage.run('user', prompt, origin, '', settings.workingDir || null);
        } catch (err) {
            console.warn('[steer:insert]', (err as Error).message);
        }
        // Web client renders user bubble only on fromQueue=true (chat.ts dropped
        // the optimistic bubble at enqueue time). processQueue does the same broadcast
        // when an item drains naturally; steer is the manual equivalent.
        const { broadcast } = await import('../core/bus.js');
        broadcast('new_message', { role: 'user', content: prompt, source: origin, fromQueue: true });
        const task = isResetIntent(prompt)
            ? orchestrateReset({ origin, _skipInsert: true })
            : isContinueIntent(prompt)
                ? orchestrateContinue({ origin, _skipInsert: true })
                : orchestrate(prompt, { origin, _skipInsert: true });
        task.catch((err: Error) => console.error('[steer:orchestrate]', err.message));
        return res.json({ ok: true, pending: result.pending });
    });

    app.post('/api/orchestrate/dispatch', requireAuth, async (req, res) => {
        // Phase 8: server-authoritative dispatch guard. Boss-only token required.
        // Employees do not have this token (stripped in spawn.ts makeCleanEnv).
        const bossToken = String(req.headers['x-jaw-boss-token'] || '');
        if (!verifyBossToken(bossToken)) {
            console.warn(`[dispatch:deny] ip=${req.ip} ua=${String(req.headers['user-agent'] || '').slice(0, 80)}`);
            return fail(res, 403, 'Dispatch requires boss-scoped token. Employees cannot dispatch.');
        }
        const { agent: agentName, task, phase } = req.body || {};
        if (!agentName || !task) return fail(res, 400, 'Missing agent or task');

        const PABCD_PHASE_MAP: Record<string, number> = { A: 2, B: 3, C: 4 };
        const dispatchScope = resolveOrcScope({ origin: 'web', workingDir: settings.workingDir || null });
        const currentOrcState = getState(dispatchScope);
        const resolvedPhase = phase ?? PABCD_PHASE_MAP[currentOrcState] ?? 3;

        const emps = getEmployees.all() as Record<string, any>[];
        // Try DB first (preserves existing id-based matching), then fall
        // through to static employees for entries like Control.
        let emp = findEmployee(emps, { agent: agentName });
        let staticSpec: ReturnType<typeof resolveDispatchableEmployee> = null;
        if (!emp) {
            staticSpec = resolveDispatchableEmployee(agentName, emps);
            if (staticSpec) emp = staticSpec.row;
        } else {
            staticSpec = resolveDispatchableEmployee(emp.name, emps);
        }
        if (!emp) return fail(res, 404, `Employee not found: ${agentName}`);

        // Runtime preflight for static employees (platform check only).
        if (staticSpec?.spec) {
            const checks = checkRuntimeHints(staticSpec.spec);
            if (checks.fail.length > 0) {
                return fail(res, 412, `Preconditions not met: ${checks.fail.join('; ')}`);
            }
        }

        // Model-level preflight (e.g. Spark family on ChatGPT OAuth) — fails fast
        // rather than wasting a spawn on an API 400.
        {
            const modelChecks = checkModelSupport(emp.cli, emp.model);
            if (modelChecks.fail.length > 0) {
                return fail(res, 412, `Model not supported: ${modelChecks.fail.join('; ')}`);
            }
            for (const w of modelChecks.warn) {
                console.warn(`[orchestrate] model warn: ${w}`);
            }
        }

        // Phase 7-2: reject concurrent dispatch of the same employee.
        // Caller should poll GET /api/orchestrate/worker/:agentId/result.
        // Capture the current Boss main session's channel so disconnected
        // worker results later drain back to the correct origin/chatId,
        // not a generic 'system' scope.
        const bossMeta = getCurrentMainMeta();
        const replayMeta = bossMeta ? {
            origin: bossMeta.origin,
            target: bossMeta.target,
            chatId: bossMeta.chatId,
            requestId: bossMeta.requestId,
            scopeId: bossMeta.scopeId,
        } : undefined;
        let slot;
        try {
            slot = claimWorker(emp, task, replayMeta);
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

        // Detect client abort: hook the RESPONSE's 'close' (not request's) and
        // check writableFinished — per Node.js docs, response 'close' fires once
        // the underlying connection is closed, and writableFinished is true only
        // if ALL data was flushed. This correctly distinguishes normal completion
        // from early abort. req.on('close') was unreliable because it fires on
        // normal keep-alive teardown too, leading to false-positive disconnects.
        // See: https://nodejs.org/docs/latest/api/http.html (response.writableFinished)
        let clientDisconnected = false;
        res.on('close', () => {
            if (!res.writableFinished) clientDisconnected = true;
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
                // Proactive drain: if Boss died before receiving the result, user input
                // would otherwise stall forever. Trigger drainPendingReplays so the result
                // is fed back via a fresh Boss session without waiting for the next user
                // message. See devlog/_plan/260417_message_duplication/02_*.
                if (!isAgentBusy()) {
                    queueMicrotask(() => {
                        drainPendingReplays({ origin: 'system' })
                            .catch(err => console.error('[dispatch:drain]', (err as Error).message));
                    });
                }
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
