import type { Express, NextFunction, Request, Response } from 'express';
import { fail, ok } from '../http/response.js';
import { getTraceEvent, getTraceRun, listTraceEvents } from '../trace/store.js';
import { isTraceSessionOwner, listActivityRuns, readActivityPage, ACTIVITY_PAGE_ROWS as ACTIVITY_PAGE_SIZE } from '../trace/activity-journal.js';

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;
const TRACE_ID_RE = /^tr_[A-Za-z0-9_-]{16,80}$/;

function explicitSession(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 240;
}

function decimalQuery(value: unknown, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return NaN;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : NaN;
}

function activityQuery(req: Request) {
    const query = req.query;
    if (Object.keys(query).some(key => !['session', 'after', 'through', 'limit'].includes(key))) return null;
    const session = query['session'];
    if (!explicitSession(session)) return null;
    const after = decimalQuery(query['after'], 0);
    const through = decimalQuery(query['through'], 0);
    const limit = decimalQuery(query['limit'], ACTIVITY_PAGE_SIZE);
    if (![after, through, limit].every(Number.isSafeInteger) || limit < 1 || limit > ACTIVITY_PAGE_SIZE) return null;
    return { sessionId: session, after, limit, ...(query['through'] === undefined ? {} : { through }) };
}

function rawRead(handler: (req: Request, res: Response) => void) {
    return (req: Request, res: Response): void => {
        try {
            handler(req, res);
        } catch {
            fail(res, 503, 'trace_unavailable');
        }
    };
}

function parseLimit(value: unknown, fallback: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(200, Math.floor(n)));
}

function parseOffset(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.floor(n));
}

function publicRunOrFail(req: Request, res: Response) {
    const run = getTraceRun(String(req.params["runId"] || ''));
    if (!run || run.audience !== 'public') {
        fail(res, 404, 'trace_not_found');
        return null;
    }
    // Session-only backfills remain readable as raw diagnostics. Scope alone
    // cannot authorize access, and only truly ownerless rows retain legacy access.
    if (run.session_id != null || run.scope_key != null) {
        const session = req.query['session'];
        if (!explicitSession(session) || session !== run.session_id || !isTraceSessionOwner(run.id, session)) {
            fail(res, 404, 'trace_not_found');
            return null;
        }
    }
    return run;
}

export function registerTraceRoutes(app: Express, requireAuth: AuthMiddleware): void {
    // Set before auth and parameter parsing so failures cannot be cached either.
    app.use('/api/traces', (_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    app.get('/api/traces/activity-runs', requireAuth, (req, res) => {
        const query = req.query;
        const session = query['session'];
        const after = query['after'] ?? '';
        if (Object.keys(query).some(key => !['session', 'after'].includes(key))
            || !explicitSession(session) || typeof after !== 'string'
            || (after !== '' && !TRACE_ID_RE.test(after))) {
            fail(res, 400, 'invalid_activity_query');
            return;
        }
        try {
            ok(res, { runs: listActivityRuns(session, after), pageSize: ACTIVITY_PAGE_SIZE });
        } catch {
            fail(res, 503, 'activity_unavailable');
        }
    });

    app.get('/api/traces/:runId/activity', requireAuth, (req, res) => {
        const query = activityQuery(req);
        const runId = String(req.params['runId'] || '');
        if (!query || !TRACE_ID_RE.test(runId)) {
            fail(res, 400, 'invalid_activity_query');
            return;
        }
        try {
            const page = readActivityPage({ runId, ...query });
            if (!page) {
                fail(res, 404, 'trace_not_found');
                return;
            }
            ok(res, page);
        } catch (error) {
            fail(res, error instanceof RangeError ? 409 : 503,
                error instanceof RangeError ? 'activity_resync_required' : 'activity_unavailable');
        }
    });

    app.get('/api/traces/:runId', requireAuth, rawRead((req, res) => {
        const run = publicRunOrFail(req, res);
        if (!run) return;
        ok(res, {
            id: run.id,
            messageId: run.message_id ?? null,
            cli: run.cli || '',
            model: run.model || '',
            workingDir: run.working_dir || '',
            agentLabel: run.agent_label || '',
            status: run.status || 'running',
            rawRetentionStatus: run.raw_retention_status || 'available',
            eventCount: run.event_count || 0,
            byteCount: run.byte_count || 0,
            startedAt: run.started_at || 0,
            finishedAt: run.finished_at || null,
            error: run.error || null,
        });
    }));

    app.get('/api/traces/:runId/events', requireAuth, rawRead((req, res) => {
        const run = publicRunOrFail(req, res);
        if (!run) return;
        ok(res, listTraceEvents(run.id, parseOffset(req.query["offset"]), parseLimit(req.query["limit"], 80)));
    }));

    app.get('/api/traces/:runId/events/:seq', requireAuth, rawRead((req, res) => {
        const run = publicRunOrFail(req, res);
        if (!run) return;
        const seq = Number(req.params["seq"]);
        if (!Number.isInteger(seq) || seq < 1) {
            fail(res, 400, 'invalid_trace_seq');
            return;
        }
        const event = getTraceEvent(run.id, seq);
        if (!event) {
            fail(res, 404, 'trace_event_not_found');
            return;
        }
        ok(res, {
            runId: event.run_id,
            seq: event.seq,
            source: event.source,
            eventType: event.event_type,
            preview: event.preview || '',
            bytes: event.bytes || 0,
            retentionStatus: event.retention_status || 'available',
            createdAt: event.created_at || 0,
            raw: event.raw,
        });
    }));
}
