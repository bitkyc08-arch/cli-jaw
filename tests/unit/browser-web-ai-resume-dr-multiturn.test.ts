// Cycle 7 (parity2 070): resume expiry, DR activity gate, multi-turn deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSessionsCommand } from '../../src/browser/web-ai/cli-sessions.ts';
import { createSession, getSession } from '../../src/browser/web-ai/session.ts';
import { sendMultiTurn } from '../../src/browser/web-ai/chatgpt-multi-turn.ts';

function mkSession(overrides: Record<string, unknown> = {}) {
    return createSession({
        vendor: 'chatgpt', targetId: 'T-c7-' + Math.random().toString(36).slice(2), url: 'https://chatgpt.com/c/x',
        envelope: { vendor: 'chatgpt', question: 'q' }, assistantCount: 0, timeoutMs: 60_000,
        ...overrides,
    } as never);
}

test('C7-RESUME-1: expired session refuses resume with a typed timeout outcome', async () => {
    const session = mkSession({ timeoutMs: 1 });
    // ensure the deadline has passed
    await new Promise(r => setTimeout(r, 10));
    const result = await runSessionsCommand(['resume', session.sessionId], {}, {}, {});
    assert.equal(result['ok'], false);
    assert.equal(result['status'], 'timeout');
    assert.match(String(result['error']), /deadline already passed/);
});

test('C7-DOCTOR-1: sessions doctor is routed and returns a report', async () => {
    const session = mkSession();
    const result = await runSessionsCommand(['doctor', session.sessionId], {}, {}, {});
    assert.equal(result['status'], 'session-doctor');
    assert.equal(result['sessionId'], session.sessionId);
});

test('C7-MT-1: multi-turn outer deadline answers with the expiry envelope, no post-deadline writes', async () => {
    const session = mkSession();
    const preStatus = getSession(session.sessionId)?.status;
    const page = {
        url: () => 'https://chatgpt.com/c/x',
        locator: () => ({
            count: async () => { await new Promise(() => undefined); return 0; }, // never settles
            all: async () => [],
        }),
        waitForTimeout: async () => undefined,
        keyboard: { press: async () => undefined },
        evaluate: async () => false,
    };
    const result = await sendMultiTurn(page as never, {}, {
        followUps: ['follow-up 1'],
        session,
        timeoutPerTurn: 400,
        outerBudgetMs: 1_500,
    });
    assert.equal(result.ok, false);
    assert.ok(result.warnings.includes('multi-turn-deadline-expired'), JSON.stringify(result.warnings));
    assert.equal(result.finalStatus, 'partial');
    // the losing run must not have flipped the session to complete/error after expiry
    const post = getSession(session.sessionId)?.status;
    assert.equal(post, preStatus);
});
