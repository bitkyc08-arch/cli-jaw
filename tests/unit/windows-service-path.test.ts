import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCliDetectionEnv } from '../../src/core/cli-detect.ts';
import { buildServicePath, normalizeWindowsPathEntry, splitPathList } from '../../src/core/runtime-path.ts';

const WINDOWS_HOME = 'C:\\Users\\u';

// ─── #471: MSYS entry FORMAT, not just the delimiter ───
//
// #273 fixed how a git-bash PATH is SPLIT. The entries it produced were still
// POSIX-spelled, and `where.exe` — a native Win32 tool — cannot resolve those.
// A server started from git-bash then resolved no CLI at all, while a natively
// started one on the same host resolved fine.

test('WSP-471-A: MSYS and Cygwin drive entries become Win32 paths', () => {
    assert.equal(normalizeWindowsPathEntry('/c/Users/u/AppData/Roaming/npm'), 'C:\\Users\\u\\AppData\\Roaming\\npm');
    assert.equal(normalizeWindowsPathEntry('/cygdrive/d/tools'), 'D:\\tools');
    assert.equal(normalizeWindowsPathEntry('/c'), 'C:\\');
});

test('WSP-471-B: entries with no Win32 equivalent are dropped, not passed through', () => {
    // Keeping '/mingw64/bin' would leave an entry no Win32 tool can resolve.
    assert.equal(normalizeWindowsPathEntry('/mingw64/bin'), null);
    assert.equal(normalizeWindowsPathEntry('/usr/bin'), null);
});

test('WSP-471-C: native Windows entries are left alone', () => {
    assert.equal(normalizeWindowsPathEntry('C:\\WINDOWS\\System32'), 'C:\\WINDOWS\\System32');
    assert.equal(normalizeWindowsPathEntry('\\\\server\\share'), '\\\\server\\share');
    // Drive-relative entries stay valid Windows PATH entries (see splitPathList).
    assert.equal(normalizeWindowsPathEntry('C:tools'), 'C:tools');
});

test('WSP-471-D: a git-bash PATH yields a service PATH where.exe can resolve', () => {
    // The shape #471's process tree points at: nohup.exe -> node.exe, i.e. a
    // win32 process launched from git-bash, inheriting a POSIX-spelled PATH.
    const gitBashPath = '/mingw64/bin:/usr/bin:/c/Users/u/AppData/Roaming/npm';
    const result = buildServicePath(gitBashPath, [], WINDOWS_HOME, 'win32', {
        SystemRoot: 'C:\\WINDOWS',
        APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    });
    const entries = result.split(';');

    // The npm global dir — where the codex.cmd shim lives — is now resolvable.
    assert.ok(entries.includes('C:\\Users\\u\\AppData\\Roaming\\npm'));
    // and no POSIX-spelled entry survives to be handed to where.exe.
    assert.deepEqual(entries.filter((entry) => entry.startsWith('/')), []);
});

test('WSP-471-E: normalization does not duplicate a dir spelled both ways', () => {
    const result = buildServicePath('/c/tools:C:\\tools', [], WINDOWS_HOME, 'win32', { SystemRoot: 'C:\\WINDOWS' });
    const occurrences = result.split(';').filter((entry) => entry.toLowerCase() === 'c:\\tools');

    assert.equal(occurrences.length, 1);
});

test('WSP-471-F: posix hosts are untouched by the win32 normalization', () => {
    const result = buildServicePath('/usr/local/bin:/opt/tools', [], '/home/u', 'darwin', {});
    const entries = result.split(':');

    assert.ok(entries.includes('/usr/local/bin'));
    assert.ok(entries.includes('/opt/tools'));
});

test('WSP-001: win32 defaults carry System32 and drop Unix directories', () => {
    const result = buildServicePath('', [], WINDOWS_HOME, 'win32', { SystemRoot: 'C:\\WINDOWS' });
    const entries = result.split(';');

    assert.ok(entries.includes('C:\\WINDOWS\\System32'));
    assert.equal(entries.includes('/usr/bin'), false);
});

test('WSP-002: posix defaults are unchanged', () => {
    const result = buildServicePath('', [], '/home/u', 'darwin', { SystemRoot: 'C:\\WINDOWS' });
    const entries = result.split(':');

    assert.ok(entries.includes('/usr/bin'));
    assert.equal(entries.some((entry) => entry.includes('System32')), false);
});

test('WSP-003: SystemRoot override is honored', () => {
    const result = buildServicePath('', [], WINDOWS_HOME, 'win32', { SystemRoot: 'D:\\Win' });
    const entries = result.split(';');

    assert.ok(entries.includes('D:\\Win\\System32'));
    assert.equal(entries.includes('C:\\WINDOWS\\System32'), false);
});

test('WSP-004: SystemRoot absent falls back to the documented default', () => {
    const entries = buildServicePath('', [], WINDOWS_HOME, 'win32', {}).split(';');

    assert.ok(entries.includes('C:\\WINDOWS\\System32'));
});

test('WSP-005: an MSYS colon PATH is split, not swallowed', () => {
    const result = splitPathList('/mingw64/bin:/usr/bin:/c/WINDOWS/system32', 'win32');

    assert.deepEqual(result, ['/mingw64/bin', '/usr/bin', '/c/WINDOWS/system32']);
    assert.equal(result.length, 3);
});

test('WSP-006: a Windows drive-letter PATH is never colon-split', () => {
    assert.deepEqual(splitPathList('C:\\a;C:\\b', 'win32'), ['C:\\a', 'C:\\b']);
    assert.deepEqual(splitPathList('C:\\a', 'win32'), ['C:\\a']);
});

test('WSP-006b: a MIXED msys+windows PATH splits every entry', () => {
    const result = splitPathList('/mingw64/bin:/usr/bin:C:\\Users\\u\\AppData\\Roaming\\npm', 'win32');

    assert.deepEqual(result, ['/mingw64/bin', '/usr/bin', 'C:\\Users\\u\\AppData\\Roaming\\npm']);
});

test('WSP-006c: UNC and relative entries survive', () => {
    assert.deepEqual(splitPathList('\\\\server\\share\\bin', 'win32'), ['\\\\server\\share\\bin']);
    assert.deepEqual(splitPathList('node_modules\\.bin', 'win32'), ['node_modules\\.bin']);
});

test('WSP-006d: an empty PATH yields no entries', () => {
    assert.deepEqual(splitPathList('', 'win32'), []);
});

test('WSP-006e: drive-relative entries stay whole', () => {
    assert.deepEqual(splitPathList('C:tools', 'win32'), ['C:tools']);
    assert.deepEqual(splitPathList('C:.\\node_modules\\.bin', 'win32'), ['C:.\\node_modules\\.bin']);
    assert.deepEqual(splitPathList('/mingw64/bin:C:tools', 'win32'), ['/mingw64/bin', 'C:tools']);
});

test('WSP-007: win32 output joins with semicolons', () => {
    const result = buildServicePath(
        '/mingw64/bin:/usr/bin',
        [],
        WINDOWS_HOME,
        'win32',
        { SystemRoot: 'C:\\WINDOWS' },
    );
    const entries = result.split(';');

    assert.ok(result.includes(';'));
    assert.equal(result.includes('/mingw64/bin:/usr/bin'), false);
    // These two used to be asserted as SURVIVING entries. They no longer do,
    // and that is the #471 fix rather than a regression: '/mingw64/bin' and
    // '/usr/bin' are MSYS-internal paths with no Win32 equivalent, and
    // `where.exe` cannot resolve either. This test still owns the delimiter
    // claim (#273); WSP-471-D owns what happens to the entries themselves.
    assert.deepEqual(entries.filter((entry) => entry.startsWith('/')), []);
});

test('WSP-008: Windows dedupe is case-insensitive and keeps first spelling', () => {
    const seededSpelling = 'C:\\Windows\\System32';
    const entries = buildServicePath(
        seededSpelling,
        [],
        WINDOWS_HOME,
        'win32',
        { SystemRoot: 'C:\\WINDOWS' },
    ).split(';');
    const system32Entries = entries.filter((entry) => entry.toLowerCase() === 'c:\\windows\\system32');

    assert.deepEqual(system32Entries, [seededSpelling]);
});

test('WSP-009: PATHEXT survives into the detection env', () => {
    const env = buildCliDetectionEnv('/tmp/jaw-path', { PATHEXT: '.COM;.EXE' });

    assert.equal(env.PATHEXT, '.COM;.EXE');
});
