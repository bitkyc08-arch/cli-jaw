import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractFromEvent, extractOutputChunk } from '../../src/agent/events/index.ts';
import { flushOpenCodeBuffers } from '../../src/agent/events/opencode.ts';
import { FULLTEXT_MAX_CHARS } from '../../src/agent/events/fulltext-bound.ts';
import type { SpawnContext } from '../../src/types/agent.ts';
import type { PrintActivityProjection, PrintToolInput } from '../../src/agent/runtime/print-projection.ts';
import type { CliEventRecord } from '../../src/types/cli-events.ts';
import { startTraceRun, listToolEntriesForRun, getTraceEvent } from '../../src/trace/store.ts';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.ts';

function fixture(cli: string) {
    const observed = {
        nextMessage: mock.fn<PrintActivityProjection['nextMessage']>(),
        message: mock.fn<PrintActivityProjection['message']>(),
        reasoning: mock.fn<PrintActivityProjection['reasoning']>(),
        // Snapshot arguments: parsers mutate the same ToolEntry on completion.
        tool: mock.fn((entry: PrintToolInput) => ({ ...entry })),
        finish: mock.fn<PrintActivityProjection['finish']>(),
    } satisfies PrintActivityProjection;
    const ctx: SpawnContext = {
        fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set(),
        hasClaudeStreamEvents: false, sessionId: null, cost: null, turns: null,
        duration: null, tokens: null, stderrBuf: '', printActivity: observed,
        traceRunId: startTraceRun({ cli, audience: 'public' }),
    };
    return { ctx, observed, accept: (event: CliEventRecord) => extractFromEvent(cli, event, ctx, cli) };
}

const assistant = (id: string, text: string): CliEventRecord => ({
    type: 'assistant', message: { id, content: [{ type: 'text', text }] },
});
const stream = (type: string, text: string): CliEventRecord => ({
    type: 'stream_event', event: { type: 'content_block_delta', delta: {
        type, ...(type === 'thinking_delta' ? { thinking: text } : { text }),
    } },
});

test('Codex messages retain commentary before LAST-WINS and only explicit phases are final', () => {
    const { ctx, observed, accept } = fixture('codex');
    accept({ type: 'item.completed', item: { type: 'agent_message', text: 'Plan', channel: 'commentary' } });
    assert.equal(ctx.fullText, '');
    accept({ type: 'item.completed', item: { type: 'agent_message', text: 'Unknown' } });
    accept({ type: 'item.completed', item: { type: 'agent_message', text: 'Answer', channel: 'final' } });
    accept({ type: 'turn.completed', usage: { input_tokens: 1 } });
    assert.deepEqual(observed.message.mock.calls.map(c => c.arguments), [
        ['Plan', 'replace', 'commentary'], ['Unknown', 'replace', 'unknown'], ['Answer', 'replace', 'final'],
    ]);
    assert.equal(observed.nextMessage.mock.callCount(), 3);
    assert.equal(observed.tool.mock.callCount(), 0, 'narration cards must not double-observe');
    assert.equal(observed.finish.mock.callCount(), 0, 'only lifecycle owns finish');
    assert.equal(ctx.fullText, 'Answer');
});

test('plain Claude same-ID A/B append while changed-ID text starts a new message', () => {
    const { ctx, observed, accept } = fixture('claude');
    accept(assistant('m1', 'A'));
    accept(assistant('m1', 'B'));
    assert.equal(ctx.fullText, 'A\n- B', 'retain legacy segment formatting');
    assert.equal(observed.nextMessage.mock.callCount(), 0);
    accept(assistant('m2', 'Final'));
    assert.deepEqual(observed.message.mock.calls.map(c => c.arguments), [
        ['A', 'append', 'unknown'], ['B', 'append', 'unknown'], ['Final', 'append', 'unknown'],
    ]);
    assert.equal(observed.nextMessage.mock.callCount(), 1);
    assert.equal(ctx.fullText, 'Final');
});

test('Claude text deltas reconcile by replacement; the next stream message resets once', () => {
    const { ctx, observed, accept } = fixture('claude');
    accept(stream('text_delta', 'Hel'));
    accept(stream('text_delta', 'lo'));
    accept(assistant('m1', 'Hello'));
    assert.equal(ctx.fullText, 'Hello');
    assert.equal(extractOutputChunk('claude', {}, ctx), 'Hello');
    accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } });
    accept(stream('text_delta', 'Bye'));
    accept(assistant('m2', 'Bye'));
    assert.deepEqual(observed.message.mock.calls.map(c => c.arguments), [
        ['Hel', 'append', 'unknown'], ['lo', 'append', 'unknown'], ['Hello', 'replace', 'unknown'],
        ['Bye', 'append', 'unknown'], ['Bye', 'replace', 'unknown'],
    ]);
    assert.equal(observed.nextMessage.mock.callCount(), 1);
    assert.equal(ctx.fullText, 'Bye');
});

test('claude-e cumulative snapshots replace, reject duplicate/shorter snapshots and reset on ID change', () => {
    const { ctx, observed, accept } = fixture('claude-e');
    accept(assistant('m1', 'A'));
    accept(assistant('m1', 'AB'));
    accept(assistant('m1', 'AB'));
    accept(assistant('m1', 'A'));
    accept(assistant('m2', 'Answer'));
    assert.deepEqual(observed.message.mock.calls.map(c => c.arguments), [
        ['A', 'replace', 'unknown'], ['AB', 'replace', 'unknown'], ['Answer', 'replace', 'unknown'],
    ]);
    assert.equal(observed.nextMessage.mock.callCount(), 1);
    assert.equal(ctx.fullText, 'Answer');
});

test('Claude thinking deltas are observed once and synthetic flush cards add no tool observation', () => {
    const { observed, accept } = fixture('claude');
    accept({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } });
    accept(stream('thinking_delta', 'Think '));
    accept(stream('thinking_delta', 'carefully'));
    accept({ type: 'stream_event', event: { type: 'content_block_stop' } });
    assert.deepEqual(observed.reasoning.mock.calls.map(c => c.arguments), [['Think ', 'append'], ['carefully', 'append']]);
    assert.equal(observed.tool.mock.callCount(), 0);
});

test('complete Codex and nonstream Claude thinking observe accepted plaintext without duplicate tools', () => {
    const codex = fixture('codex');
    const reasoning = { type: 'item.completed', item: { type: 'reasoning', text: 'Consider this' } };
    codex.accept(reasoning);
    codex.accept(reasoning);
    assert.deepEqual(codex.observed.reasoning.mock.calls.map(c => c.arguments), [['Consider this', 'replace']]);
    assert.equal(codex.observed.tool.mock.callCount(), 0);
    const claude = fixture('claude');
    claude.accept({ type: 'assistant', message: { id: 'thought', content: [{ type: 'thinking', thinking: 'Consider that' }] } });
    assert.deepEqual(claude.observed.reasoning.mock.calls.map(c => c.arguments), [['Consider that', 'replace']]);
    assert.equal(claude.observed.tool.mock.callCount(), 0);
});

test('Cursor observes only accepted normalized segments and retains pre-tool narration', () => {
    const { ctx, observed, accept } = fixture('cursor');
    accept({ type: 'assistant', subtype: 'delta', text: 'Plan\\n' });
    accept({ type: 'assistant', subtype: 'delta', text: 'first' });
    accept(assistant('m1', 'Plan\\nfirst'));
    accept({ type: 'tool_call', subtype: 'started', call_id: 'c', name: 'shell' });
    accept(assistant('m1', 'Plan\\nfirst'));
    accept(assistant('m1', 'Plan\\nfirst done'));
    assert.deepEqual(observed.message.mock.calls.map(c => c.arguments), [
        ['Plan\n', 'append', 'unknown'], ['first', 'append', 'unknown'], [' done', 'append', 'unknown'],
    ]);
    assert.equal(observed.nextMessage.mock.callCount(), 1);
    assert.equal(ctx.fullText, ' done');
});

test('Cursor message-ID boundary preserves a shared prefix; result fallback remains unknown', () => {
    const { ctx, observed, accept } = fixture('cursor');
    accept(assistant('m1', 'Sum'));
    accept(assistant('m2', 'Summary'));
    assert.equal(observed.nextMessage.mock.callCount(), 1);
    assert.deepEqual(observed.message.mock.calls.map(c => c.arguments), [['Sum', 'append', 'unknown'], ['Summary', 'append', 'unknown']]);
    assert.equal(ctx.fullText, 'Summary');
    accept({ type: 'result', subtype: 'success', result: 'ignored' });
    assert.equal(observed.message.mock.callCount(), 2);
    const fallback = fixture('cursor');
    fallback.accept({ type: 'result', subtype: 'success', result: 'done\\nnext' });
    assert.deepEqual(fallback.observed.message.mock.calls[0]?.arguments, ['done\nnext', 'append', 'unknown']);
    assert.equal(fallback.observed.finish.mock.callCount(), 0);
});

test('Grok observes complete thought and text chunks before legacy bounds, without final inference', () => {
    const { ctx, observed, accept } = fixture('grok');
    const thought = 't'.repeat(102_401);
    ctx.fullText = 'x'.repeat(FULLTEXT_MAX_CHARS - 1);
    accept({ type: 'thought', data: thought });
    assert.equal(ctx.grokThoughtBuf?.length, 102_400);
    accept({ type: 'text', data: 'answer' });
    accept({ type: 'end', stopReason: 'done' });
    assert.deepEqual(observed.reasoning.mock.calls[0]?.arguments, [thought, 'append']);
    assert.deepEqual(observed.message.mock.calls[0]?.arguments, ['answer', 'append', 'unknown']);
    assert.equal(ctx.fullText.length, FULLTEXT_MAX_CHARS);
    assert.equal(ctx.fullTextTruncated, true);
    assert.equal(observed.tool.mock.callCount(), 0);
    assert.equal(observed.finish.mock.callCount(), 0);
});

test('OpenCode retains pre-tool text and reasoning before step discard and reset', () => {
    const { ctx, observed, accept } = fixture('opencode');
    accept({ type: 'step_start' });
    accept({ type: 'reasoning', part: { text: 'Reason' } });
    accept({ type: 'text', part: { text: 'Plan' } });
    accept({ type: 'tool_use', part: { tool: 'read', callID: 'c', state: { input: { path: '/tmp/a' } } } });
    accept({ type: 'step_finish', part: { reason: 'tool-calls' } });
    assert.equal(ctx.fullText, '');
    accept({ type: 'step_start' });
    accept({ type: 'text', part: { text: 'Answer' } });
    accept({ type: 'step_finish', part: { reason: 'stop' } });
    assert.equal(ctx.fullText, 'Answer');
    assert.deepEqual(observed.message.mock.calls.map(c => c.arguments), [['Plan', 'append', 'unknown'], ['Answer', 'append', 'unknown']]);
    assert.deepEqual(observed.reasoning.mock.calls.map(c => c.arguments), [['Reason', 'replace']]);
    assert.equal(observed.nextMessage.mock.callCount(), 2);
    assert.equal(observed.tool.mock.callCount(), 2, 'only the actual tool start and completion');
    assert.equal(observed.finish.mock.callCount(), 0);
});

for (const cli of ['cursor', 'grok', 'opencode']) {
    test(`${cli} running detail refresh and evicted completion update the same durable pointer once`, () => {
        const { ctx, observed, accept } = fixture(cli);
        const event = (detail: string, done = false): CliEventRecord => cli === 'cursor'
            ? { type: 'tool_call', subtype: done ? 'completed' : 'started', call_id: 'one', name: 'Read', input: { path: detail } }
            : cli === 'grok'
                ? { type: done ? 'tool_result' : 'tool_use', id: 'one', name: 'Read', input: { path: detail } }
                : { type: 'tool_use', part: { tool: 'Read', callID: 'one', state: { status: done ? 'completed' : 'running', input: { path: detail } } } };
        accept(event('/tmp/old'));
        const pointer = { traceRunId: ctx.toolLog[0]?.traceRunId, traceSeq: ctx.toolLog[0]?.traceSeq };
        assert.ok(pointer.traceRunId && pointer.traceSeq);
        accept(event('/tmp/new'));
        let rows = listToolEntriesForRun(ctx.traceRunId!);
        assert.equal(rows.length, 1);
        assert.equal(ctx.toolLog.length, 1);
        assert.equal(rows[0]?.detail, '/tmp/new', 'equal counts must still update detail');
        assert.equal(observed.tool.mock.callCount(), 2);
        if (cli !== 'grok') {
            accept(event('/tmp/new'));
            assert.equal(observed.tool.mock.callCount(), 2, 'existing dedupe still rejects exact replay');
        }
        ctx.toolLog.length = 0; // emulate the existing RAM cap, preserving stamp-time index
        accept(event('/tmp/final', true));
        rows = listToolEntriesForRun(ctx.traceRunId!);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.status, 'done');
        assert.equal(rows[0]?.detail, '/tmp/final');
        assert.equal(rows[0]?.traceSeq, pointer.traceSeq);
        assert.equal(observed.tool.mock.callCount(), 3);
        assert.equal(observed.tool.mock.calls[2]?.result?.traceSeq, pointer.traceSeq);
    });
}

test('Claude evicted completion observes after durable update without a new legacy broadcast', () => {
    const { ctx, observed, accept } = fixture('claude');
    accept({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'one', name: 'Read', input: { path: '/tmp/a' } }] } });
    const pointer = ctx.toolTraceIndex?.get('claude:tooluse:one');
    assert.ok(pointer);
    ctx.toolLog.length = 0;
    let legacyCalls = 0;
    const listener = (type: string) => { if (type === 'agent_tool') legacyCalls++; };
    observed.tool.mock.mockImplementation(entry => {
        const row = getTraceEvent(pointer.traceRunId, pointer.traceSeq);
        assert.equal(JSON.parse(row!.raw).status, 'done', 'durable update precedes observer');
        return { ...entry };
    });
    addBroadcastListener(listener);
    try {
        accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'complete' }] } });
    } finally { removeBroadcastListener(listener); }
    assert.equal(legacyCalls, 0);
    assert.equal(observed.tool.mock.callCount(), 2);
    assert.equal(observed.tool.mock.calls[1]?.result?.traceSeq, pointer.traceSeq);
    assert.equal(listToolEntriesForRun(ctx.traceRunId!).length, 1);
});

test('OpenCode pending-tool flush recovers an evicted pointer and does not re-complete it', () => {
    const { ctx, observed, accept } = fixture('opencode');
    accept({ type: 'step_start' });
    accept({ type: 'tool_use', part: { tool: 'Read', callID: 'pending', state: { input: { path: '/tmp/a' } } } });
    const seq = ctx.toolLog[0]?.traceSeq;
    ctx.toolLog.length = 0;
    flushOpenCodeBuffers(ctx, 'opencode');
    flushOpenCodeBuffers(ctx, 'opencode');
    const rows = listToolEntriesForRun(ctx.traceRunId!);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'done');
    assert.equal(rows[0]?.traceSeq, seq);
    assert.equal(observed.tool.mock.callCount(), 2);
});

test('Grok throttled thought detail and evicted thought completion converge durably', () => {
    const { ctx, observed, accept } = fixture('grok');
    accept({ type: 'thought', data: 'A' });
    ctx.grokLastThoughtEmitAt = Date.now() + 60_000;
    accept({ type: 'thought', data: 'B' });
    assert.equal(listToolEntriesForRun(ctx.traceRunId!)[0]?.detail, 'AB');
    ctx.toolLog.length = 0;
    accept({ type: 'end' });
    const rows = listToolEntriesForRun(ctx.traceRunId!);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'done');
    assert.equal(rows[0]?.detail, 'AB');
    assert.equal(observed.tool.mock.callCount(), 0);
});

for (const cli of ['cursor', 'grok', 'opencode']) {
    test(`${cli} same-label calls keep distinct pointers through running eviction and error completion`, () => {
        const { ctx, observed, accept } = fixture(cli);
        const event = (id: string, detail: string, failed = false): CliEventRecord => cli === 'cursor'
            ? { type: 'tool_call', subtype: failed ? 'error' : 'started', call_id: id, name: 'Read', input: { path: detail } }
            : cli === 'grok'
                ? { type: failed ? 'tool_result' : 'tool_use', id, name: 'Read', input: { path: detail }, ...(failed ? { is_error: true } : {}) }
                : { type: 'tool_use', part: { tool: 'Read', callID: id, state: { status: failed ? 'error' : 'running', input: { path: detail } } } };
        accept(event('first', '/tmp/first'));
        accept(event('second', '/tmp/second'));
        const firstSeq = ctx.toolLog[0]?.traceSeq;
        const secondSeq = ctx.toolLog[1]?.traceSeq;
        assert.notEqual(firstSeq, secondSeq);
        ctx.toolLog.length = 0;
        accept(event('first', '/tmp/refreshed'));
        assert.equal(listToolEntriesForRun(ctx.traceRunId!)[0]?.detail, '/tmp/refreshed');
        ctx.toolLog.length = 0;
        accept(event('second', '/tmp/failed', true));
        const rows = listToolEntriesForRun(ctx.traceRunId!);
        assert.equal(rows.length, 2, 'a label is never a new identity index');
        assert.equal(rows[0]?.traceSeq, firstSeq);
        assert.equal(rows[1]?.traceSeq, secondSeq);
        assert.equal(rows[1]?.status, 'error');
        assert.equal(rows[1]?.detail, '/tmp/failed');
        assert.equal(observed.tool.mock.callCount(), 4);
    });
}

for (const cli of ['cursor', 'grok', 'opencode']) {
    for (const status of ['done', 'error'] as const) {
        for (const evicted of [false, true]) {
            test(`${cli} start(old) -> ${status}(final) -> start(old) preserves terminal ${evicted ? 'after eviction' : 'in RAM'}`, () => {
                const { ctx, observed, accept } = fixture(cli);
                const event = (detail: string, terminal = false): CliEventRecord => cli === 'cursor'
                    ? { type: 'tool_call', subtype: terminal ? (status === 'done' ? 'completed' : 'error') : 'started',
                        call_id: 'stale', name: 'Read', input: { path: detail } }
                    : cli === 'grok'
                        ? { type: terminal ? 'tool_result' : 'tool_use', id: 'stale', name: 'Read',
                            input: { path: detail }, ...(terminal && status === 'error' ? { is_error: true } : {}) }
                        : { type: 'tool_use', part: { tool: 'Read', callID: 'stale', state: {
                            status: terminal ? (status === 'done' ? 'completed' : 'error') : 'running', input: { path: detail },
                        } } };
                accept(event('/tmp/old'));
                accept(event('/tmp/final', true));
                const terminalRows = listToolEntriesForRun(ctx.traceRunId!);
                assert.equal(terminalRows.length, 1);
                assert.equal(terminalRows[0]?.status, status);
                assert.equal(terminalRows[0]?.detail, '/tmp/final');
                if (evicted) ctx.toolLog.length = 0;
                const terminalRam = ctx.toolLog.map(entry => ({ ...entry }));
                accept(event('/tmp/old'));
                assert.deepEqual(listToolEntriesForRun(ctx.traceRunId!), terminalRows, 'stale start must not write durable state');
                assert.deepEqual(ctx.toolLog, terminalRam, 'stale start must not mutate or repopulate RAM');
                assert.equal(observed.tool.mock.callCount(), 2, 'stale start must not reach the observer');
                // A newer terminal detail remains admissible; the guard is not a blanket freeze.
                accept(event('/tmp/final-updated', true));
                const updated = listToolEntriesForRun(ctx.traceRunId!);
                assert.equal(updated.length, 1);
                assert.equal(updated[0]?.status, status);
                assert.equal(updated[0]?.detail, '/tmp/final-updated');
                assert.equal(updated[0]?.traceSeq, terminalRows[0]?.traceSeq);
                assert.equal(observed.tool.mock.callCount(), 3);
            });
        }
    }
}

for (const evicted of [false, true]) {
    test(`Cursor done -> answer -> stale start preserves answer and message boundary ${evicted ? 'after eviction' : 'in RAM'}`, () => {
        const { ctx, observed, accept } = fixture('cursor');
        const start: CliEventRecord = { type: 'tool_call', subtype: 'started', call_id: 'old', name: 'Read', input: { path: '/tmp/old' } };
        accept(start);
        accept({ ...start, subtype: 'completed', input: { path: '/tmp/final' } });
        accept(assistant('answer', 'Final answer'));
        assert.equal(ctx.fullText, 'Final answer');
        const answer = {
            fullText: ctx.fullText, outputTextStarted: ctx.outputTextStarted,
            pendingOutputChunk: ctx.pendingOutputChunk,
            cursorAssistantText: ctx.cursorAssistantText, cursorAssistantMessageId: ctx.cursorAssistantMessageId,
        };
        const boundaries = observed.nextMessage.mock.callCount();
        const messages = observed.message.mock.calls.map(c => c.arguments);
        const terminalRows = listToolEntriesForRun(ctx.traceRunId!);
        if (evicted) ctx.toolLog.length = 0;
        const terminalRam = ctx.toolLog.map(entry => ({ ...entry }));
        accept(start);
        assert.equal(ctx.fullText, 'Final answer', 'stale start must not erase the legacy answer');
        assert.deepEqual({
            fullText: ctx.fullText, outputTextStarted: ctx.outputTextStarted,
            pendingOutputChunk: ctx.pendingOutputChunk,
            cursorAssistantText: ctx.cursorAssistantText, cursorAssistantMessageId: ctx.cursorAssistantMessageId,
        }, answer);
        assert.equal(observed.nextMessage.mock.callCount(), boundaries, 'current print message must not advance');
        assert.deepEqual(observed.message.mock.calls.map(c => c.arguments), messages);
        assert.deepEqual(ctx.toolLog, terminalRam);
        assert.deepEqual(listToolEntriesForRun(ctx.traceRunId!), terminalRows);
        assert.equal(observed.tool.mock.callCount(), 2);
        // A genuinely new tool still clears preceding text and advances the message.
        accept({ ...start, call_id: 'new' });
        assert.equal(ctx.fullText, '');
        assert.equal(ctx.outputTextStarted, false);
        assert.equal(ctx.cursorAssistantText, 'Final answer', 'keep the cumulative dedupe baseline');
        assert.equal(observed.nextMessage.mock.callCount(), boundaries + 1);
        assert.equal(observed.tool.mock.callCount(), 3);
        assert.equal(listToolEntriesForRun(ctx.traceRunId!).length, 2);
    });
}

for (const cli of ['cursor', 'grok', 'opencode', 'claude']) {
    test(`${cli} spilled tool read failure cannot escape completion or erase the legacy answer`, () => {
        const { ctx, observed, accept } = fixture(cli);
        const detail = '/tmp/' + 'x'.repeat(96_001);
        const start: CliEventRecord = cli === 'cursor'
            ? { type: 'tool_call', subtype: 'started', call_id: 'spill', name: 'Read', input: { path: detail } }
            : cli === 'grok'
                ? { type: 'tool_use', id: 'spill', name: 'Read', input: { path: detail } }
                : cli === 'opencode'
                    ? { type: 'tool_use', part: { tool: 'Read', callID: 'spill', state: { input: { path: detail } } } }
                    : { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'spill', name: 'Read', input: { path: detail } }] } };
        accept(start);
        const pointer = { traceRunId: ctx.toolLog[0]?.traceRunId, traceSeq: ctx.toolLog[0]?.traceSeq };
        assert.ok(pointer.traceRunId && pointer.traceSeq);
        assert.ok(getTraceEvent(pointer.traceRunId, pointer.traceSeq)?.raw_path, 'exercise a real spilled row');
        ctx.toolLog.length = 0;
        ctx.fullText = 'Existing legacy answer';
        const complete: CliEventRecord = cli === 'cursor'
            ? { ...start, subtype: 'completed', input: { path: '/tmp/final' } }
            : cli === 'grok'
                ? { type: 'tool_result', id: 'spill', name: 'Read', input: { path: '/tmp/final' } }
                : cli === 'opencode'
                    ? { type: 'tool_use', part: { tool: 'Read', callID: 'spill', state: { status: 'completed', input: { path: '/tmp/final' } } } }
                    : { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'spill', content: '/tmp/final' }] } };
        const brokenRead = mock.method(fs, 'readFileSync', () => { throw new Error('injected spill read failure'); });
        try {
            assert.doesNotThrow(() => accept(complete));
            assert.equal(brokenRead.mock.callCount(), 1, 'parser attempted the failing spill read');
        } finally { brokenRead.mock.restore(); }
        const rows = listToolEntriesForRun(ctx.traceRunId!);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.traceSeq, pointer.traceSeq);
        assert.equal(rows[0]?.status, 'done');
        assert.equal(rows[0]?.detail, '/tmp/final', 'accepted payload supplies terminal detail without recovered raw');
        assert.equal(ctx.fullText, 'Existing legacy answer');
        assert.equal(observed.tool.mock.callCount(), 2);
        assert.equal(observed.tool.mock.calls[1]?.result?.status, 'done');
        assert.equal(observed.tool.mock.calls[1]?.result?.stepRef, observed.tool.mock.calls[0]?.result?.stepRef,
            'unreadable raw storage must not split one observed tool identity');
    });
}
