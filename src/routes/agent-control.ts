// ─── Agent control routes (stop/clear/reset) ─────────
// Extracted from server.ts in Phase 2.

import type { Router, RequestHandler } from 'express';
import { ok } from '../http/response.js';
import { killActiveAgent, killAllAgents } from '../agent/spawn.js';
import { broadcast } from '../core/bus.js';
import { clearSessionState } from '../core/session-ops.js';
import { resolveRequestSessionStrict } from './session-request.js';
import { withSessionScope } from '../core/session-context.js';

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
        let scope = legacyScope;
        if (typeof rawSessionId === 'string' && rawSessionId.trim()) {
            const resolved = resolveRequestSessionStrict(rawSessionId);
            if (!resolved.ok) {
                // Stopping the wrong session is worse than not stopping at all.
                res.status(404).json({ error: 'unknown_session', sessionId: resolved.requested });
                return;
            }
            scope = resolved.scope;
        }
        const killed = scope ? killActiveAgent(scope, 'api') : killAllAgents('api');
        ok(res, { killed, ...(scope ? { scope } : { scope: null, aggregate: true }) });
    });

    // UI-only screen clear — broadcasts to all clients but does NOT delete messages
    // Scoped so clearing one tab's screen does not blank the others, and so the
    // client only drops that session's cached history.
    app.post('/api/clear', requireAuth, (req, res) => {
        const resolved = resolveRequestSessionStrict(req.body?.sessionId);
        if (!resolved.ok) {
            res.status(404).json({ error: 'unknown_session', sessionId: resolved.requested });
            return;
        }
        broadcast('clear', { scope: resolved.scope, sessionId: resolved.chatSessionId });
        ok(res, { uiOnly: true });
    });

    // Explicit session reset — deletes messages (used by /reset confirm, cli-jaw reset)
    app.post('/api/session/reset', requireAuth, async (req, res) => {
        // The reset used to ignore which session asked for it, so it fell back to the
        // instance-wide behaviour: bumping the ownership generation for every scope and
        // clearing buckets it did not own. /api/clear right above already resolves the
        // session; the destructive sibling has more reason to, not less (073 §2.2a).
        const resolved = resolveRequestSessionStrict(req.body?.sessionId);
        if (!resolved.ok) {
            res.status(404).json({ error: 'unknown_session', sessionId: resolved.requested });
            return;
        }
        await withSessionScope(
            { scope: resolved.scope, chatSessionId: resolved.chatSessionId },
            () => clearSessionState(),
        );
        ok(res, null);
    });
}
