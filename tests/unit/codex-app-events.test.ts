import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractFromCodexAppEvent,
    extractFromCodexAppLaneEvent,
} from '../../src/agent/codex-app-events.ts';

function createCtx() {
    return {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false,
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
    };
}

test('codex-app captures raw reasoning text deltas', () => {
    const result = extractFromCodexAppEvent(
        'item/reasoning/textDelta',
        { delta: 'raw reasoning chunk' },
        createCtx(),
    );

    assert.equal(result?.tool?.toolType, 'thinking');
    assert.equal(result?.tool?.detail, 'raw reasoning chunk');
});

test('codex-app does not emit empty reasoning placeholder on item start', () => {
    const result = extractFromCodexAppEvent(
        'item/started',
        {
            item: {
                type: 'reasoning',
                id: 'rs_empty',
                summary: [],
                content: [],
            },
        },
        createCtx(),
    );

    assert.equal(result, null);
});

test('codex-app reads object-shaped reasoning summaries on item start', () => {
    const result = extractFromCodexAppEvent(
        'item/started',
        {
            item: {
                type: 'reasoning',
                id: 'rs_obj',
                summary: [{ type: 'summary_text', text: 'object summary' }],
                content: [],
            },
        },
        createCtx(),
    );

    assert.equal(result?.tool?.toolType, 'thinking');
    assert.equal(result?.tool?.detail, 'object summary');
});

test('codex-app falls back to completed reasoning content when no deltas streamed', () => {
    const result = extractFromCodexAppEvent(
        'item/completed',
        {
            item: {
                type: 'reasoning',
                id: 'rs_1',
                summary: ['summary reasoning'],
                content: ['raw reasoning'],
            },
        },
        createCtx(),
    );

    assert.equal(result?.flushThinking, true);
    assert.equal(result?.tool?.toolType, 'thinking');
    assert.equal(result?.tool?.detail, 'raw reasoning');
    assert.equal(result?.tool?.status, 'done');
});

test('codex-app falls back to completed object-shaped reasoning content', () => {
    const result = extractFromCodexAppEvent(
        'item/completed',
        {
            item: {
                type: 'reasoning',
                id: 'rs_1',
                summary: [{ type: 'summary_text', text: 'object summary' }],
                content: [{ type: 'reasoning_text', text: 'object raw reasoning' }],
            },
        },
        createCtx(),
    );

    assert.equal(result?.flushThinking, true);
    assert.equal(result?.tool?.toolType, 'thinking');
    assert.equal(result?.tool?.detail, 'object raw reasoning');
});

test('codex-app completed reasoning does not duplicate streamed buffer', () => {
    const ctx = createCtx();
    ctx.thinkingBuf = 'already streamed';

    const result = extractFromCodexAppEvent(
        'item/completed',
        {
            item: {
                type: 'reasoning',
                id: 'rs_1',
                summary: ['summary reasoning'],
                content: ['raw reasoning'],
            },
        },
        ctx,
    );

    assert.equal(result?.flushThinking, true);
    assert.equal(result?.tool, undefined);
});

test('codex-app lane normalizer rejects another thread before mutating context', () => {
    const ctx = createCtx();
    const result = extractFromCodexAppLaneEvent(
        'turn/started',
        { threadId: 'thread-b', turn: { id: 'turn-b' } },
        ctx,
        'thread-a',
        'turn-a',
    );

    assert.equal(result, null);
    assert.equal(ctx.sessionId, null);
    assert.equal(ctx.tokens, null);
});

test('codex-app lane normalizer rejects stale turn deltas without context mutation', () => {
    const cases = [
        ['item/agentMessage/delta', { delta: 'late text' }],
        ['item/reasoning/textDelta', { delta: 'late thought' }],
        ['thread/tokenUsage/updated', {
            tokenUsage: { last: { inputTokens: 3, outputTokens: 4 } },
        }],
    ] as const;

    for (const [method, payload] of cases) {
        const ctx = createCtx();
        ctx.sessionId = 'thread-a';
        ctx.thinkingBuf = 'current';
        const result = extractFromCodexAppLaneEvent(
            method,
            { threadId: 'thread-a', turnId: 'turn-a', ...payload },
            ctx,
            'thread-a',
            'turn-b',
        );
        assert.equal(result, null, method);
        assert.equal(ctx.sessionId, 'thread-a', method);
        assert.equal(ctx.thinkingBuf, 'current', method);
        assert.equal(ctx.tokens, null, method);
    }
});
