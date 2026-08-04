// ─── Chat sessions API ────────────────────────────────
// Extracted from server.ts in Phase 2 (devlog 260609, 07 §3.5).

import type { RequestHandler, Router } from 'express';
import { ok } from '../http/response.js';
import {
    getActiveChatSession, listChatSessions, createChatSession,
    setActiveChatSession, getChatSessionBySeq, getChatSessionById,
    getChatSessionRemoteKey, deleteChatSession,
} from '../core/chat-sessions.js';
import { hasChatSessionWork } from '../orchestrator/session-work.js';

export function registerChatSessionRoutes(app: Router, requireAuth: RequestHandler): void {
    app.get('/api/chat-sessions', requireAuth, (_req, res) => {
        ok(res, { sessions: listChatSessions(), active: getActiveChatSession() });
    });

    app.post('/api/chat-sessions', requireAuth, (req, res) => {
        const label = typeof req.body?.label === 'string' ? req.body.label.trim() || undefined : undefined;
        const session = createChatSession(label);
        ok(res, session);
    });

    app.post('/api/chat-sessions/:id/switch', requireAuth, (req, res): void => {
        const id = String(req.params["id"] || '');
        const seq = parseInt(id, 10);
        const target = isNaN(seq) ? null : getChatSessionBySeq(seq);
        if (!target) { res.status(404).json({ error: `Session not found: ${id}` }); return; }
        setActiveChatSession(target.id);
        ok(res, { switched: target.id, seq: target.seq });
    });

    app.delete('/api/chat-sessions/:id', requireAuth, (req, res): void => {
        const sessionId = String(req.params["id"] || '');
        if (sessionId === 'default') {
            res.status(400).json({ error: 'The default session cannot be deleted.' });
            return;
        }
        const session = getChatSessionById(sessionId);
        if (!session) {
            res.status(404).json({ error: `Session not found: ${sessionId}` });
            return;
        }
        if (getChatSessionRemoteKey(sessionId) !== null) {
            const reason = 'Remotely bound sessions cannot be deleted while remote work admission is unobservable.';
            res.status(409).json({ error: 'remote_session_delete_blocked', reason });
            return;
        }
        if (hasChatSessionWork(sessionId)) {
            const reason = 'Session has active or pending work and cannot be deleted.';
            res.status(409).json({ error: 'session_has_work', reason });
            return;
        }
        if (!deleteChatSession(sessionId)) {
            res.status(404).json({ error: `Session not found: ${sessionId}` });
            return;
        }
        ok(res, { deleted: { id: session.id, seq: session.seq } });
    });
}
