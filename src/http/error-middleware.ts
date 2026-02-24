// ─── HTTP: Error Middleware ──────────────────────────
// Phase 9.2 — Express global error handler

import { fail } from './response.ts';

/**
 * 404 Not Found 핸들러
 */
export function notFoundHandler(req, res) {
    return fail(res, 404, 'route_not_found', { method: req.method, path: req.path });
}

/**
 * Global error handler — 모든 throw된 에러를 표준 포맷으로 변환
 */
export function errorHandler(err, req, res, _next) {
    const status = err?.statusCode || 500;
    const msg = status >= 500 ? 'internal_error' : (err?.message || 'bad_request');

    if (status >= 500) console.error('[http:error]', err);
    else console.warn('[http:warn]', msg, { path: req.path });

    if (res.headersSent) return;
    return fail(res, status, msg, err?.code ? { code: err.code } : {});
}
