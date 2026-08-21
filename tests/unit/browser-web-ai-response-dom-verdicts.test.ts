// Cycle 4 (parity2 040): tri-state stop probe, ordering verdict, activity
// strata grammar, unread-vs-empty, and finalizer deadline fencing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    probeStopButton,
    readTopLevelAssistantTextsFromLocators,
    isActiveState,
    CHATGPT_STOP_SELECTORS,
} from '../../src/browser/web-ai/chatgpt-response-dom.ts';
import { finalizeProviderTab } from '../../src/browser/web-ai/tab-finalizer.ts';
import { createSession, getSession } from '../../src/browser/web-ai/session.ts';

function mkLocator(nodes: unknown[]): unknown {
    return { locator: () => ({ all: async () => nodes }) };
}

test('RD-STOP-1: visible stop node short-circuits to visible', async () => {
    const scope = mkLocator([{ isVisible: async () => true }]);
    assert.equal(await probeStopButton(scope), 'visible');
});

test('RD-STOP-2: unreadable probe is unknown, never absent', async () => {
    const throwing = { locator: () => ({ all: async () => { throw new Error('cdp lost'); } }) };
    assert.equal(await probeStopButton(throwing), 'unknown');
    const partial = mkLocator([{ /* no isVisible */ }]);
    assert.equal(await probeStopButton(partial), 'unknown');
    assert.equal(await probeStopButton(null), 'unknown');
});

test('RD-STOP-3: fully-inspected empty scope is absent', async () => {
    const scope = mkLocator([]);
    assert.equal(await probeStopButton(scope), 'absent');
});

test('RD-STOP-4: form-scoped stop selector excludes dictation/voice/read-aloud', () => {
    const labelled = CHATGPT_STOP_SELECTORS[1]!;
    assert.match(labelled, /^form /);
    assert.match(labelled, /dictat/);
    assert.match(labelled, /voice/);
});

test('RD-LOC-1: partial locator read reports ok:false, not a smaller success', async () => {
    const page = {
        locator: () => ({
            all: async () => [
                { evaluate: async () => 'first turn' },
                { evaluate: async () => { throw new Error('detached'); } },
            ],
        }),
    };
    const res = await readTopLevelAssistantTextsFromLocators(page as never, ['[x]']);
    assert.equal(res.ok, false);
    assert.deepEqual(res.texts, []);
});

test('RD-ACT-1: activity strength boolean view treats unknown as inactive', () => {
    assert.equal(isActiveState({ strength: 'strong', evidence: 'stop-button' }), true);
    assert.equal(isActiveState({ strength: 'weak', evidence: 'panel-text' }), true);
    assert.equal(isActiveState({ strength: 'none', evidence: '' }), false);
    assert.equal(isActiveState({ strength: 'unknown', evidence: '' }), false);
});

test('FIN-1: finalizer refuses all side effects once expired at entry', async () => {
    const session = createSession({ vendor: 'chatgpt', targetId: 'T-fin-1', url: 'https://chatgpt.com/c/x', timeoutMs: 60_000, envelope: { vendor: 'chatgpt', question: 'q' }, assistantCount: 0 } as never);
    const res = await finalizeProviderTab({
        vendor: 'chatgpt', session, port: 1, url: 'https://chatgpt.com/c/x', answerText: 'answer',
        stillActive: () => false,
    });
    assert.deepEqual(res, { finalized: false, skippedReason: 'poll-deadline-exceeded' });
    assert.notEqual(getSession(session.sessionId)?.status, 'complete');
});

test('FIN-2: deadline passing between write and pool skips the pool phase only', async () => {
    const session = createSession({ vendor: 'chatgpt', targetId: 'T-fin-2', url: 'https://chatgpt.com/c/y', timeoutMs: 60_000, envelope: { vendor: 'chatgpt', question: 'q' }, assistantCount: 0 } as never);
    let calls = 0;
    const res = await finalizeProviderTab({
        vendor: 'chatgpt', session, port: 1, url: 'https://chatgpt.com/c/y', answerText: 'answer',
        stillActive: () => { calls += 1; return calls <= 1; }, // active at entry, expired at re-check
    });
    assert.equal(res.finalized, true);
    assert.equal(res.skippedReason, 'poll-deadline-exceeded');
    assert.equal(getSession(session.sessionId)?.status, 'complete');
});
