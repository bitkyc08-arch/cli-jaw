// Windows path-identity guards, exercised on any host by injecting the path
// environment. The Windows filesystem behaviors these rules defend against were
// measured on a real host and recorded in
// devlog/_plan/260812_windows_and_channels_parity/005_real_windows_host_evidence.md:
//   - `a.md:hidden` writes an NTFS stream that a name-only directory listing
//     never shows, while its content stays fully readable.
//   - `trailing.md.` lands on disk as `trailing.md`, so two distinct strings
//     name one file.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import {
    assertNoWindowsStreamSuffix,
    safeResolveUnder,
    assertSendFilePath,
    hostPathEnvironment,
    type PathEnvironment,
} from '../../src/security/path-guards.js';

/**
 * A Win32 environment whose fake realpath imitates the behavior measured on a
 * real Windows host: lookup is case-insensitive, but the value returned is the
 * entry's TRUE on-disk casing. An earlier fake echoed the input back, which
 * hid exactly the bug this suite now covers.
 *
 * `existing` entries are the canonical (on-disk) spellings.
 */
function win32Env(existing: string[] = [], caseSensitive = false): PathEnvironment {
    const canonical = new Map(existing.map((p) => [p.toLowerCase(), p]));
    return {
        impl: path.win32,
        windows: true,
        realpath: (p: string) => {
            if (caseSensitive) return existing.includes(p) ? p : null;
            return canonical.get(p.toLowerCase()) ?? null;
        },
        resolveHome: (p: string) => path.win32.resolve(p),
    };
}

function posixEnv(existing: string[] = []): PathEnvironment {
    const known = new Set(existing);
    return {
        impl: path.posix,
        windows: false,
        realpath: (p: string) => (known.has(p) ? p : null),
        resolveHome: (p: string) => path.posix.resolve(p),
    };
}

function codeOf(fn: () => unknown): string {
    try { fn(); return 'NO_THROW'; }
    catch (e) { return (e as Error).message; }
}

// ── ADS / trailing-trim rejection ────────────────────────────────

test('ADS suffix is rejected under Windows semantics', () => {
    const env = win32Env();
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('a.md:hidden', env)), 'path_stream_denied');
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('dir/file.ts:payload', env)), 'path_stream_denied');
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('dir:name/file.md', env)), 'path_stream_denied');
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('dir\\file.md:x', env)), 'path_stream_denied');
});

test('trailing dot and space are rejected under Windows semantics', () => {
    const env = win32Env();
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('a.md.', env)), 'path_trailing_trim_denied');
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('a.md ', env)), 'path_trailing_trim_denied');
});

test('a drive-letter colon is allowed, but only as the first segment', () => {
    const env = win32Env();
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('C:\\base\\a.md', env)), 'NO_THROW');
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('base\\C:\\a.md', env)), 'path_stream_denied');
});

test('ordinary nested paths are unaffected', () => {
    const env = win32Env();
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('sub/dir/a.md', env)), 'NO_THROW');
});

test('POSIX keeps colon filenames legal', () => {
    // A colon is a valid POSIX filename character; rejecting it here would
    // break working callers on Linux and macOS.
    const env = posixEnv();
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('a:b.md', env)), 'NO_THROW');
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('weird.name.', env)), 'NO_THROW');
});

// ── Windows namespace roots ──────────────────────────────────────

test('extended-length namespace roots are not mistaken for ADS', () => {
    // `\\?\C:\...` is what path.toNamespacedPath() emits for long paths. Its
    // drive colon lives in the ROOT, not in a name segment.
    const env = win32Env();
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('\\\\?\\C:\\Data\\f.md', env)), 'NO_THROW');
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('\\\\.\\C:\\Data\\f.md', env)), 'NO_THROW');
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('\\\\?\\UNC\\server\\share\\f.md', env)), 'NO_THROW');
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('\\\\server\\share\\f.md', env)), 'NO_THROW');
});

test('ADS is still rejected inside a namespace path', () => {
    const env = win32Env();
    assert.strictEqual(
        codeOf(() => assertNoWindowsStreamSuffix('\\\\?\\C:\\Data\\f.md:hidden', env)),
        'path_stream_denied',
    );
});

// ── containment ──────────────────────────────────────────────────

test('safeResolveUnder returns the path unmodified', () => {
    const env = win32Env();
    const out = safeResolveUnder('C:\\Data', 'Sub\\F.md', env);
    assert.strictEqual(out, 'C:\\Data\\Sub\\F.md', 'must not lowercase a real filename');
});

test('safeResolveUnder compares exactly, never case-folded', () => {
    // This helper is purely lexical and cannot know whether the volume is
    // case sensitive, so it must fail CLOSED rather than guess. Folding here
    // would authorize a sibling on a case-sensitive directory.
    const env = win32Env();
    assert.strictEqual(codeOf(() => safeResolveUnder('C:\\Data', 'c:\\data\\f.md', env)), 'path_escape');
});

test('POSIX containment stays case-SENSITIVE', () => {
    // /Data and /data are genuinely different directories on POSIX.
    const env = posixEnv();
    assert.strictEqual(codeOf(() => safeResolveUnder('/Data', '../data/f.md', env)), 'path_escape');
});

test('sibling-prefix attack is blocked on Windows', () => {
    const env = win32Env();
    assert.strictEqual(codeOf(() => safeResolveUnder('C:\\Data', '..\\DataOther\\f.md', env)), 'path_escape');
});

test('ordinary .. traversal is still blocked', () => {
    assert.strictEqual(codeOf(() => safeResolveUnder('C:\\Data\\skills', '..\\..\\Windows\\x', win32Env())), 'path_escape');
    assert.strictEqual(codeOf(() => safeResolveUnder('/data/skills', '../../etc/passwd', posixEnv())), 'path_escape');
});

test('safeResolveUnder rejects an ADS suffix before resolving', () => {
    assert.strictEqual(codeOf(() => safeResolveUnder('C:\\Data', 'a.md:hidden', win32Env())), 'path_stream_denied');
});

test('dot segments are not mistaken for trailing-trim forms', () => {
    // Regression: `..` ends with a dot, so a naive trailing-dot rule rejected
    // every relative path and reported traversal as an encoding error. The
    // trim rule must exempt `.` and `..` and leave escape decisions to
    // containment.
    const env = win32Env();
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('..\\sib\\f.md', env)), 'NO_THROW');
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('.\\f.md', env)), 'NO_THROW');
    // ...while a genuine trailing dot on a NAME is still rejected.
    assert.strictEqual(codeOf(() => assertNoWindowsStreamSuffix('..\\a.md.', env)), 'path_trailing_trim_denied');
});

// ── the send boundary itself ─────────────────────────────────────

test('send boundary rejects ADS even when the base file resolves', () => {
    // The regression this phase exists to prevent: `a.md:hidden` resolves and
    // realpaths cleanly, so a post-canonicalization check would pass it.
    const env = win32Env(['C:\\work\\a.md:hidden', 'C:\\work']);
    assert.strictEqual(
        codeOf(() => assertSendFilePath('C:\\work\\a.md:hidden', 'C:\\work', null, env)),
        'path_stream_denied',
    );
});

test('send boundary allows a file inside workingDir with different casing', () => {
    // Realpath restores true casing on BOTH sides, so a differently-cased
    // request for the same directory is correctly allowed.
    const env = win32Env(['C:\\Work\\a.md', 'C:\\Work']);
    const out = assertSendFilePath('c:\\work\\A.MD', 'c:\\work', null, env);
    assert.strictEqual(out, 'C:\\Work\\a.md', 'returns the canonical on-disk path');
});

test('send boundary does NOT over-authorize on a case-sensitive volume', () => {
    // Windows supports per-directory case sensitivity, and case-sensitive SMB
    // shares behave the same way. `Root` and `root` are then DIFFERENT
    // directories, and folding would have let the sibling through.
    const env = win32Env(['C:\\cs\\Root', 'C:\\cs\\root', 'C:\\cs\\root\\secret.txt'], true);
    assert.strictEqual(
        codeOf(() => assertSendFilePath('C:\\cs\\root\\secret.txt', 'C:\\cs\\Root', null, env)),
        'path_not_allowed',
    );
});

test('send boundary rejects trailing-dot and trailing-space forms', () => {
    const env = win32Env(['C:\\work\\a.md', 'C:\\work']);
    assert.strictEqual(
        codeOf(() => assertSendFilePath('C:\\work\\a.md.', 'C:\\work', null, env)),
        'path_trailing_trim_denied',
    );
    assert.strictEqual(
        codeOf(() => assertSendFilePath('C:\\work\\a.md ', 'C:\\work', null, env)),
        'path_trailing_trim_denied',
    );
});

test('send boundary allows files under JAW_HOME', () => {
    const prev = process.env['CLI_JAW_HOME'];
    process.env['CLI_JAW_HOME'] = 'C:\\jawhome';
    try {
        const env = win32Env(['C:\\jawhome', 'C:\\jawhome\\f.md']);
        assert.strictEqual(assertSendFilePath('C:\\jawhome\\f.md', undefined, null, env), 'C:\\jawhome\\f.md');
    } finally {
        if (prev === undefined) delete process.env['CLI_JAW_HOME']; else process.env['CLI_JAW_HOME'] = prev;
    }
});

test('send boundary rejects a sibling-prefix directory', () => {
    const env = win32Env(['C:\\WorkOther\\a.md', 'C:\\Work']);
    assert.strictEqual(
        codeOf(() => assertSendFilePath('C:\\WorkOther\\a.md', 'C:\\Work', null, env)),
        'path_not_allowed',
    );
});

test('send boundary honours projectDirs', () => {
    const env = win32Env(['C:\\Proj\\a.md', 'C:\\Proj']);
    const out = assertSendFilePath('C:\\Proj\\a.md', undefined, ['C:\\Proj'], env);
    assert.strictEqual(out, 'C:\\Proj\\a.md');
});

test('projectDirs works when stored casing differs from on-disk casing', () => {
    // Verified on Windows: realpath('...\\mixed') returns '...\\MiXeD'. The
    // previous `realpath(dir) === resolve(dir)` precondition therefore dropped
    // the root entirely and denied every file under it.
    const env = win32Env(['C:\\MiXeD', 'C:\\MiXeD\\a.md']);
    const out = assertSendFilePath('C:\\mixed\\a.md', undefined, ['C:\\mixed'], env);
    assert.strictEqual(out, 'C:\\MiXeD\\a.md');
});

test('POSIX send boundary stays case-SENSITIVE', () => {
    const env = posixEnv(['/work', '/work/a.md']);
    assert.strictEqual(
        codeOf(() => assertSendFilePath('/WORK/a.md', '/work', null, env)),
        'path_not_resolvable',
    );
});

test('send boundary still reports unresolvable paths', () => {
    const env = win32Env([]);
    assert.strictEqual(
        codeOf(() => assertSendFilePath('C:\\nope\\a.md', 'C:\\work', null, env)),
        'path_not_resolvable',
    );
});

test('POSIX send boundary permits a legitimate colon filename', () => {
    const env = posixEnv(['/work/a:b.md', '/work']);
    const out = assertSendFilePath('/work/a:b.md', '/work', null, env);
    assert.strictEqual(out, '/work/a:b.md');
});

// ── production defaults ──────────────────────────────────────────

test('the default environment matches the host', () => {
    assert.strictEqual(hostPathEnvironment.impl, path);
    assert.strictEqual(hostPathEnvironment.windows, process.platform === 'win32');
});

test('existing call signatures keep working without an env argument', () => {
    // The ~20 production callers pass 1-3 arguments; none may need a change.
    const base = path.resolve('.');
    assert.strictEqual(safeResolveUnder(base, 'a.md'), path.join(base, 'a.md'));
});
