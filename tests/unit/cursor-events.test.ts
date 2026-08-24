import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromEvent, extractOutputChunk, extractSessionId } from '../../src/agent/events/index.ts';
import type { SpawnContext } from '../../src/types/agent.ts';

function makeContext(): SpawnContext {
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

test('Cursor events capture session, model, assistant output, and usage', () => {
    const ctx = makeContext();
    const system = {
        type: 'system',
        subtype: 'init',
        session_id: 'cursor-session-1',
        model: 'GPT-5.5 272K Medium',
        permissionMode: 'default',
    };
    assert.equal(extractSessionId('cursor', system), 'cursor-session-1');
    extractFromEvent('cursor', system, ctx, 'cursor');
    assert.equal(ctx.sessionId, 'cursor-session-1');
    assert.equal(ctx.model, 'GPT-5.5 272K Medium');

    const assistant = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'cursor answer' }] },
    };
    extractFromEvent('cursor', assistant, ctx, 'cursor');
    assert.equal(extractOutputChunk('cursor', assistant, ctx), 'cursor answer');
    assert.equal(ctx.fullText, 'cursor answer');

    extractFromEvent('cursor', {
        type: 'result',
        subtype: 'success',
        session_id: 'cursor-session-1',
        usage: {
            inputTokens: 10,
            outputTokens: 3,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
        },
    }, ctx, 'cursor');
    assert.deepEqual(ctx.tokens, {
        input_tokens: 10,
        output_tokens: 3,
        cached_read: 2,
        cached_write: 1,
    });
});

test('Cursor assistant snapshots are deduped after deltas', () => {
    const ctx = makeContext();
    extractFromEvent('cursor', { type: 'assistant', subtype: 'delta', text: 'cursor' }, ctx, 'cursor');
    assert.equal(extractOutputChunk('cursor', { type: 'assistant' }, ctx), 'cursor');
    extractFromEvent('cursor', { type: 'assistant', subtype: 'delta', text: '-ok' }, ctx, 'cursor');
    assert.equal(extractOutputChunk('cursor', { type: 'assistant' }, ctx), '-ok');
    extractFromEvent('cursor', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'cursor-ok' }] },
    }, ctx, 'cursor');
    assert.equal(extractOutputChunk('cursor', { type: 'assistant' }, ctx), '');
});

test('Cursor assistant text normalizes escaped newlines for display and snapshot dedupe', () => {
    const ctx = makeContext();
    extractFromEvent('cursor', { type: 'assistant', subtype: 'delta', text: 'line 1\\n' }, ctx, 'cursor');
    assert.equal(extractOutputChunk('cursor', { type: 'assistant' }, ctx), 'line 1\n');
    extractFromEvent('cursor', { type: 'assistant', subtype: 'delta', text: 'line 2' }, ctx, 'cursor');
    assert.equal(extractOutputChunk('cursor', { type: 'assistant' }, ctx), 'line 2');
    extractFromEvent('cursor', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'line 1\\nline 2' }] },
    }, ctx, 'cursor');
    assert.equal(extractOutputChunk('cursor', { type: 'assistant' }, ctx), '');
    assert.equal(ctx.fullText, 'line 1\nline 2');
});

test('Cursor result fallback normalizes escaped newlines', () => {
    const ctx = makeContext();
    extractFromEvent('cursor', { type: 'result', subtype: 'success', result: 'done\\nnext' }, ctx, 'cursor');
    assert.equal(extractOutputChunk('cursor', { type: 'result' }, ctx), 'done\nnext');
    assert.equal(ctx.fullText, 'done\nnext');
});

test('Cursor narration before a tool call is discarded: post-last-tool text wins fullText', () => {
    // The Slack join bug: "회사 기록과 ... 확인한 뒤 ... 남기겠습니다. - <답변>"
    // was planning narration + "\n- " + answer in one message. Assistant text
    // that precedes a NEW tool_call is narration and must not survive into the
    // durable answer; the live stream still carries it.
    const ctx = makeContext();
    extractFromEvent('cursor', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '경계를 먼저 확인한 뒤 답하겠습니다.' }] },
    }, ctx, 'cursor');
    assert.equal(extractOutputChunk('cursor', { type: 'assistant' }, ctx), '경계를 먼저 확인한 뒤 답하겠습니다.', 'live stream keeps narration');
    extractFromEvent('cursor', {
        type: 'tool_call', subtype: 'started', call_id: 'c1', name: 'shell', input: { command: 'ls' },
    }, ctx, 'cursor');
    extractFromEvent('cursor', {
        type: 'tool_call', subtype: 'success', call_id: 'c1', name: 'shell', input: { command: 'ls' },
    }, ctx, 'cursor');
    extractFromEvent('cursor', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '최종 답변입니다.' }] },
    }, ctx, 'cursor');
    assert.equal(ctx.fullText, '최종 답변입니다.', 'durable answer contains no pre-tool narration and no \n- join');
});

test('Cursor multi-part answer after the LAST tool call is preserved intact', () => {
    // Guard from the audit: answer-part-1 → (no new tool) → answer-part-2 must
    // not be truncated by last-wins. Only a NEW tool start discards.
    const ctx = makeContext();
    extractFromEvent('cursor', {
        type: 'tool_call', subtype: 'started', call_id: 'c1', name: 'shell', input: { command: 'ls' },
    }, ctx, 'cursor');
    extractFromEvent('cursor', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '결과 요약:' }] },
    }, ctx, 'cursor');
    extractFromEvent('cursor', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '결과 요약:\n1) 완료' }] },
    }, ctx, 'cursor');
    assert.equal(ctx.fullText, '결과 요약:\n1) 완료', 'snapshot growth after the last tool accumulates normally');
    // A late tool COMPLETION update (not a new tool start) must not wipe the answer.
    extractFromEvent('cursor', {
        type: 'tool_call', subtype: 'success', call_id: 'c1', name: 'shell', input: { command: 'ls' },
    }, ctx, 'cursor');
    assert.equal(ctx.fullText, '결과 요약:\n1) 완료');
});

test('Cursor result fallback still applies after pre-tool narration was discarded', () => {
    const ctx = makeContext();
    extractFromEvent('cursor', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '확인해볼게요.' }] },
    }, ctx, 'cursor');
    extractFromEvent('cursor', {
        type: 'tool_call', subtype: 'started', call_id: 'c1', name: 'shell', input: { command: 'ls' },
    }, ctx, 'cursor');
    // No assistant text after the tool; the result event carries the answer.
    extractFromEvent('cursor', { type: 'result', subtype: 'success', result: '최종 결과' }, ctx, 'cursor');
    assert.equal(ctx.fullText, '최종 결과', 'result fallback fills the empty durable slot');
});

test('Cursor tool calls update running entries to done', () => {
    const ctx = makeContext();
    extractFromEvent('cursor', {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call-1',
        name: 'shell',
        input: { command: 'pwd' },
    }, ctx, 'cursor');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0]?.stepRef, 'cursor:tool:call-1');
    assert.equal(ctx.toolLog[0]?.status, 'running');

    extractFromEvent('cursor', {
        type: 'tool_call',
        subtype: 'success',
        call_id: 'call-1',
        name: 'shell',
        input: { command: 'pwd' },
    }, ctx, 'cursor');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0]?.status, 'done');
});

test('Cursor nested stream-json tool_call labels Read/Shell with args', () => {
    const ctx = makeContext();
    extractFromEvent('cursor', {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool-read-1',
        tool_call: {
            readToolCall: {
                args: { path: '/etc/hosts' },
            },
        },
    }, ctx, 'cursor');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0]?.label, 'Read');
    assert.equal(ctx.toolLog[0]?.detail, '/etc/hosts');
    assert.equal(ctx.toolLog[0]?.status, 'running');

    extractFromEvent('cursor', {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tool-read-1',
        tool_call: {
            readToolCall: {
                args: { path: '/etc/hosts' },
                result: { success: { path: '/etc/hosts' } },
            },
        },
    }, ctx, 'cursor');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0]?.label, 'Read');
    assert.equal(ctx.toolLog[0]?.status, 'done');

    extractFromEvent('cursor', {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool-shell-1',
        tool_call: {
            shellToolCall: {
                args: { command: 'pwd', description: 'Print current working directory' },
            },
        },
    }, ctx, 'cursor');
    assert.equal(ctx.toolLog.length, 2);
    assert.equal(ctx.toolLog[1]?.label, 'Bash');
    assert.equal(ctx.toolLog[1]?.detail, 'pwd');

    extractFromEvent('cursor', {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tool-shell-1',
        tool_call: {
            shellToolCall: {
                result: { rejected: { command: 'pwd', reason: '' } },
            },
        },
    }, ctx, 'cursor');
    assert.equal(ctx.toolLog.length, 2);
    assert.equal(ctx.toolLog[1]?.status, 'error');
});
