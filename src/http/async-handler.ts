// ─── HTTP: Async Handler Wrapper ─────────────────────
// Phase 9.2 — async 라우트 핸들러의 에러를 Express error middleware로 전달

/**
 * async 핸들러를 try/catch 없이 사용 가능하게 래핑
 * throw된 에러는 Express error middleware로 전달됨
 * @param {Function} fn - (req, res, next) => Promise
 * @returns {Function} Express route handler
 */
export const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};
