import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.ts';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.ts';
import { readTurnSegments } from '../../src/core/turn-segments.ts';
import { subscribe } from '../../src/core/event-bus.ts';
import {
    appendAssistantRawText,
    emitAgentTool,
    finishTurnLifecycle,
} from '../../src/agent/events/helpers.ts';
import type { TurnSegment } from '../../src/shared/chat-events.ts';
import type { SpawnContext } from '../../src/types/agent.ts';

function runtimeContext(runtimeCli: string, effectiveProvider?: string): SpawnContext {
    return {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set(),
        hasClaudeStreamEvents: false,
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
        runtimeCli,
        effectiveProvider,
        traceAudience: 'public',
    };
}

function captureTurn(run: (ctx: SpawnContext) => void, ctx: SpawnContext): TurnSegment[] {
    let turnId = '';
    const unsubscribe = subscribe(entry => {
        if (entry.topic !== 'agent' || !entry.event.startsWith('turn_')) return;
        turnId ||= String(entry.data['turnId'] || '');
    });
    try {
        run(ctx);
    } finally {
        unsubscribe();
    }
    assert.ok(turnId.startsWith('turn_'));
    const segments = readTurnSegments(turnId);
    db.prepare('DELETE FROM turn_segments WHERE turn_id = ?').run(turnId);
    return segments;
}

test('Full Claude turn stores completed thinking with explicit fidelity and clocks', () => {
    const providerAt = Date.now() - 5;
    const segments = captureTurn(ctx => {
        emitAgentTool(ctx, 'main', {
            icon: 'thinking',
            label: 'considering',
            detail: 'plaintext reasoning',
            toolType: 'thinking',
            providerAt,
        }, {});
        emitAgentTool(ctx, 'main', {
            icon: 'locked',
            label: 'encrypted thinking',
            detail: 'server-side reasoning, plaintext withheld',
            toolType: 'thinking',
        }, {});
        appendAssistantRawText(ctx, 'answer');
        finishTurnLifecycle(ctx, 'done');
    }, runtimeContext('claude'));

    assert.equal(segments.every(segment => segment.fidelity === 'full'), true);
    const thinking = segments.filter(segment => segment.type === 'thinking');
    assert.deepEqual(thinking.map(segment => segment.status), ['done', 'done']);
    assert.deepEqual(thinking.map(segment => segment.thinkingMarker), ['plaintext', 'encrypted']);
    assert.notEqual(thinking[0]?.segmentId, thinking[1]?.segmentId, 'completed entries without stable ids must not merge');
    assert.equal(thinking[0]?.providerAt, providerAt);
    assert.equal(thinking.every(segment => segment.observedAt >= providerAt), true);
});

test('Grok thinking bounds durable updates to first running and terminal rows', () => {
    const broadcasts: string[] = [];
    const listener = (type: string, data: Record<string, unknown>): void => {
        if (type === 'agent_tool' && data['toolType'] === 'thinking') {
            broadcasts.push(String(data['status'] || ''));
        }
    };
    addBroadcastListener(listener);
    let segments: TurnSegment[];
    try {
        segments = captureTurn(ctx => {
            for (const status of ['running', 'running', 'done'] as const) {
                emitAgentTool(ctx, 'main', {
                    icon: 'thinking',
                    label: 'Grok thinking',
                    detail: status,
                    toolType: 'thinking',
                    stepRef: 'grok:thinking:1',
                    status,
                }, {});
            }
            finishTurnLifecycle(ctx, 'done');
        }, runtimeContext('grok'));
    } finally {
        removeBroadcastListener(listener);
    }

    const thinking = segments.filter(segment => segment.type === 'thinking');
    assert.deepEqual(thinking.map(segment => segment.status), ['running', 'done']);
    assert.equal(new Set(thinking.map(segment => segment.segmentId)).size, 1);
    assert.deepEqual(thinking.map(segment => segment.turnSeq), [2, 3]);
    assert.deepEqual(thinking.map(segment => segment.thinkingMarker), ['streaming', 'plaintext']);
    assert.equal(segments.every(segment => segment.fidelity === 'full'), true);
    assert.deepEqual(broadcasts, ['running', 'running', 'done']);
});

test('Coarse Agy turn normalizes planner thinking and assistant text', () => {
    const segments = captureTurn(ctx => {
        emitAgentTool(ctx, 'main', {
            icon: 'thinking',
            label: 'planner',
            detail: 'observed transcript planner row',
            toolType: 'thinking',
        }, {});
        appendAssistantRawText(ctx, 'coarse answer');
        finishTurnLifecycle(ctx, 'done');
    }, runtimeContext('agy'));

    assert.equal(segments.every(segment => segment.fidelity === 'coarse'), true);
    assert.equal(segments.find(segment => segment.type === 'thinking')?.thinkingMarker, 'planner');
    assert.equal(segments.find(segment => segment.type === 'thinking')?.providerAt, null);
    assert.equal(segments.filter(segment => segment.type === 'assistant_text').length, 1);
});

test('Text-only Kiro turn is valid with exactly one content segment', () => {
    const segments = captureTurn(ctx => {
        appendAssistantRawText(ctx, 'text only');
        finishTurnLifecycle(ctx, 'done');
    }, runtimeContext('kiro-code'));

    assert.equal(segments.every(segment => segment.fidelity === 'text_only'), true);
    const content = segments.filter(segment => !segment.type.startsWith('turn_'));
    assert.deepEqual(content.map(segment => segment.type), ['assistant_text']);
    assert.equal(segments.some(segment => segment.type === 'thinking' || segment.type === 'tool'), false);
});

test('OpenCode mixed fidelity and ACP plan remain distinguishable thinking', () => {
    const plaintext = captureTurn(ctx => {
        emitAgentTool(ctx, 'main', {
            icon: 'thinking',
            label: 'reasoning',
            detail: 'plaintext OpenCode reasoning',
            toolType: 'thinking',
            status: 'done',
        }, {});
        finishTurnLifecycle(ctx, 'done');
    }, runtimeContext('opencode'));
    const opencode = captureTurn(ctx => {
        emitAgentTool(ctx, 'main', {
            icon: 'thinking',
            label: 'reasoning used: 42 tokens',
            detail: 'OpenCode did not emit plaintext reasoning content.',
            toolType: 'thinking',
            status: 'done',
        }, {});
        finishTurnLifecycle(ctx, 'done');
    }, runtimeContext('opencode'));
    const acp = captureTurn(ctx => {
        emitAgentTool(ctx, 'main', {
            icon: 'plan',
            label: 'planning...',
            toolType: 'thinking',
        }, {});
        finishTurnLifecycle(ctx, 'done');
    }, runtimeContext('copilot'));

    assert.equal(plaintext.every(segment => segment.fidelity === 'full'), true);
    assert.equal(plaintext.find(segment => segment.type === 'thinking')?.thinkingMarker, 'plaintext');
    assert.equal(opencode.every(segment => segment.fidelity === 'coarse'), true);
    assert.equal(opencode.find(segment => segment.type === 'thinking')?.thinkingMarker, 'token_fallback');
    assert.equal(acp.every(segment => segment.fidelity === 'full'), true);
    assert.equal(acp.find(segment => segment.type === 'thinking')?.thinkingMarker, 'plan');
});

test('ai-e inherits its effective provider fidelity tier', () => {
    const segments = captureTurn(ctx => {
        appendAssistantRawText(ctx, 'provider inherited');
        finishTurnLifecycle(ctx, 'done');
    }, runtimeContext('ai-e', 'kiro'));
    assert.equal(segments.every(segment => segment.fidelity === 'text_only'), true);
});
