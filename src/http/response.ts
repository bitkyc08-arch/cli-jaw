// ─── HTTP: Standard Response Helpers ─────────────────
// Phase 9.2 — { ok, data } / { ok, error } 표준 응답

/**
 * 표준 성공 응답
 * @param {Response} res
 * @param {any} data
 * @param {object} extra - 추가 필드 (하위호환용)
 */
export function ok(res, data, extra = {}) {
    return res.json({ ok: true, data, ...extra });
}

/**
 * 표준 실패 응답
 * @param {Response} res
 * @param {number} status - HTTP status code
 * @param {string} error - 에러 코드/메시지
 * @param {object} extra - 추가 정보
 */
export function fail(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
}
