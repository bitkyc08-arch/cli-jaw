import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCliDetectionEnv } from '../../src/core/cli-detect.ts';
import { buildServicePath, splitPathList } from '../../src/core/runtime-path.ts';

const WINDOWS_HOME = 'C:\\Users\\u';

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
    assert.deepEqual(entries.slice(0, 2), ['/mingw64/bin', '/usr/bin']);
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
