import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyTabState,
    buildTabSummary,
    INSPECT_EXPRESSION,
} from '../../src/browser/web-ai/tab-inspect.ts';

// 102 tab-inspect: state classification + summary mapping (pure).
test('BWAI-TABINSPECT-001: classifyTabState — detached when unauthenticated', () => {
    assert.equal(
        classifyTabState({ authenticated: false, stopExists: true, sendExists: true, promptReady: true, assistantCount: 5 }),
        'detached',
    );
});

test('BWAI-TABINSPECT-002: classifyTabState — running when stop button present', () => {
    assert.equal(
        classifyTabState({ authenticated: true, stopExists: true, sendExists: false, promptReady: false, assistantCount: 0 }),
        'running',
    );
});

test('BWAI-TABINSPECT-003: classifyTabState — completed when send/prompt ready or assistants exist', () => {
    assert.equal(classifyTabState({ authenticated: true, stopExists: false, sendExists: true, promptReady: false, assistantCount: 0 }), 'completed');
    assert.equal(classifyTabState({ authenticated: true, stopExists: false, sendExists: false, promptReady: true, assistantCount: 0 }), 'completed');
    assert.equal(classifyTabState({ authenticated: true, stopExists: false, sendExists: false, promptReady: false, assistantCount: 2 }), 'completed');
});

test('BWAI-TABINSPECT-004: classifyTabState — detached when authed but idle/empty', () => {
    assert.equal(
        classifyTabState({ authenticated: true, stopExists: false, sendExists: false, promptReady: false, assistantCount: 0 }),
        'detached',
    );
});

test('BWAI-TABINSPECT-005: buildTabSummary maps + classifies + carries meta', () => {
    const s = buildTabSummary('T1', {
        authenticated: true,
        stopExists: true,
        assistantCount: 3,
        lastAssistantText: 'hello world',
        modelLabel: 'GPT-5',
        conversationId: 'abc',
        fingerprint: '3:11',
    }, { title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' });
    assert.equal(s.targetId, 'T1');
    assert.equal(s.state, 'running');
    assert.equal(s.vendor, 'chatgpt');
    assert.equal(s.modelLabel, 'GPT-5');
    assert.equal(s.assistantCount, 3);
    assert.equal(s.title, 'ChatGPT');
    assert.equal(s.url, 'https://chatgpt.com/c/abc');
    assert.equal(s.conversationId, 'abc');
});

test('BWAI-TABINSPECT-006: buildTabSummary defaults a missing/empty payload to detached', () => {
    const s = buildTabSummary('T2', {});
    assert.equal(s.state, 'detached');
    assert.equal(s.authenticated, false);
    assert.equal(s.assistantCount, 0);
    assert.equal(s.modelLabel, null);
    assert.equal(s.lastAssistantText, null);
});

test('BWAI-TABINSPECT-007: INSPECT_EXPRESSION probes the canonical ChatGPT selectors', () => {
    assert.match(INSPECT_EXPRESSION, /data-message-author-role="assistant"/);
    assert.match(INSPECT_EXPRESSION, /stop-button/);
    assert.match(INSPECT_EXPRESSION, /profile-button/);
    assert.match(INSPECT_EXPRESSION, /fingerprint/);
});
