// ─── /api/bgtask — background runtime hook surface ───
// Register/list/cancel server-owned background tasks. POST auto-captures the
// current boss channel meta (getCurrentMainMeta) when originMeta is omitted,
// so `cli-jaw bgtask add` from a boss Bash turn keeps telegram/discord routing.

import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import { createTask, getTask, listTasks, DuplicateBgTaskError } from '../bgtask/registry.js';
import { startTask, cancelTask, isTaskRunnerActive } from '../bgtask/runner.js';
import { notifyTask } from '../bgtask/notifier.js';
import { webAiPreset } from '../bgtask/presets.js';
import { validateBgTaskSpec, type BgTaskSpec, type BgTaskStatus, type OriginMeta } from '../bgtask/types.js';
import { getCurrentMainMeta } from '../agent/spawn.js';

const VALID_STATUSES = new Set(['running', 'complete', 'failed', 'cancelled', 'orphaned']);

function onTerminal(taskId: string): void {
    notifyTask(taskId).catch((err: Error) => {
        console.error(`[bgtask:${taskId}] notify failed:`, err.message);
    });
}

export function registerBgtaskRoutes(app: Express, requireAuth: AuthMiddleware): void {
    app.get('/api/bgtask', requireAuth, (req, res) => {
        const statusRaw = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
        if (statusRaw && !VALID_STATUSES.has(statusRaw)) {
            res.status(400).json({ error: `invalid status: ${statusRaw}` });
            return;
        }
        const limit = Number(req.query['limit']) > 0 ? Number(req.query['limit']) : 100;
        const tasks = listTasks({ ...(statusRaw ? { status: statusRaw as BgTaskStatus } : {}), limit });
        res.json({ tasks: tasks.map((t) => ({ ...t, runnerActive: isTaskRunnerActive(t.id) })) });
    });

    app.get('/api/bgtask/:id', requireAuth, (req, res) => {
        const task = getTask(String(req.params['id']));
        if (!task) {
            res.status(404).json({ error: 'task not found' });
            return;
        }
        res.json({ task: { ...task, runnerActive: isTaskRunnerActive(task.id) } });
    });

    app.post('/api/bgtask', requireAuth, async (req, res) => {
        try {
            const body = (req.body ?? {}) as Record<string, unknown>;
            let kind: string;
            let spec: BgTaskSpec;
            let warnings: string[] = [];

            if (body['preset'] === 'web-ai') {
                if (typeof body['sessionId'] !== 'string' || !body['sessionId'].trim()) {
                    res.status(400).json({ error: 'web-ai preset requires sessionId' });
                    return;
                }
                const preset = await webAiPreset({
                    sessionId: body['sessionId'],
                    ...(typeof body['prompt'] === 'string' ? { prompt: body['prompt'] } : {}),
                    ...(typeof body['deadlineAt'] === 'string' ? { deadlineAt: body['deadlineAt'] } : {}),
                    ...(Number(body['stallAfterMs']) > 0 ? { stallAfterMs: Number(body['stallAfterMs']) } : {}),
                });
                kind = preset.kind;
                spec = preset.spec;
                warnings = preset.warnings;
            } else if (body['preset'] !== undefined) {
                res.status(400).json({ error: `unknown preset: ${String(body['preset'])}` });
                return;
            } else {
                const validation = validateBgTaskSpec(body['spec']);
                if (!validation.ok) {
                    res.status(400).json({ error: validation.error });
                    return;
                }
                spec = validation.spec;
                kind = typeof body['kind'] === 'string' && body['kind'].trim() ? body['kind'].trim() : 'shell';
            }

            // origin_meta: explicit > boss-turn capture > {} (notify falls back
            // to origin 'bgtask' routing only — audit round-2 note).
            const explicitMeta = body['originMeta'];
            const originMeta: OriginMeta = (explicitMeta && typeof explicitMeta === 'object')
                ? explicitMeta as OriginMeta
                : (getCurrentMainMeta() as unknown as OriginMeta | null) ?? {};

            const row = createTask({ kind, spec, originMeta });
            startTask(row, onTerminal);
            res.json({ ok: true, task: row, warnings });
        } catch (err) {
            if (err instanceof DuplicateBgTaskError) {
                res.status(409).json({ error: err.message, existingId: err.existingId });
                return;
            }
            res.status(400).json({ error: (err as Error).message });
        }
    });

    app.delete('/api/bgtask/:id', requireAuth, (req, res) => {
        const id = String(req.params['id']);
        const task = getTask(id);
        if (!task) {
            res.status(404).json({ error: 'task not found' });
            return;
        }
        const cancelled = cancelTask(id);
        res.json({ ok: true, cancelled, task: getTask(id) });
    });
}
