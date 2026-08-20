// ─── Security: Path Guards ───────────────────────────
// Phase 9.1 — path traversal, id injection, filename abuse 방어
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveHomePath } from '../core/path-expand.js';

const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * `statusCode` is what `routes/_http-error.ts` reads to pick the HTTP status;
 * `code` is what it reads for the machine-readable error name, which used to
 * come back undefined. `detail` is optional and additive — every existing
 * caller passes nothing and behaves exactly as before (#404).
 */
function badRequest(code: string, detail?: Record<string, unknown>) {
    return Object.assign(new Error(code), {
        statusCode: 400,
        code,
        ...(detail ? { detail } : {}),
    });
}

function forbidden(code: string, detail?: Record<string, unknown>) {
    return Object.assign(new Error(code), {
        statusCode: 403,
        code,
        ...(detail ? { detail } : {}),
    });
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
    const value = String(input || '');

    // Strip the ROOT before scanning. `path.win32.parse` understands drive
    // roots (`C:\`), UNC roots (`\\server\share\`), and extended-length
    // namespace roots (`\\?\C:\`, `\\?\UNC\server\share\`). Scanning the whole
    // string instead would reject `\\?\C:\Data\f.md` — a legitimate long-path
    // form that `path.toNamespacedPath()` emits — as if its drive colon were a
    // stream separator.
    const root = path.win32.parse(value).root;
    const tail = root ? value.slice(root.length) : value;

    for (const seg of tail.split(/[\\/]+/)) {
        if (!seg) continue;
        // No colon is legal outside the root: this is the NTFS ADS separator.
        if (seg.includes(':')) throw forbidden('path_stream_denied');
        // `.` and `..` are ordinary relative segments that legitimately end in
        // a dot. Rejecting them here would mask traversal as an encoding error
        // and break every relative path — containment, not this rule, is what
        // decides whether `..` is allowed to escape.
        if (seg === '.' || seg === '..') continue;
        if (/[ .]$/.test(seg)) throw forbidden('path_trailing_trim_denied');
    }
}

/**
 * Canonical identity for containment comparison.
 *
 * Deliberately NOT case-folding, on any platform. Folding ASCII merely because
 * the host is Windows is an over-authorization bug, not a convenience: Windows
 * supports per-directory case sensitivity (`fsutil file setCaseSensitiveInfo`)
 * and case-sensitive SMB shares, so `...\Root` and `...\root` can be two
 * different directories. Folding makes a forbidden sibling look contained.
 * This was demonstrated on a real Windows host — see
 * devlog/_plan/260812_windows_and_channels_parity/010.
 *
 * Case-insensitivity is instead obtained where it is actually true: both the
 * candidate and the roots in `assertSendFilePath` pass through native
 * `realpath`, which restores each entry's real on-disk casing. Comparing those
 * canonical forms exactly is both correct on case-insensitive volumes and safe
 * on case-sensitive ones.
 */
export function pathIdentity(p: string): string {
    return p;
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
 * realpath both for existing paths and for not-yet-existing targets
 * (canonical parent + basename). Returns null ONLY when nothing exists on
 * disk to canonicalize (pure lexical/fake-path callers keep the lexical
 * verdict). Any other realpath error (EACCES/ELOOP/EIO) fails closed —
 * a guard that cannot see the filesystem must not approve. No caching:
 * a retargeted symlink/junction must never be authorized by a stale entry.
 */
function tryCanonical(p: string): string | null {
    try {
        return fs.realpathSync.native(p);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw forbidden('path_escape');
        try {
            return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
        } catch (inner) {
            if ((inner as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw forbidden('path_escape');
        }
    }
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
    // Exact comparison, deliberately. This helper is purely lexical — it never
    // canonicalizes — so it cannot know whether the volume is case sensitive.
    // Folding here would be a guess that fails open on a case-sensitive
    // directory; exact matching only ever fails closed.
    const pref = base.endsWith(p.sep) ? base : base + p.sep;
    if (resolved !== base && !resolved.startsWith(pref)) {
        throw forbidden('path_escape');
    }
    // Canonical containment (T4/wp5): the lexical check cannot see a junction
    // or symlink under baseDir that leads outside. Re-check containment on
    // realpaths when the host can canonicalize both sides.
    const canonBase = tryCanonical(base);
    const canonResolved = tryCanonical(resolved);
    if (canonBase && canonResolved && !isUnderRoot(canonResolved, canonBase, env)) {
        throw forbidden('path_escape');
    }
    return resolved;
}

/**
 * Send file path validation — only allow files under JAW_HOME or workingDir.
 * Prevents arbitrary file exfiltration via /api/telegram/send, /api/channel/send, etc.
 * @throws 403 path_not_allowed
 */
/**
 * Containment between two ALREADY-CANONICAL paths.
 *
 * Both sides come from native `realpath`, so each carries its true on-disk
 * casing and an exact comparison is right on case-insensitive and
 * case-sensitive volumes alike.
 */
function isUnderRoot(canonical: string, root: string, env: PathEnvironment = hostPathEnvironment): boolean {
    const c = pathIdentity(canonical);
    const r = pathIdentity(root);
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

    // Computed once and used for both the verdict and the explanation. Two calls
    // would let a symlink or a directory change between them, so the refusal
    // could name a list it did not actually enforce (#404).
    const roots = sendFileAllowedRoots(workingDir, projectDirs, env);
    for (const root of roots) {
        if (isUnderRoot(canonical, root, env)) return canonical;
    }

    // Refusing is correct; refusing anonymously is not. The caller is usually an
    // agent that can move the file and retry, but it has no way to learn where
    // "allowed" is — the roots live in settings it never reads. Six of these
    // landed in stderr with nothing else beside them (#404).
    throw forbidden('path_not_allowed', { allowedRoots: roots });
}

/**
 * The roots `assertSendFilePath` will accept, canonicalized exactly the way it
 * canonicalizes them.
 *
 * A reporter that builds this list itself drifts from enforcement — doctor
 * calling a path "allowed" that the guard then refuses — so the guard and every
 * reporter read it from here (#404).
 *
 * A root that does not resolve is omitted, matching the guard: it skipped a
 * falsy realpath rather than comparing against a directory that is not there.
 */
export function sendFileAllowedRoots(
    workingDir?: string,
    projectDirs?: string[] | null,
    env: PathEnvironment = hostPathEnvironment,
): string[] {
    const p = env.impl;
    const roots: string[] = [];
    const push = (value: string | null | undefined) => {
        if (value && !roots.includes(value)) roots.push(value);
    };

    const jawHome = env.resolveHome(
        process.env["CLI_JAW_HOME"] || process.env["JAW_HOME"] || p.join(os.homedir(), '.cli-jaw'),
    );
    push(env.realpath(jawHome));
    if (typeof workingDir === 'string' && workingDir) push(env.realpath(p.resolve(workingDir)));
    // Canonical-to-canonical. The previous form required
    // `realpath(dir) === resolve(dir)`, which silently dropped every project
    // root on Windows whose stored casing differed from the on-disk casing,
    // because native realpath restores real casing (verified on a Windows host:
    // input `...\mixed` canonicalizes to `...\MiXeD`, so the equality never
    // held).
    //
    // Resolving the root is also what makes containment meaningful: the
    // candidate is already canonical, so both sides must be. A root that is a
    // symlink is therefore evaluated at its target, which is the location the
    // operator actually granted by configuring it.
    // Type-checked per entry, not trusted from the caller: these come from raw
    // settings JSON, where an entry can be a number. `path.resolve(42)` throws,
    // and this function is called from `jaw doctor` — the one command that has
    // to keep working when the settings are broken (#404).
    for (const dir of projectDirs ?? []) {
        if (typeof dir !== 'string' || !dir) continue;
        push(env.realpath(p.resolve(dir)));
    }
    return roots;
}
