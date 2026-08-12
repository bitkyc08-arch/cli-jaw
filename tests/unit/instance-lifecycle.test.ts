import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clearPidfileIfOurs,
    parseWindowsStartTime,
    probePid,
    verifyOwnership,
    type LifecycleDeps,
    type PidfileRecord,
    type ProcessStartTime,
} from '../../src/core/instance-lifecycle.js';

const startedAt: ProcessStartTime = { value: '1786510600000', source: 'macos-ps' };
const record: PidfileRecord = { pid: 1234, startedAt, port: 3457, home: '/jaw/home', version: '2.2.18' };

function deps(overrides: Partial<LifecycleDeps> = {}): LifecycleDeps {
    return {
        readFile: () => JSON.stringify(record),
        writeFileAtomic: () => undefined,
        removeFile: () => undefined,
        probe: () => ({ status: 'alive' }),
        processStartedAt: () => startedAt,
        ...overrides,
    };
}

test('IL-001: a missing pidfile is no-pidfile', () => {
    assert.equal(verifyOwnership(record.home, deps({ readFile: () => null })).status, 'no-pidfile');
});

test('IL-002: a different home is foreign', () => {
    assert.equal(verifyOwnership('/different/home', deps()).status, 'foreign');
});

test('IL-003: a dead pid is already-stopped', () => {
    assert.equal(verifyOwnership(record.home, deps({ probe: () => ({ status: 'dead' }) })).status, 'already-stopped');
});

test('IL-004: EPERM is permission-denied, never stopped', () => {
    const error = Object.assign(new Error('denied'), { code: 'EPERM' });
    const probe = probePid(record.pid, () => { throw error; });
    assert.equal(probe.status, 'permission-denied');
    assert.equal(verifyOwnership(record.home, deps({ probe: () => probe })).status, 'permission-denied');
});

test('IL-005: a recycled pid is stale, not owned', () => {
    const other = { ...startedAt, value: '1786510605000' };
    assert.equal(verifyOwnership(record.home, deps({ processStartedAt: () => other })).status, 'stale');
});

test('IL-005b: a near-miss start time does not pass', () => {
    const nearMiss = { ...startedAt, value: '1786510601500' };
    assert.equal(verifyOwnership(record.home, deps({ processStartedAt: () => nearMiss })).status, 'stale');
});

test('IL-005c: a different source never matches', () => {
    const differentSource: ProcessStartTime = { value: startedAt.value, source: 'windows-filetime' };
    assert.equal(verifyOwnership(record.home, deps({ processStartedAt: () => differentSource })).status, 'stale');
});

test('IL-009: unavailable start time is unverifiable, not stale', () => {
    let removed = false;
    const result = verifyOwnership(record.home, deps({ processStartedAt: () => null, removeFile: () => { removed = true; } }));
    assert.equal(result.status, 'unverifiable');
    assert.equal(removed, false);
});

test('IL-006: a matching record is owned', () => {
    assert.equal(verifyOwnership(record.home, deps()).status, 'owned');
});

test('IL-007: malformed json is no-pidfile', () => {
    assert.equal(verifyOwnership(record.home, deps({ readFile: () => '{' })).status, 'no-pidfile');
});

test('IL-008: clear only removes our own record', () => {
    let removed = false;
    const overwritten = { ...record, startedAt: { ...startedAt, value: '1786510601000' } };
    const cleared = clearPidfileIfOurs(record, deps({
        readFile: () => JSON.stringify(overwritten),
        removeFile: () => { removed = true; },
    }));
    assert.equal(cleared, false);
    assert.equal(removed, false);
});

test('IL-010: the windows start-time parser reads a real FILETIME line', () => {
    assert.deepEqual(parseWindowsStartTime('133676409000000000\r\n'), {
        value: '133676409000000000', source: 'windows-filetime',
    });
});

test('IL-011: an unparseable windows response is null, not a guess', () => {
    assert.equal(parseWindowsStartTime(''), null);
    assert.equal(parseWindowsStartTime('Get-Process: Access denied'), null);
});
