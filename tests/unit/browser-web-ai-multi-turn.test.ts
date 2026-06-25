import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { WebAiSessionRecord } from '../../src/browser/web-ai/types.js';

// Regression for catalog 106.2/106.5: a resumed multi-turn session must continue
// turn indices from prior turns and merge history into both the transcript and the
// persisted record — instead of restarting at index 0 and dropping earlier turns.
test('BWAI-MULTITURN-001: resumed multi-turn continues indices and merges prior history', async (t) => {
    const persistCalls: Array<Record<string, unknown>> = [];
    t.mock.module('../../src/browser/web-ai/session.js', {
        namedExports: {
            updateSessionResult: (input: Record<string, unknown>) => { persistCalls.push(input); return null; },
            updateSessionStatus: () => null,
            appendSessionArtifact: () => null,
        },
    });
    t.mock.module('../../src/browser/web-ai/vendor-editor-contract.js', {
        namedExports: {
            createChatGptEditorAdapter: () => ({
                waitForReady: async () => {},
                getCommitBaseline: async () => ({}),
                insertPrompt: async () => {},
                submitPrompt: async () => {},
                verifyPromptCommitted: async () => {},
            }),
        },
    });

    // query-string forces a fresh module graph so this test binds to its own mocks
    const { sendMultiTurn } = await import('../../src/browser/web-ai/chatgpt-multi-turn.js?case=1');

    // First assistant-count read is the pre-submit baseline (1 prior message); every
    // later read reports 2 so pollTurn sees the new turn land.
    let assistantCountCalls = 0;
    const fakePage = {
        locator(sel: string) {
            if (sel.includes('stop-button') || sel.includes('Stop generating')) {
                return { count: async () => 0 };
            }
            return {
                count: async () => { assistantCountCalls += 1; return assistantCountCalls === 1 ? 1 : 2; },
                all: async () => [{ innerText: async () => 'answer-2' }],
            };
        },
        url: () => 'https://chatgpt.com/c/test',
    };

    const session = {
        sessionId: 'webai_test', vendor: 'chatgpt', targetId: 't', url: 'u',
        promptHash: 'h', assistantCount: 1, status: 'complete', timeoutMs: 1000,
        answerText: 'answer-1',
        turns: [{ index: 0, prompt: 'q1', answer: 'answer-1', status: 'complete', warnings: [], sentAt: 's', completedAt: 'c' }],
        createdAt: 'x', updatedAt: 'y',
        // test double: only the fields sendMultiTurn reads are populated
    } as unknown as WebAiSessionRecord;

    const result = await sendMultiTurn(fakePage as unknown as Page, {}, { followUps: ['q2'], session, timeoutPerTurn: 8000 });

    assert.equal(result.ok, true);
    // merged transcript carries BOTH the prior turn and the new one
    assert.match(result.transcriptMarkdown, /Turn 0/);
    assert.match(result.transcriptMarkdown, /Turn 1/);
    // final persisted record merges history and continues the index from length(prior)
    const finalPersist = persistCalls[persistCalls.length - 1];
    const persistedTurns = finalPersist?.turns as Array<{ index: number }> | undefined;
    assert.ok(persistedTurns, 'final persist must include a turns array');
    assert.equal(persistedTurns.length, 2);
    assert.deepEqual(persistedTurns.map((t) => t.index), [0, 1]);
    assert.equal(finalPersist?.followUpCount, 2);
});

// Partial failure must persist the merged transcript as a session artifact (catalog 106.6)
// — exercises the slice 2.3 wiring through appendSessionArtifact.
test('BWAI-MULTITURN-002: partial failure saves the merged transcript as an artifact', async (t) => {
    const artifactCalls: Array<{ kind: string }> = [];
    t.mock.module('../../src/browser/web-ai/session.js', {
        namedExports: {
            updateSessionResult: () => null,
            updateSessionStatus: () => null,
            appendSessionArtifact: (_sid: string, d: { kind: string }) => { artifactCalls.push(d); return null; },
        },
    });
    t.mock.module('../../src/browser/web-ai/session-artifacts.js', {
        namedExports: {
            trySaveTranscript: () => ({ ok: true, descriptor: { kind: 'transcript', path: 'transcript.md', label: 't', savedAt: 'x' } }),
        },
    });
    t.mock.module('../../src/browser/web-ai/vendor-editor-contract.js', {
        namedExports: {
            createChatGptEditorAdapter: () => ({
                waitForReady: async () => {}, getCommitBaseline: async () => ({}),
                insertPrompt: async () => {}, submitPrompt: async () => {}, verifyPromptCommitted: async () => {},
            }),
        },
    });
    const { sendMultiTurn } = await import('../../src/browser/web-ai/chatgpt-multi-turn.js?case=2');

    // assistant count never exceeds baseline → pollTurn times out → the turn fails
    const fakePage = {
        locator(sel: string) {
            if (sel.includes('stop-button') || sel.includes('Stop generating')) return { count: async () => 0 };
            return { count: async () => 1, all: async () => [{ innerText: async () => '' }] };
        },
        url: () => 'https://chatgpt.com/c/x',
    };
    const session = { sessionId: 'webai_p', turns: [], answerText: '' } as unknown as WebAiSessionRecord;
    const result = await sendMultiTurn(fakePage as unknown as Page, {}, { followUps: ['q'], session, timeoutPerTurn: 300 });

    assert.equal(result.ok, false);
    assert.equal(artifactCalls.length, 1);
    assert.equal(artifactCalls[0]?.kind, 'transcript');
});
