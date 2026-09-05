import type { Router, RequestHandler } from 'express';
import { runtimeRequests, type RuntimeRequests } from '../agent/runtime/requests.js';
import { ok, fail } from '../http/response.js';

function isId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 240;
}

/** Uses the existing instance auth policy; binding is not a per-session tenant ACL. */
export function registerRuntimeRequestRoutes(app: Router, requireAuth: RequestHandler, registry: RuntimeRequests = runtimeRequests): void {
    app.get('/api/runtime/requests', requireAuth, (req, res) => {
        const sessionId = req.query['sessionId'];
        if (!isId(sessionId)) { fail(res, 400, 'invalid_session'); return; }
        ok(res, { requests: registry.list(sessionId) });
    });
    app.post('/api/runtime/requests/:id', requireAuth, (req, res) => {
        const body: unknown = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) { fail(res, 400, 'invalid_response'); return; }
        const x = body as Record<string, unknown>;
        const requestId = req.params['id'];
        const runId = x['runId'], sessionId = x['sessionId'], scope = x['scope'], turnId = x['turnId'];
        if (Object.keys(x).some(key => !['runId', 'sessionId', 'scope', 'turnId', 'response'].includes(key))
            || !isId(requestId) || !isId(runId) || !isId(sessionId) || !isId(scope) || !isId(turnId)
            || !Object.hasOwn(x, 'response')) { fail(res, 400, 'invalid_response'); return; }
        try {
            registry.respond(requestId, { runId, sessionId, scope, turnId }, x['response']);
            ok(res, { accepted: true });
        } catch (error) {
            const stale = error instanceof Error && error.message === 'request_not_current';
            fail(res, stale ? 409 : 400, stale ? 'request_not_current' : 'invalid_response');
        }
    });
}
