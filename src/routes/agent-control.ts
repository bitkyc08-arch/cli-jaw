// ─── Agent control routes (stop/clear/reset) ─────────
// Extracted from server.ts in Phase 2 (devlog 260609, 07 §3.7).

import type { Router, RequestHandler } from 'express';
import { ok } from '../http/response.js';
import { killActiveAgent, killAllAgents } from '../agent/spawn.js';
import { broadcast } from '../core/bus.js';
import { clearSessionState } from '../core/session-ops.js';

export function registerAgentControlRoutes(app: Router, requireAuth: RequestHandler): void {
    app.post('/api/stop', requireAuth, (req, res) => {
        const scope = typeof req.body?.scope === 'string' ? req.body.scope.trim() : '';
        const killed = scope ? killActiveAgent(scope, 'api') : killAllAgents('api');
        ok(res, { killed, ...(scope ? { scope } : { scope: null, aggregate: true }) });
    });

    // UI-only screen clear — broadcasts to all clients but does NOT delete messages
    app.post('/api/clear', requireAuth, (_, res) => {
        broadcast('clear', {});
        ok(res, { uiOnly: true });
    });

    // Explicit session reset — deletes messages (used by /reset confirm, cli-jaw reset)
    app.post('/api/session/reset', requireAuth, async (_, res) => {
        await clearSessionState();
        ok(res, null);
    });
}
