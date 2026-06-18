import type { Express } from 'express';
import { registerBgtaskRoutes } from '../../routes/bgtask.js';
import type { AuthMiddleware } from '../../routes/types.js';
import {
    getWorkerProgressSnapshot,
    listWorkerProgressSnapshots,
} from '../../orchestrator/worker-registry.js';

export function registerManagerRuntimeMonitorRoutes(app: Express, requireAuth: AuthMiddleware): void {
    registerBgtaskRoutes(app, requireAuth);

    app.get('/api/orchestrate/worker-progress', requireAuth, (_req, res) => {
        res.json({ ok: true, workers: listWorkerProgressSnapshots() });
    });

    app.get('/api/orchestrate/worker-progress/:agentId', requireAuth, (req, res) => {
        const agentId = String(req.params["agentId"] || '');
        if (!agentId) {
            res.status(400).json({ ok: false, error: 'missing agentId' });
            return;
        }
        const progress = getWorkerProgressSnapshot(agentId);
        if (!progress) {
            res.status(404).json({ ok: false, error: 'worker progress not found' });
            return;
        }
        res.json({ ok: true, progress });
    });
}
