// ─── Security: Path Guards ───────────────────────────
// Phase 9.1 — path traversal, id injection, filename abuse 방어
import path from 'node:path';
import os from 'node:os';

const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function badRequest(code: string) {
    return Object.assign(new Error(code), { statusCode: 400 });
}

function forbidden(code: string) {
    return Object.assign(new Error(code), { statusCode: 403 });
}

/**
 * Skill ID 검증 — 소문자 영숫자 + 하이픈/점/밑줄만 허용
 * @param {string} id
 * @returns {string} trimmed id
 * @throws 400 invalid_skill_id / path_segment_denied
 */
export function assertSkillId(id: string) {
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
export function assertFilename(filename: string, { allowExt = ['.md'] }: { allowExt?: string[] } = {}) {
    const v = String(filename || '').trim();
    if (!v || v.length > 200) throw badRequest('invalid_filename');
    if (!FILE_NAME_RE.test(v)) throw badRequest('invalid_filename');
    if (v.includes('..') || v.includes('/') || v.includes('\\')) throw badRequest('invalid_filename');
    const ext = path.extname(v).toLowerCase();
    if (allowExt.length && !allowExt.includes(ext)) throw badRequest('invalid_extension');
    return v;
}

/**
 * Memory relative path validation — nested relative paths allowed, traversal forbidden
 * @param {string} input
 * @param {object} opts
 * @param {string[]} opts.allowExt
 * @returns {string}
 * @throws 400 invalid_filename / invalid_extension
 */
export function assertMemoryRelPath(input: string, { allowExt = ['.md'] }: { allowExt?: string[] } = {}) {
    const v = String(input || '').trim().replace(/\\/g, '/');
    if (!v || v.length > 300) throw badRequest('invalid_filename');
    if (v.startsWith('/') || v.startsWith('~') || v.includes('..')) throw badRequest('invalid_filename');
    const segments = v.split('/').filter(Boolean);
    if (!segments.length) throw badRequest('invalid_filename');
    for (const seg of segments) {
        if (!FILE_NAME_RE.test(seg)) throw badRequest('invalid_filename');
    }
    const ext = path.extname(v).toLowerCase();
    if (allowExt.length && !allowExt.includes(ext)) throw badRequest('invalid_extension');
    return segments.join('/');
}

/**
 * baseDir 아래로 안전하게 resolve — 탈출 시 403
 * @param {string} baseDir
 * @param {string} unsafeName
 * @returns {string} resolved absolute path
 * @throws 403 path_escape
 */
export function safeResolveUnder(baseDir: string, unsafeName: string) {
    const base = path.resolve(baseDir);
    const resolved = path.resolve(base, unsafeName);
    const pref = base.endsWith(path.sep) ? base : base + path.sep;
    if (resolved !== base && !resolved.startsWith(pref)) throw forbidden('path_escape');
    return resolved;
}

/**
 * Send file path validation — only allow files under JAW_HOME or workingDir.
 * Prevents arbitrary file exfiltration via /api/telegram/send, /api/channel/send, etc.
 * @throws 403 path_not_allowed
 */
export function assertSendFilePath(filePath: string, workingDir?: string): string {
    const resolved = path.resolve(filePath);

    // Allow anything under JAW_HOME
    const jawHome = path.resolve(process.env.JAW_HOME || path.join(process.env.HOME || '', '.cli-jaw'));
    const homePref = jawHome.endsWith(path.sep) ? jawHome : jawHome + path.sep;
    if (resolved.startsWith(homePref) || resolved === jawHome) return resolved;

    // Allow files under the current workingDir (agent-generated files)
    if (workingDir) {
        const wd = path.resolve(workingDir);
        const wdPref = wd.endsWith(path.sep) ? wd : wd + path.sep;
        if (resolved.startsWith(wdPref) || resolved === wd) return resolved;
    }

    // Allow files under OS temp dir (TTS output, agent temp files)
    const tmpDir = path.resolve(os.tmpdir());
    const tmpPref = tmpDir.endsWith(path.sep) ? tmpDir : tmpDir + path.sep;
    if (resolved.startsWith(tmpPref) || resolved === tmpDir) return resolved;

    throw forbidden('path_not_allowed');
}
