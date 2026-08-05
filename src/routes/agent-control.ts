// ─── Agent control routes (stop/clear/reset) ─────────
// Extracted from server.ts in Phase 2 (devlog 260609, 07 §3.7).

import type { Router, RequestHandler } from 'express';
import { ok } from '../http/response.js';
import { killActiveAgent, killAllAgents } from '../agent/spawn.js';
import { broadcast } from '../core/bus.js';
import { clearSessionState } from '../core/session-ops.js';
import { resolveRequestSession } from './session-request.js';

export function registerAgentControlRoutes(app: Router, requireAuth: RequestHandler): void {
    app.post('/api/stop', requireAuth, (req, res) => {
        // Three request shapes, in this order of precedence:
        //   { sessionId } — the current clients. The server derives the scope so the
        //                   rule stays in one place.
        //   { scope }     — legacy. It BYPASSES the canonical rule and is kept only
        //                   because outside automation may still send it (unverified).
        //   no body       — stop everything. The bundled TUI calls it this way.
        const rawSessionId = req.body?.sessionId;
        const legacyScope = typeof req.body?.scope === 'string' ? req.body.scope.trim() : '';
        const scope = typeof rawSessionId === 'string' && rawSessionId.trim()
            ? resolveRequestSession(rawSessionId).scope
            : legacyScope;
        const killed = scope ? killActiveAgent(scope, 'api') : killAllAgents('api');
        ok(res, { killed, ...(scope ? { scope } : { scope: null, aggregate: true }) });
    });

    // UI-only screen clear — broadcasts to all clients but does NOT delete messages
    // Scoped so clearing one tab's screen does not blank the others, and so the
    // client only drops that session's cached history.
    app.post('/api/clear', requireAuth, (req, res) => {
        const { chatSessionId, scope } = resolveRequestSession(req.body?.sessionId);
        broadcast('clear', { scope, sessionId: chatSessionId });
        ok(res, { uiOnly: true });
    });

    // Explicit session reset — deletes messages (used by /reset confirm, cli-jaw reset)
    app.post('/api/session/reset', requireAuth, async (_, res) => {
        await clearSessionState();
        ok(res, null);
    });
}
