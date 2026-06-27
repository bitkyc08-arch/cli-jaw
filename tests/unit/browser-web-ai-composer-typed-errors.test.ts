import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { findComposerCandidate, verifyPromptCommitted } from '../../src/browser/web-ai/chatgpt-composer.js';
import { normalizeFailureStage } from '../../src/browser/web-ai/diagnostics.js';

type Thrown = { errorCode?: string; stage?: string; selectorsTried?: string[]; mutationAllowed?: boolean };

// 105.1/105.7: composer-not-visible is a typed error carrying the composer-prereq stage + tried selectors.
test('BWAI-COMPOSER-TYPEDERR-001: missing composer throws provider.composer-not-visible / composer-prereq', async () => {
    const page = { locator: () => ({ count: async () => 0 }), waitForTimeout: async () => undefined } as unknown as Page;
    await assert.rejects(
        () => findComposerCandidate(page),
        (err: unknown) => {
            const e = err as Thrown;
            assert.equal(e.errorCode, 'provider.composer-not-visible');
            assert.equal(e.stage, 'composer-prereq');
            assert.ok((e.selectorsTried?.length ?? 0) > 0, 'reports the selectors it tried');
            return true;
        },
    );
});

// 105.1/105.7: a commit that never lands throws commit-not-verified / commit-verify (mutation attempted).
test('BWAI-COMPOSER-TYPEDERR-002: unverified commit throws provider.commit-not-verified / commit-verify', async () => {
    const loc = { all: async () => [], first: () => ({ count: async () => 0 }), count: async () => 0, innerText: async () => '', inputValue: async () => '' };
    const page = { locator: () => loc, evaluate: async () => null, waitForTimeout: async () => undefined } as unknown as Page;
    await assert.rejects(
        () => verifyPromptCommitted(page, 'prompt that never commits', { timeoutMs: 1 }),
        (err: unknown) => {
            const e = err as Thrown;
            assert.equal(e.errorCode, 'provider.commit-not-verified');
            assert.equal(e.stage, 'commit-verify');
            assert.equal(e.mutationAllowed, true);
            return true;
        },
    );
});

// 105.7: the 6 agbrowse core-path stage labels are now recognized (not normalized away to 'unknown').
test('BWAI-COMPOSER-TYPEDERR-003: normalizeFailureStage recognizes the 6 new core stages', () => {
    for (const stage of ['connect', 'poll', 'commit-verify', 'composer-prereq', 'context-preflight', 'attachment-verify']) {
        assert.equal(normalizeFailureStage(stage), stage);
    }
    // sanity: an unknown stage still collapses to 'unknown'.
    assert.equal(normalizeFailureStage('totally-made-up'), 'unknown');
});
