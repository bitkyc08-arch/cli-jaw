import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppClient } from '../../src/agent/codex-app-client.ts';
import {
    applyCodexAppTextEvent,
    extractFromCodexAppLaneEvent,
    listenCodexAppTurnAdapter,
} from '../../src/agent/codex-app-events.ts';
import { appendAssistantRawText } from '../../src/agent/events/helpers.ts';
import type { SpawnContext } from '../../src/types/agent.ts';

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
        thinkingBuf: '',
    };
}

function extractLane(
    method: string,
    params: Record<string, unknown>,
    ctx: ReturnType<typeof createCtx>,
) {
    return extractFromCodexAppLaneEvent(
        method,
        { threadId: 'thread-a', turnId: 'turn-a', ...params },
        ctx,
        'thread-a',
        'turn-a',
    );
}

test('codex-app agent message deltas append raw without markdown bullets', () => {
    const ctx = createCtx() as unknown as SpawnContext;
    for (const delta of ['이', '지만, 실제 트', '리']) {
        const result = extractLane('item/agentMessage/delta', { delta }, ctx as unknown as ReturnType<typeof createCtx>);
        assert.equal(appendAssistantRawText(ctx, result?.text || ''), delta);
    }

    // Token deltas must accumulate verbatim — the segment formatter would have
    // produced '이\n- 지만, 실제 트\n- 리'.
    assert.equal(ctx.fullText, '이지만, 실제 트리');
    // Completed agentMessage returns null: streamed deltas are the only text
    // source, so raw-append cannot double-count.
    assert.equal(extractLane('item/completed', {
        item: { type: 'agentMessage', id: 'msg_1' },
    }, ctx as unknown as ReturnType<typeof createCtx>), null);
});

// ─── durable-vs-live decision (applyCodexAppTextEvent) ───────────────────────
//
// These drive the real notification sequence the app-server emits. The decision
// used to live inline in spawn.ts, where the only thing a test could do was regex
// the source; the leak it was supposed to prevent went unnoticed for exactly that
// reason. Slack/Telegram/Discord receive text derived from ctx.fullText, so
// 'durable' is the external answer and 'live' is web-UI-only.

/** Drive one item/started + its deltas through the lane extractor and reducer. */
function feedMessage(
    ctx: SpawnContext,
    itemId: string,
    deltas: string[],
    item: Record<string, unknown> = {},
): string {
    const started = extractLane('item/started', {
        item: { type: 'agentMessage', id: itemId, ...item },
    }, ctx as unknown as ReturnType<typeof createCtx>);
    if (started) applyCodexAppTextEvent(ctx, started);
    let live = '';
    for (const delta of deltas) {
        const parsed = extractLane('item/agentMessage/delta', { delta, itemId },
            ctx as unknown as ReturnType<typeof createCtx>);
        if (!parsed) continue;
        const decision = applyCodexAppTextEvent(ctx, parsed);
        if (decision.durable) appendAssistantRawText(ctx, decision.durable);
        live += decision.live;
    }
    return live;
}

test('codex-app phase=commentary text is live-only and never reaches the durable answer', () => {
    const ctx = createCtx() as unknown as SpawnContext;
    const live = feedMessage(ctx, 'msg_1', ['확인하', '겠습니다.'], { phase: 'commentary' });
    assert.equal(live, '확인하겠습니다.', 'live UI still streams the narration');
    assert.equal(ctx.fullText, '', 'commentary never becomes the external answer');
});

test('codex-app commentary then final_answer delivers only the answer', () => {
    const ctx = createCtx() as unknown as SpawnContext;
    feedMessage(ctx, 'msg_1', ['요청은 반복 작업 설정으로 처리하겠습니다.'], { phase: 'commentary' });
    feedMessage(ctx, 'msg_2', ['설정했습니다.'], { phase: 'final_answer' });
    assert.equal(ctx.fullText, '설정했습니다.');
});

test('codex-app untagged agentMessage items are LAST-WINS', () => {
    // The observed Slack artifact: three narration items and the answer arrived as
    // separate untagged messages and were concatenated into one run-on paragraph.
    const ctx = createCtx() as unknown as SpawnContext;
    feedMessage(ctx, 'msg_1', ['요청은 반복 작업 설정으로 처리하겠습니다.']);
    feedMessage(ctx, 'msg_2', ['현재 heartbeat에는 9시 점검만 있습니다.']);
    feedMessage(ctx, 'msg_3', ['설정했습니다.']);
    assert.equal(ctx.fullText, '설정했습니다.', 'only the last untagged message survives');
});

test('codex-app consecutive final_answer items accumulate instead of replacing', () => {
    const ctx = createCtx() as unknown as SpawnContext;
    feedMessage(ctx, 'msg_1', ['결과 요약:'], { phase: 'final_answer' });
    feedMessage(ctx, 'msg_2', ['\n1) 완료'], { phase: 'final_answer' });
    assert.equal(ctx.fullText, '결과 요약:\n1) 완료', 'a multi-item answer is not truncated');
});

test('codex-app trailing commentary does not erase a delivered final answer', () => {
    const ctx = createCtx() as unknown as SpawnContext;
    feedMessage(ctx, 'msg_1', ['설정했습니다.'], { phase: 'final_answer' });
    const live = feedMessage(ctx, 'msg_2', ['이어서 정리하겠습니다.'], { phase: 'commentary' });
    assert.equal(live, '이어서 정리하겠습니다.');
    assert.equal(ctx.fullText, '설정했습니다.', 'the answer is protected by its final provenance');
});

test('codex-app trailing untagged item does not erase a delivered final answer', () => {
    const ctx = createCtx() as unknown as SpawnContext;
    feedMessage(ctx, 'msg_1', ['설정했습니다.'], { phase: 'final_answer' });
    feedMessage(ctx, 'msg_2', ['(추가 메모)']);
    assert.equal(ctx.fullText, '설정했습니다.(추가 메모)', 'protected text accumulates, never resets');
});

test('codex-app detects a message boundary from a changed delta itemId alone', () => {
    // item/started can be dropped or buffered; item/completed returns null for
    // agentMessage, so the delta's itemId is the only remaining seam.
    const ctx = createCtx() as unknown as SpawnContext;
    for (const [itemId, delta] of [['msg_1', '먼저 확인하겠습니다.'], ['msg_2', '완료했습니다.']] as const) {
        const parsed = extractLane('item/agentMessage/delta', { delta, itemId },
            ctx as unknown as ReturnType<typeof createCtx>);
        const decision = applyCodexAppTextEvent(ctx, parsed!);
        if (decision.durable) appendAssistantRawText(ctx, decision.durable);
    }
    assert.equal(ctx.fullText, '완료했습니다.');
});

test('codex-app clears a stale commentary tag when item/started is missing', () => {
    // Without the reset, msg_2 would inherit msg_1's 'commentary' and the real
    // answer would go to the live stream only — an empty Slack reply.
    const ctx = createCtx() as unknown as SpawnContext;
    feedMessage(ctx, 'msg_1', ['확인하겠습니다.'], { phase: 'commentary' });
    const parsed = extractLane('item/agentMessage/delta', { delta: '완료했습니다.', itemId: 'msg_2' },
        ctx as unknown as ReturnType<typeof createCtx>);
    const decision = applyCodexAppTextEvent(ctx, parsed!);
    if (decision.durable) appendAssistantRawText(ctx, decision.durable);
    assert.equal(ctx.fullText, '완료했습니다.');
});

test('codex-app still honours the legacy channel and annotations.channel tags', () => {
    const ctxChannel = createCtx() as unknown as SpawnContext;
    feedMessage(ctxChannel, 'msg_1', ['확인 중'], { channel: 'commentary' });
    assert.equal(ctxChannel.fullText, '');

    const ctxAnnotated = createCtx() as unknown as SpawnContext;
    feedMessage(ctxAnnotated, 'msg_1', ['확인 중'], { annotations: { channel: 'commentary' } });
    assert.equal(ctxAnnotated.fullText, '');
});

test('codex-app turn adapter wires the reducer to the raw appender end to end', async () => {
    // The reducer tests above call appendAssistantRawText themselves, so they would
    // stay green if the consumer stopped persisting decision.durable or switched to
    // the segmented appender (which injects "\n- " between token deltas). Drive the
    // real client + lane adapter instead of asserting on spawn.ts source text.
    const laneScope = 'main';
    const threadId = 'wire-thread';
    const turnId = 'wire-turn';
    const client = new CodexAppClient();
    Object.defineProperty(client, 'request', {
        value: async (method: string) => {
            if (method === 'thread/start') return { thread: { id: threadId } };
            if (method === 'turn/start') return { turn: { id: turnId } };
            return {};
        },
    });
    await client.startThread(laneScope, {
        model: 'gpt-5.5', effort: 'medium', cwd: '/tmp', fastMode: false,
    });
    await client.startTurn(laneScope, 'hello');

    const ctx = createCtx() as unknown as SpawnContext;
    const broadcasts: string[] = [];
    const listener = listenCodexAppTurnAdapter(client, { threadId }, laneScope, ctx, {
        onProgress: () => {},
        onRawNotification: () => {},
        onEvent: (_method, parsed) => {
            if (!parsed) return;
            const decision = applyCodexAppTextEvent(ctx, parsed);
            if (decision.durable) appendAssistantRawText(ctx, decision.durable);
            if (decision.live) broadcasts.push(decision.live);
        },
        onStderr: () => {},
    });

    const emit = (method: string, params: Record<string, unknown>) => {
        (client as unknown as { handleLine(line: string): void })
            .handleLine(JSON.stringify({ method, params: { threadId, turnId, ...params } }));
    };
    emit('item/started', { item: { type: 'agentMessage', id: 'm1', phase: 'commentary' } });
    emit('item/agentMessage/delta', { itemId: 'm1', delta: '확인하겠습니다.' });
    emit('item/started', { item: { type: 'agentMessage', id: 'm2', phase: 'final_answer' } });
    for (const delta of ['이', '지만, 완료']) emit('item/agentMessage/delta', { itemId: 'm2', delta });
    listener.dispose();

    // Raw append, not the segment formatter: '이' + '지만, 완료' must not become
    // '이\n- 지만, 완료'. Commentary never reaches the durable answer.
    assert.equal(ctx.fullText, '이지만, 완료');
    assert.deepEqual(broadcasts, ['확인하겠습니다.', '이', '지만, 완료']);
});

test('codex-app captures raw reasoning text deltas', () => {
    const result = extractLane(
        'item/reasoning/textDelta',
        { delta: 'raw reasoning chunk' },
        createCtx(),
    );

    assert.equal(result?.tool?.toolType, 'thinking');
    assert.equal(result?.tool?.detail, 'raw reasoning chunk');
});

test('codex-app does not emit empty reasoning placeholder on item start', () => {
    const result = extractLane(
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
    const result = extractLane(
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
    const result = extractLane(
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
    const result = extractLane(
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

    const result = extractLane(
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
