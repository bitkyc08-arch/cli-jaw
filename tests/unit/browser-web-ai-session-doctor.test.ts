import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSessionDoctorReport,
    sanitizeSession,
    summarizeSession,
    recommendSessionActions,
    type SessionDoctorDeps,
    type DoctorSession,
} from '../../src/browser/web-ai/session-doctor.ts';

const baseSession: DoctorSession = {
    sessionId: 's1',
    vendor: 'chatgpt',
    status: 'complete',
    targetId: 'T1',
    originalUrl: 'https://chatgpt.com/?model=gpt-5&secret=xyz',
    conversationUrl: 'https://chatgpt.com/c/abc-123?token=leak',
    updatedAt: '2026-06-25T00:00:00Z',
};

function makeDeps(over: Partial<SessionDoctorDeps> & { session?: DoctorSession | null } = {}): SessionDoctorDeps {
    return {
        getSession: () => ('session' in over ? over.session ?? null : baseSession),
        readSessionCommandLock: over.readSessionCommandLock ?? (() => null),
        verifySessionTab: over.verifySessionTab ?? (async () => ({ valid: true })),
        listActiveCommands: over.listActiveCommands ?? (async () => []),
        getPort: over.getPort ?? (() => 9222),
    };
}

// 102 session-doctor: redaction + summary/recommendation logic.
test('BWAI-DOCTOR-001: sanitizeSession redacts URLs to host+path, drops query/secrets', () => {
    const s = sanitizeSession(baseSession);
    assert.equal(s.originalUrl, 'https://chatgpt.com/');
    assert.equal(s.conversationUrl, 'https://chatgpt.com/c/abc-123');
    assert.equal(s.sessionId, 's1');
    assert.equal(s.targetId, 'T1');
    assert.deepEqual(s.warnings, []);
});

test('BWAI-DOCTOR-002: missing session → ok:false report', async () => {
    const r = await buildSessionDoctorReport(makeDeps({ session: null }), 'ghost');
    assert.equal(r.ok, false);
    assert.equal(r.summary, 'missing session record');
    assert.match(r.recommendations[0]!, /sessions list/);
});

test('BWAI-DOCTOR-003: healthy session → live-target summary', async () => {
    const r = await buildSessionDoctorReport(makeDeps(), 's1');
    assert.equal(r.ok, true);
    assert.equal(r.summary, 'complete on live target');
    assert.equal(r.vendor, 'chatgpt');
    // never leaks raw URL
    assert.equal(r.session?.conversationUrl, 'https://chatgpt.com/c/abc-123');
});

test('BWAI-DOCTOR-004: active lock → locked summary + lock recommendation', async () => {
    const r = await buildSessionDoctorReport(
        makeDeps({ readSessionCommandLock: () => ({ pid: 4321, stale: false }) }),
        's1',
    );
    assert.equal(r.summary, 'locked by another command');
    assert.match(r.recommendations[0]!, /command lock is active/);
});

test('BWAI-DOCTOR-005: invalid target without --navigate → recovery hint', async () => {
    const r = await buildSessionDoctorReport(
        makeDeps({ verifySessionTab: async () => ({ valid: false, needsRecovery: true }) }),
        's1',
    );
    assert.equal(r.summary, 'target missing or needs recovery');
    assert.ok(r.recommendations.some((x) => /doctor s1 --navigate/.test(x)));
});

test('BWAI-DOCTOR-006: verifySessionTab throwing is caught into an invalid target', async () => {
    const r = await buildSessionDoctorReport(
        makeDeps({ verifySessionTab: async () => { throw new Error('cdp gone'); } }),
        's1',
    );
    assert.equal(r.target?.valid, false);
    assert.equal(r.target?.error, 'cdp gone');
});

test('BWAI-DOCTOR-007: recommendSessionActions default hint when nothing else applies', () => {
    const out = recommendSessionActions({
        session: { sessionId: 's1', vendor: 'gemini', status: 'complete' },
        target: { valid: true },
        lock: null,
        navigate: false,
    });
    assert.equal(out.length, 1);
    assert.match(out[0]!, /poll --vendor gemini --session s1/);
});

test('BWAI-DOCTOR-008: summarizeSession precedence — lock over target', () => {
    assert.equal(
        summarizeSession({ session: baseSession, target: { valid: false }, lock: { pid: 1, stale: false } }),
        'locked by another command',
    );
    assert.equal(
        summarizeSession({ session: baseSession, target: { valid: false }, lock: { pid: 1, stale: true } }),
        'target missing or needs recovery',
    );
});
