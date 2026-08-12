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
    foldPathIdentity,
    safeResolveUnder,
    assertSendFilePath,
    hostPathEnvironment,
    type PathEnvironment,
} from '../../src/security/path-guards.js';

/** A Win32 environment with a fake realpath, so no real NTFS volume is needed. */
function win32Env(existing: string[] = []): PathEnvironment {
    const known = new Set(existing.map((p) => p.toLowerCase()));
    return {
        impl: path.win32,
        windows: true,
        // Identity canonicalization: these fixtures are already canonical.
        realpath: (p: string) => (known.has(p.toLowerCase()) ? p : null),
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

// ── case folding ─────────────────────────────────────────────────

test('folding is ASCII-only on Windows and identity on POSIX', () => {
    assert.strictEqual(foldPathIdentity('C:\\Data\\X', win32Env()), 'c:\\data\\x');
    assert.strictEqual(foldPathIdentity('/Data/X', posixEnv()), '/Data/X');
});

test('folding leaves non-ASCII untouched (Turkish dotless-i hazard)', () => {
    // A locale-sensitive toLowerCase() would map these unpredictably.
    assert.strictEqual(foldPathIdentity('C:\\İX\\ıY', win32Env()), 'c:\\İx\\ıy');
});

// ── containment ──────────────────────────────────────────────────

test('Windows containment ignores case but still returns the unfolded path', () => {
    const env = win32Env();
    const out = safeResolveUnder('C:\\Data', 'Sub\\F.md', env);
    assert.strictEqual(out, 'C:\\Data\\Sub\\F.md', 'must not return a lowercased path');
});

test('Windows containment accepts a differently-cased root', () => {
    const env = win32Env();
    assert.strictEqual(codeOf(() => safeResolveUnder('c:\\data', 'F.md', env)), 'NO_THROW');
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
    const env = win32Env(['C:\\Work\\a.md', 'C:\\Work']);
    const out = assertSendFilePath('C:\\Work\\a.md', 'c:\\work', null, env);
    assert.strictEqual(out, 'C:\\Work\\a.md');
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
