// Cycle 9 (parity2 090): vendor hardening + diagnostics wiring + DR marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyComposerInterstitial } from '../../src/browser/web-ai/composer-interstitial.ts';
import { looksLikeDeepResearchToolCallCapture, isIncompleteDeepResearchText } from '../../src/browser/web-ai/chatgpt-deep-research-report.ts';
import { captureWebAiDiagnostics } from '../../src/browser/web-ai/diagnostics.ts';
import { createSession, getSession } from '../../src/browser/web-ai/session.ts';

test('C9-INT-1: interstitial verdict becomes a typed provider error; probe failure keeps the original', async () => {
    const detect = async () => ({ kind: 'cloudflare' as const, evidence: 'checking your browser', retryHint: 'wait-and-retry' });
    const err = await classifyComposerInterstitial({} as never, 'gemini', new Error('composer'), { detect: detect as never });
    assert.ok(err);
    assert.equal((err as { errorCode?: string }).errorCode, 'provider.interstitial');
    const throwing = async () => { throw new Error('probe died'); };
    const none = await classifyComposerInterstitial({} as never, 'grok', new Error('composer'), { detect: throwing as never });
    assert.equal(none, null);
});

test('C9-DR-1: tool-call wrappers rejected as reports; boundary respected', () => {
    const longPad = ' report body '.repeat(50);
    assert.equal(looksLikeDeepResearchToolCallCapture('Called tool: Deep Research App' + longPad), true);
    assert.equal(looksLikeDeepResearchToolCallCapture('Answer: used tool — browsing' + longPad), true);
    // token boundary: a report TITLED "Used Tools…" is NOT a wrapper
    assert.equal(looksLikeDeepResearchToolCallCapture('Used Toolsets in Modern Oncology' + longPad), false);
    assert.equal(isIncompleteDeepResearchText('Called tool: Deep Research App' + longPad), true);
});

test('C9-DIAG-1: diagnostics with a sessionId persists an artifact ref', async () => {
    const session = createSession({
        vendor: 'chatgpt', targetId: 'T-diag', url: 'https://chatgpt.com/c/x',
        envelope: { vendor: 'chatgpt', question: 'q' }, assistantCount: 0, timeoutMs: 60_000,
    } as never);
    const page = {
        url: () => 'https://chatgpt.com/c/x',
        title: async () => 'test',
        locator: () => ({ count: async () => 0, first: () => ({ isVisible: async () => false }) }),
        evaluate: async () => ({ url: 'https://chatgpt.com/c/x', title: 'test', selectorCounts: {}, visibleCounts: {}, warnings: [] }),
    };
    const diag = await captureWebAiDiagnostics({ stage: 'send-click', page: page as never, sessionId: session.sessionId });
    assert.ok(diag.artifactRefs.length >= 1, JSON.stringify({ refs: diag.artifactRefs, warnings: diag.warnings }));
    const record = getSession(session.sessionId);
    assert.ok((record?.artifacts || []).length >= 1, 'artifact descriptor appended to the session');
});

