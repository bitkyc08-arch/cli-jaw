import type { Express, NextFunction, Request, Response } from 'express';
import { fail, ok } from '../http/response.js';
import {
    DETAIL_CHUNK_MAX_BYTES, DETAIL_WHOLE_MAX_BYTES,
    readTraceDetailRange, readTraceDetailWhole,
} from '../trace/detail-range.js';
import { getTraceEventMeta, getTraceRun, listTraceEvents } from '../trace/store.js';

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;

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

// 026 §3.1 — strict byte-range params. Invalid values are surfaced as
// 400 invalid_trace_range instead of being silently clamped.
function parseRangeParams(req: Request): { offset: number; limit: number } | 'invalid' | null {
    const rawOffset = req.query['offset'];
    const rawLimit = req.query['limit'];
    if (rawOffset === undefined && rawLimit === undefined) return null;
    const offset = Number(rawOffset);
    if (rawOffset === undefined || !Number.isInteger(offset) || offset < 0) return 'invalid';
    let limit = DETAIL_CHUNK_MAX_BYTES;
    if (rawLimit !== undefined) {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > DETAIL_CHUNK_MAX_BYTES) return 'invalid';
    }
    return { offset, limit };
}

function publicRunOrFail(req: Request, res: Response) {
    const run = getTraceRun(String(req.params["runId"] || ''));
    if (!run || run.audience !== 'public') {
        fail(res, 404, 'trace_not_found');
        return null;
    }
    return run;
}

export function registerTraceRoutes(app: Express, requireAuth: AuthMiddleware): void {
    app.get('/api/traces/:runId', requireAuth, (req, res) => {
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
    });

    app.get('/api/traces/:runId/events', requireAuth, (req, res) => {
        const run = publicRunOrFail(req, res);
        if (!run) return;
        ok(res, listTraceEvents(run.id, parseOffset(req.query["offset"]), parseLimit(req.query["limit"], 80)));
    });

    app.get('/api/traces/:runId/events/:seq', requireAuth, async (req, res) => {
        const run = publicRunOrFail(req, res);
        if (!run) return;
        const seq = Number(req.params["seq"]);
        if (!Number.isInteger(seq) || seq < 1) {
            fail(res, 400, 'invalid_trace_seq');
            return;
        }
        const meta = getTraceEventMeta(run.id, seq);
        if (!meta) {
            fail(res, 404, 'trace_event_not_found');
            return;
        }
        const range = parseRangeParams(req);
        if (range === 'invalid') {
            fail(res, 400, 'invalid_trace_range');
            return;
        }
        if (meta.payloadState === 'gone') {
            // row survived retention but its spill did not — distinct from a
            // legitimately empty payload (026 §3.4).
            fail(res, 410, 'trace_payload_gone');
            return;
        }
        // client disconnect propagates as cancellation into fd reads/index scans.
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abort.abort(); });
        const source = {
            runId: run.id, seq,
            spillPath: meta.payloadState === 'spilled' ? meta.spillPath : null,
            inline: meta.payloadState === 'inline' ? (meta.row.raw_json || '') : null,
        };
        if (range === null) {
            if (meta.totalBytes > DETAIL_WHOLE_MAX_BYTES) {
                fail(res, 413, 'trace_detail_range_required', {
                    totalBytes: meta.totalBytes, rangeAvailable: true, chunkSize: DETAIL_CHUNK_MAX_BYTES,
                });
                return;
            }
            const whole = await readTraceDetailWhole(source, abort.signal);
            if (whole.kind === 'canceled') return;
            if (whole.kind === 'gone') { fail(res, 410, 'trace_payload_gone'); return; }
            if (whole.kind === 'too_large') {
                fail(res, 413, 'trace_detail_range_required', {
                    totalBytes: whole.totalBytes, rangeAvailable: true, chunkSize: DETAIL_CHUNK_MAX_BYTES,
                });
                return;
            }
            ok(res, {
                runId: meta.row.run_id,
                seq: meta.row.seq,
                source: meta.row.source,
                eventType: meta.row.event_type,
                preview: meta.row.preview || '',
                bytes: meta.row.bytes || 0,
                retentionStatus: meta.row.retention_status || 'available',
                createdAt: meta.row.created_at || 0,
                raw: whole.raw,
            });
            return;
        }
        const result = await readTraceDetailRange(source, {
            offset: range.offset, limit: range.limit, signal: abort.signal,
        });
        switch (result.kind) {
            case 'canceled': return;
            case 'gone': fail(res, 410, 'trace_payload_gone'); return;
            case 'revision_changed': fail(res, 409, 'trace_payload_revision_changed'); return;
            case 'invalid_utf8': fail(res, 422, 'trace_payload_invalid_utf8'); return;
            case 'range': ok(res, { runId: run.id, seq, ...result.data }); return;
        }
    });
}
