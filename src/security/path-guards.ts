// ─── Security: Path Guards ───────────────────────────
// Phase 9.1 — path traversal, id injection, filename abuse 방어
import path from 'node:path';

const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function badRequest(code) {
    const e = new Error(code);
    e.statusCode = 400;
    return e;
}

function forbidden(code) {
    const e = new Error(code);
    e.statusCode = 403;
    return e;
}

/**
 * Skill ID 검증 — 소문자 영숫자 + 하이픈/점/밑줄만 허용
 * @param {string} id
 * @returns {string} trimmed id
 * @throws 400 invalid_skill_id / path_segment_denied
 */
export function assertSkillId(id) {
    const v = String(id || '').trim();
    if (!SKILL_ID_RE.test(v)) throw badRequest('invalid_skill_id');
    if (v.includes('..') || v.includes('/') || v.includes('\\')) throw badRequest('path_segment_denied');
    return v;
}

/**
 * 파일명 검증 — 영숫자 시작, 확장자 제한
 * @param {string} filename
 * @param {object} opts
 * @param {string[]} opts.allowExt - 허용 확장자 배열 (기본: ['.md'])
 * @returns {string} trimmed filename
 * @throws 400 invalid_filename / invalid_extension
 */
export function assertFilename(filename, { allowExt = ['.md'] } = {}) {
    const v = String(filename || '').trim();
    if (!v || v.length > 200) throw badRequest('invalid_filename');
    if (!FILE_NAME_RE.test(v)) throw badRequest('invalid_filename');
    if (v.includes('..') || v.includes('/') || v.includes('\\')) throw badRequest('invalid_filename');
    const ext = path.extname(v).toLowerCase();
    if (allowExt.length && !allowExt.includes(ext)) throw badRequest('invalid_extension');
    return v;
}

/**
 * baseDir 아래로 안전하게 resolve — 탈출 시 403
 * @param {string} baseDir
 * @param {string} unsafeName
 * @returns {string} resolved absolute path
 * @throws 403 path_escape
 */
export function safeResolveUnder(baseDir, unsafeName) {
    const base = path.resolve(baseDir);
    const resolved = path.resolve(base, unsafeName);
    const pref = base.endsWith(path.sep) ? base : base + path.sep;
    if (resolved !== base && !resolved.startsWith(pref)) throw forbidden('path_escape');
    return resolved;
}
