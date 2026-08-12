// ─── Security: Path Guards ───────────────────────────
// Phase 9.1 — path traversal, id injection, filename abuse 방어
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveHomePath } from '../core/path-expand.js';

const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function badRequest(code: string) {
    return Object.assign(new Error(code), { statusCode: 400 });
}

function forbidden(code: string) {
    return Object.assign(new Error(code), { statusCode: 403 });
}

/**
 * The path semantics a guard should reason with.
 *
 * Injectable so the Windows rules are testable on any CI OS — the same reason
 * `platform-kind.ts` takes its inputs as parameters. Production always passes
 * the host's own `path`, so behavior is unchanged unless a test says otherwise.
 */
export interface PathEnvironment {
    /** `path.win32`, `path.posix`, or the host default. */
    readonly impl: typeof path;
    /** True when Windows filename identity rules apply. */
    readonly windows: boolean;
    /** Canonicalizes an existing path, or returns null when unresolvable. */
    readonly realpath: (p: string) => string | null;
    /** Expands `~` and resolves to absolute, using `impl` semantics. */
    readonly resolveHome: (p: string) => string;
}

function defaultRealpath(p: string): string | null {
    try { return fs.realpathSync.native(p); }
    catch { return null; }
}

export const hostPathEnvironment: PathEnvironment = {
    impl: path,
    windows: process.platform === 'win32',
    realpath: defaultRealpath,
    resolveHome: resolveHomePath,
};

/**
 * Reject NTFS alternate-data-stream suffixes and Win32-trimmed components.
 *
 * Measured on Windows (devlog/_plan/260812_windows_and_channels_parity/005):
 * writing `a.md:hidden` succeeds, the stream is absent from a name-only
 * directory listing, and its content is still fully readable — so a name-based
 * allowlist never sees the payload. `trailing.md.` lands on disk as
 * `trailing.md`, so two distinct strings name one file.
 *
 * Only applied under Windows semantics: on POSIX a colon is a legal filename
 * character, and rejecting it there would break working callers.
 */
export function assertNoWindowsStreamSuffix(
    input: string,
    env: PathEnvironment = hostPathEnvironment,
): void {
    if (!env.windows) return;
    const segments = String(input || '').split(/[\\/]+/);
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg) continue;
        // A drive letter is the only legal colon, and only in the first segment.
        const isDriveSegment = i === 0 && /^[A-Za-z]:$/.test(seg);
        if (!isDriveSegment && seg.includes(':')) throw forbidden('path_stream_denied');
        // `.` and `..` are ordinary relative segments that legitimately end in
        // a dot. Rejecting them here would mask traversal as an encoding error
        // and break every relative path — containment, not this rule, is what
        // decides whether `..` is allowed to escape.
        if (seg === '.' || seg === '..') continue;
        if (/[ .]$/.test(seg)) throw forbidden('path_trailing_trim_denied');
    }
}

/**
 * Fold a path for COMPARISON only — never for the value returned to callers.
 *
 * ASCII-only on purpose: `toLowerCase()` is locale-sensitive (Turkish dotless
 * i) and would fold characters Win32 does not. POSIX is returned untouched,
 * because a Linux host genuinely can hold `A.md` and `a.md` as distinct files
 * and folding there would create the vulnerability this function prevents.
 */
export function foldPathIdentity(
    p: string,
    env: PathEnvironment = hostPathEnvironment,
): string {
    if (!env.windows) return p;
    return p.replace(/[A-Z]/g, (c) => c.toLowerCase());
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
export function safeResolveUnder(
    baseDir: string,
    unsafeName: string,
    env: PathEnvironment = hostPathEnvironment,
) {
    assertNoWindowsStreamSuffix(unsafeName, env);
    const p = env.impl;
    const base = p.resolve(baseDir);
    const resolved = p.resolve(base, unsafeName);
    // Fold for comparison; return the UNFOLDED path so real filenames survive.
    const foldedBase = foldPathIdentity(base, env);
    const foldedResolved = foldPathIdentity(resolved, env);
    const pref = foldedBase.endsWith(p.sep) ? foldedBase : foldedBase + p.sep;
    if (foldedResolved !== foldedBase && !foldedResolved.startsWith(pref)) {
        throw forbidden('path_escape');
    }
    return resolved;
}

/**
 * Send file path validation — only allow files under JAW_HOME or workingDir.
 * Prevents arbitrary file exfiltration via /api/telegram/send, /api/channel/send, etc.
 * @throws 403 path_not_allowed
 */
function isUnderRoot(canonical: string, root: string, env: PathEnvironment = hostPathEnvironment): boolean {
    const c = foldPathIdentity(canonical, env);
    const r = foldPathIdentity(root, env);
    const pref = r.endsWith(env.impl.sep) ? r : r + env.impl.sep;
    return c === r || c.startsWith(pref);
}

export function assertSendFilePath(
    filePath: string,
    workingDir?: string,
    projectDirs?: string[] | null,
    env: PathEnvironment = hostPathEnvironment,
): string {
    // Reject stream/trim forms before any filesystem call: `a.md:hidden`
    // resolves and realpaths cleanly, so a later check would already be too late.
    assertNoWindowsStreamSuffix(filePath, env);

    const p = env.impl;
    const resolved = p.resolve(filePath);
    const canonical = env.realpath(resolved);
    if (!canonical) throw forbidden('path_not_resolvable');

    // Allow anything under JAW_HOME
    const jawHome = env.resolveHome(process.env["CLI_JAW_HOME"] || process.env["JAW_HOME"] || p.join(os.homedir(), '.cli-jaw'));
    const canonJaw = env.realpath(jawHome);
    if (canonJaw && isUnderRoot(canonical, canonJaw, env)) return canonical;

    if (workingDir) {
        const canonWd = env.realpath(p.resolve(workingDir));
        if (canonWd && isUnderRoot(canonical, canonWd, env)) return canonical;
    }

    if (projectDirs) {
        for (const dir of projectDirs) {
            const currentReal = env.realpath(p.resolve(dir));
            if (!currentReal || currentReal !== p.resolve(dir)) continue;
            if (isUnderRoot(canonical, currentReal, env)) return canonical;
        }
    }

    throw forbidden('path_not_allowed');
}
