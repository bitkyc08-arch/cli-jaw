import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    extractFromEvent,
    extractFromAcpUpdate,
    extractOutputChunk,
    extractSessionId,
    extractToolLabel,
    extractToolLabelsForTest,
    makeClaudeToolKeyForTest,
} from '../src/agent/events.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readFixture(name) {
    const fixturePath = path.join(__dirname, 'fixtures', name);
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function createClaudeCtx() {
    return { seenToolKeys: new Set(), hasClaudeStreamEvents: false };
}

test('claude stream_event tool labels are deduped', () => {
    const ctx = createClaudeCtx();
    const evt = readFixture('claude-stream-tool.json');

    const first = extractToolLabelsForTest('claude', evt, ctx);
    const second = extractToolLabelsForTest('claude', evt, ctx);

    assert.deepEqual(first, [{ icon: '🔧', label: 'Bash', toolType: 'tool', stepRef: undefined }]);
    assert.equal(second.length, 0);
    assert.equal(ctx.hasClaudeStreamEvents, true);
});

test('claude assistant fallback works when stream was not seen', () => {
    const ctx = createClaudeCtx();
    const evt = readFixture('claude-assistant-tool.json');

    const labels = extractToolLabelsForTest('claude', evt, ctx);
    assert.deepEqual(labels, [{ icon: '🔧', label: 'Read', toolType: 'tool', stepRef: undefined }]);
});

test('claude assistant blocks are ignored after stream event', () => {
    const ctx = createClaudeCtx();
    ctx.hasClaudeStreamEvents = true;
    const evt = readFixture('claude-assistant-tool.json');

    const labels = extractToolLabelsForTest('claude', evt, ctx);
    assert.equal(labels.length, 0);
});

test('claude system compact events emit compacting and boundary labels', () => {
    const ctx = createClaudeCtx();
    const compacting = extractToolLabelsForTest('claude', {
        type: 'system',
        status: 'compacting',
    }, ctx);
    const boundary = extractToolLabelsForTest('claude', {
        type: 'system',
        subtype: 'compact_boundary',
    }, ctx);

    assert.deepEqual(compacting, [{ icon: '🗜️', label: 'compacting...', toolType: 'tool' }]);
    assert.deepEqual(boundary, [{ icon: '✅', label: 'conversation compacted', toolType: 'tool', status: 'done' }]);
});

test('extractSessionId handles all supported CLIs', () => {
    assert.equal(extractSessionId('claude', { type: 'system', session_id: 'claude-1' }), 'claude-1');
    assert.equal(extractSessionId('codex', { type: 'thread.started', thread_id: 'thread-1' }), 'thread-1');
    assert.equal(extractSessionId('gemini', { type: 'init', session_id: 'gemini-1' }), 'gemini-1');
    assert.equal(extractSessionId('opencode', { sessionID: 'oc-1' }), 'oc-1');
    assert.equal(extractSessionId('unknown', { type: 'x' }), null);
});

test('tool label extraction fixture matrix covers codex, gemini, and opencode variants', () => {
    const fixtureCases = [
        {
            name: 'claude stream thinking (block_start — buffered, no immediate label)',
            cli: 'claude',
            fixture: 'claude-stream-thinking.json',
            expected: [],
        },
        {
            name: 'codex web search',
            cli: 'codex',
            fixture: 'codex-web-search.json',
            expected: [{ icon: '🔍', label: 'node test runner', toolType: 'search', detail: 'node test runner' }],
        },
        {
            name: 'codex open page',
            cli: 'codex',
            fixture: 'codex-open-page.json',
            expected: [{ icon: '🌐', label: 'example.com', toolType: 'search', detail: 'https://example.com/docs?q=1' }],
        },
        {
            name: 'codex open page invalid fallback',
            cli: 'codex',
            fixture: 'codex-open-page-invalid.json',
            expected: [{ icon: '🌐', label: 'page', toolType: 'search', detail: 'not a url' }],
        },
        {
            name: 'codex command execution',
            cli: 'codex',
            fixture: 'codex-command.json',
            expected: [{ icon: '⚡', label: 'npm run test:events', toolType: 'tool', detail: 'npm run test:events', stepRef: 'codex:item:npm run test:events', status: 'done' }],
        },
        {
            name: 'codex reasoning',
            cli: 'codex',
            fixture: 'codex-reasoning.json',
            expected: [{ icon: '💭', label: 'Plan isolate regression', toolType: 'thinking', detail: 'Plan isolate regression' }],
        },
        {
            name: 'gemini tool use',
            cli: 'gemini',
            fixture: 'gemini-tool-use.json',
            expected: [{ icon: '🔧', label: 'shell: npm run lint', toolType: 'tool', detail: 'npm run lint', stepRef: 'gemini:toolid:run_shell_command_123' }],
        },
        {
            name: 'gemini tool result success',
            cli: 'gemini',
            fixture: 'gemini-tool-result-success.json',
            expected: [{ icon: '✅', label: 'success', toolType: 'tool', stepRef: 'gemini:toolid:run_shell_command_123', status: 'done' }],
        },
        {
            name: 'gemini tool result error',
            cli: 'gemini',
            fixture: 'gemini-tool-result-error.json',
            expected: [{ icon: '❌', label: 'error', toolType: 'tool', stepRef: 'gemini:toolid:run_shell_command_123', status: 'error' }],
        },
        {
            name: 'opencode tool use',
            cli: 'opencode',
            fixture: 'opencode-tool-use.json',
            expected: [
                { icon: '✅', label: 'bash', toolType: 'tool', stepRef: 'opencode:call:call_function_abc', detail: 'pwd', status: 'done' },
            ],
        },
        {
            name: 'opencode tool result',
            cli: 'opencode',
            fixture: 'opencode-tool-result.json',
            expected: [{ icon: '✅', label: 'bash', toolType: 'tool', stepRef: 'opencode:call:call_function_abc', status: 'done' }],
        },
    ];

    for (const item of fixtureCases) {
        const ctx = item.cli === 'claude' ? createClaudeCtx() : {};
        const labels = extractToolLabelsForTest(item.cli, readFixture(item.fixture), ctx);
        assert.deepEqual(labels, item.expected, item.name);
    }
});

test('claude non-tool events do not emit labels', () => {
    const ctx = createClaudeCtx();
    const resultLabels = extractToolLabelsForTest('claude', readFixture('claude-result.json'), ctx);
    const errorLabels = extractToolLabelsForTest('claude', readFixture('claude-error.json'), ctx);
    assert.equal(resultLabels.length, 0);
    assert.equal(errorLabels.length, 0);
});

test('claude thinking_delta buffer is flushed on non-thinking event', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // Send thinking deltas — they should accumulate in buffer, not emit yet
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me think about ' } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 0, 'thinking delta should not emit immediately');

    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'this problem carefully.' } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 0, 'second delta should also buffer');

    // Non-thinking event (block_stop) should flush
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 1, 'flush should emit one tool label');
    assert.equal(ctx.toolLog[0].toolType, 'thinking');
    assert.equal(ctx.toolLog[0].icon, '💭');
    assert.ok(ctx.toolLog[0].label.includes('think about'), 'label should contain thinking content');
    assert.ok(ctx.toolLog[0].detail.includes('this problem carefully'), 'detail should contain full text');
});

test('codex reasoning keeps full detail while preview label stays short', () => {
    const longReasoning = {
        type: 'item.completed',
        item: {
            type: 'reasoning',
            text: '**Plan** isolate regression by checking websocket state hydration and replay handling before UI render',
        },
    };

    const [label] = extractToolLabelsForTest('codex', longReasoning, {});
    assert.equal(label.toolType, 'thinking');
    assert.ok(label.label.length <= 60, 'preview label should remain compact');
    assert.equal(label.detail, 'Plan isolate regression by checking websocket state hydration and replay handling before UI render');
});

test('claude input_json_delta buffer adds detail to tool label on block_stop', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // content_block_start → tool_use "Bash"
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash', id: 'test-id' } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 1, 'tool_use block_start should emit label');
    assert.equal(ctx.toolLog[0].label, 'Bash');
    assert.equal(ctx.toolLog[0].detail, undefined, 'no detail yet');

    // input_json_delta chunks
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command": "ls' } },
    }, ctx, 'test');
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: ' /tmp"}' } },
    }, ctx, 'test');

    // content_block_stop → flush input JSON → add detail
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
    }, ctx, 'test');
    assert.ok(ctx.toolLog[0].detail, 'detail should be populated after flush');
    assert.ok(ctx.toolLog[0].detail.includes('ls /tmp'), 'detail should contain command');
});

test('extractFromEvent updates context for each CLI path', () => {
    const claudeCtx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    extractFromEvent('claude', {
        type: 'assistant',
        message: {
            content: [{ type: 'text', text: 'hello ' }, { type: 'tool_use', name: 'Read' }],
        },
    }, claudeCtx, 'claude-agent');
    extractFromEvent('claude', {
        type: 'result',
        total_cost_usd: 0.12,
        num_turns: 3,
        duration_ms: 777,
        session_id: 'claude-session',
    }, claudeCtx, 'claude-agent');
    assert.equal(claudeCtx.fullText, 'hello ');
    assert.deepEqual(claudeCtx.toolLog, [{ icon: '🔧', label: 'Read', toolType: 'tool', stepRef: undefined }]);
    assert.equal(claudeCtx.cost, 0.12);
    assert.equal(claudeCtx.turns, 3);
    assert.equal(claudeCtx.duration, 777);
    assert.equal(claudeCtx.sessionId, 'claude-session');

    const codexCtx = { toolLog: [], fullText: '' };
    extractFromEvent('codex', {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'done' },
    }, codexCtx, 'codex-agent');
    extractFromEvent('codex', {
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 20 },
    }, codexCtx, 'codex-agent');
    assert.equal(codexCtx.fullText, 'done');
    assert.deepEqual(codexCtx.tokens, { input_tokens: 10, output_tokens: 20, cached_input_tokens: 0 });

    const geminiCtx = { toolLog: [], fullText: '' };
    extractFromEvent('gemini', {
        type: 'message',
        role: 'assistant',
        content: 'gemini answer',
    }, geminiCtx, 'gemini-agent');
    extractFromEvent('gemini', {
        type: 'result',
        stats: { duration_ms: 987, tool_calls: 2 },
    }, geminiCtx, 'gemini-agent');
    assert.equal(geminiCtx.fullText, 'gemini answer');
    assert.equal(geminiCtx.duration, 987);
    assert.equal(geminiCtx.turns, 2);

    const opencodeCtx = { toolLog: [], fullText: '' };
    extractFromEvent('opencode', {
        type: 'text',
        part: { text: 'opencode answer' },
    }, opencodeCtx, 'opencode-agent');
    extractFromEvent('opencode', {
        type: 'step_finish',
        sessionID: 'opencode-session',
        part: {
            tokens: { input: 11, output: 22 },
            cost: 0.7,
        },
    }, opencodeCtx, 'opencode-agent');
    assert.equal(opencodeCtx.fullText, 'opencode answer');
    assert.equal(opencodeCtx.sessionId, 'opencode-session');
    assert.deepEqual(opencodeCtx.tokens, { input_tokens: 11, output_tokens: 22, cached_read: 0, cached_write: 0 });
    assert.equal(opencodeCtx.cost, 0.7);
});

test('extractToolLabel keeps backward compatibility and claude keys are deterministic', () => {
    const first = extractToolLabel('gemini', { type: 'tool_result', status: 'failed' });
    assert.deepEqual(first, { icon: '❌', label: 'failed', toolType: 'tool', stepRef: 'gemini:tool:tool', status: 'error' });

    const keyFromIndex = makeClaudeToolKeyForTest(
        { type: 'stream_event', event: { index: 3 } },
        { icon: '🔧', label: 'Bash' }
    );
    const keyFromMessageId = makeClaudeToolKeyForTest(
        { type: 'assistant', message: { id: 'msg_1' } },
        { icon: '🔧', label: 'Read' }
    );
    const keyFromType = makeClaudeToolKeyForTest(
        { type: 'assistant' },
        { icon: '🔧', label: 'Read' }
    );

    assert.equal(keyFromIndex, 'claude:idx:3:🔧:Bash');
    assert.equal(keyFromMessageId, 'claude:msg:msg_1:🔧:Read');
    assert.equal(keyFromType, 'claude:type:assistant:🔧:Read');
});

// ── Phase 3 (P2) tests ──────────────────────────────────────

test('P2-3.1: Claude system event stores model and metadata', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'system',
        model: 'claude-sonnet-4-20250514',
        tools: ['Bash', 'Read'],
        mcp_servers: ['filesystem'],
        version: '1.0.34',
    }, ctx, 'claude');
    assert.equal(ctx.model, 'claude-sonnet-4-20250514');
    assert.deepEqual(ctx.metadata.tools, ['Bash', 'Read']);
    assert.deepEqual(ctx.metadata.mcp_servers, ['filesystem']);
    assert.equal(ctx.metadata.version, '1.0.34');
});

test('P2-3.2: Claude message_start captures input_tokens', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'message_start', message: { usage: { input_tokens: 1234 } } },
    }, ctx, 'claude');
    assert.deepEqual(ctx.tokens, { input_tokens: 1234, output_tokens: 0 });
});

test('P2-3.4: Codex turn.started pushes trace', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [] };
    extractFromEvent('codex', { type: 'turn.started' }, ctx, 'codex');
    assert.ok(ctx.traceLog.some(l => l.includes('codex turn started')));
});

test('P2-3.6: Codex turn.completed stores cached_input_tokens', () => {
    const ctx = { toolLog: [], fullText: '' };
    extractFromEvent('codex', {
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 30 },
    }, ctx, 'codex');
    assert.deepEqual(ctx.tokens, { input_tokens: 100, output_tokens: 50, cached_input_tokens: 30 });
});

test('P2-3.7: Gemini init stores model', () => {
    const ctx = { toolLog: [], fullText: '' };
    extractFromEvent('gemini', { type: 'init', model: 'gemini-3-flash-preview' }, ctx, 'gemini');
    assert.equal(ctx.model, 'gemini-3-flash-preview');
});

test('P2-3.8: Gemini delta message pushes trace', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [] };
    extractFromEvent('gemini', {
        type: 'message', role: 'assistant', content: 'partial', delta: true,
    }, ctx, 'gemini');
    assert.equal(ctx.fullText, 'partial');
    assert.ok(ctx.traceLog.some(l => l.includes('gemini delta text')));
});

test('P2-3.10: OpenCode step_start stores model', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [] };
    extractFromEvent('opencode', {
        type: 'step_start', part: { model: 'big-pickle' },
    }, ctx, 'opencode');
    assert.equal(ctx.model, 'big-pickle');
    assert.ok(ctx.traceLog.some(l => l.includes('step_start') && l.includes('big-pickle')));
});

test('P2-3.11+3.12+3.13: OpenCode step_finish stores reason, timing, and total tokens', () => {
    const ctx = { toolLog: [], fullText: '' };
    extractFromEvent('opencode', {
        type: 'step_finish',
        sessionID: 'oc-1',
        part: {
            tokens: { input: 10, output: 20, total: 30, cache: { read: 5, write: 2 } },
            cost: 0.05,
            reason: 'tool-calls',
            time: { start: 1000, end: 2000 },
        },
    }, ctx, 'oc');
    assert.equal(ctx.finishReason, 'tool-calls');
    assert.deepEqual(ctx.metadata.lastStepTime, { start: 1000, end: 2000 });
    assert.equal(ctx.tokens.total_tokens, 30);
    assert.equal(ctx.tokens.cached_read, 5);
    assert.equal(ctx.tokens.cached_write, 2);
});

test('P2-3.14: ACP session_cancelled returns cancel tool entry', () => {
    const result = extractFromAcpUpdate({
        update: { sessionUpdate: 'session_cancelled', reason: 'user abort' },
    });
    assert.equal(result.tool.icon, '⏹️');
    assert.ok(result.tool.label.includes('user abort'));
    assert.equal(result.tool.status, 'cancelled');
});

test('P2-3.15: ACP request_permission returns audit entry', () => {
    const result = extractFromAcpUpdate({
        update: { sessionUpdate: 'request_permission', permission: 'file_write' },
    });
    assert.equal(result.tool.icon, '🔐');
    assert.ok(result.tool.label.includes('file_write'));
    assert.equal(result.tool.status, 'pending');
});

test('P0-1.1: Claude signature_delta is discarded without flushing thinking buffer', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), claudeThinkingBuf: 'still thinking' };
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'abc' } },
    }, ctx, 'claude');
    // Thinking buffer should NOT be flushed
    assert.equal(ctx.claudeThinkingBuf, 'still thinking');
    assert.equal(ctx.toolLog.length, 0);
});

test('encrypted thinking: opus-4-7 pattern (signature only, no thinking_delta) emits 🔒 badge', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // 1. thinking block opens
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 0, 'block_start alone should not emit');
    // 2. only signature_delta arrives (304 chars like real opus-4-7 stream)
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x'.repeat(304) } },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 0, 'signature_delta alone should not emit');
    // 3. block_stop with empty thinking buffer → encrypted badge
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 1, 'encrypted thinking should emit one badge');
    assert.equal(ctx.toolLog[0].icon, '🔒');
    assert.equal(ctx.toolLog[0].label, 'encrypted thinking');
    assert.equal(ctx.toolLog[0].toolType, 'thinking');
    assert.ok(ctx.toolLog[0].detail.includes('304'), 'detail should mention signature length');
    // 4. state should reset after stop
    assert.equal(ctx.claudeThinkingBlockOpen, false);
    assert.equal(ctx.claudeThinkingHadDelta, false);
});

test('spark-visibility: codex agent_message surfaces a 💬 toolLog entry so lightweight models are visible', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('codex', {
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'OK. 7 is prime.' },
    }, ctx, 'spark');
    assert.equal(ctx.fullText, 'OK. 7 is prime.', 'fullText still accumulates');
    assert.equal(ctx.toolLog.length, 1, 'agent_message must create a visible toolLog entry');
    assert.equal(ctx.toolLog[0].icon, '💬');
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.equal(ctx.toolLog[0].stepRef, 'codex:item:item_0');
    assert.ok(ctx.toolLog[0].detail.includes('7 is prime'));
});

test('spark-visibility: empty agent_message text does NOT create a spurious entry', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('codex', {
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: '   \n  ' },
    }, ctx, 'codex');
    assert.equal(ctx.toolLog.length, 0);
});

test('spark-visibility: repeated agent_message with same item.id is deduped', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    const evt = {
        type: 'item.completed',
        item: { id: 'item_DUP', type: 'agent_message', text: 'same' },
    };
    extractFromEvent('codex', evt, ctx, 'codex');
    extractFromEvent('codex', evt, ctx, 'codex');
    assert.equal(ctx.toolLog.length, 1, 'dedup via stepRef prevents double-entry on replay');
});

test('multi-turn: same tool name across distinct messages keeps separate toolLog entries (dedup fix)', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // Message A: first tool_use (index 0) with unique id
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_A', name: 'mcp__context7__resolve-library-id' } },
    }, ctx, 'smoke');
    // Message B: second call with same name, also index 0 but distinct id (was colliding before fix)
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_B', name: 'mcp__context7__resolve-library-id' } },
    }, ctx, 'smoke');
    assert.equal(ctx.toolLog.length, 2, 'both tool_uses must be recorded, not deduped by index collision');
    assert.equal(ctx.toolLog[0].stepRef, 'claude:tooluse:toolu_A');
    assert.equal(ctx.toolLog[1].stepRef, 'claude:tooluse:toolu_B');
});

test('multi-turn: true duplicate tool_use_id IS deduped (same stepRef → key collision)', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // Same id replayed (e.g. re-emission in assistant fallback) — should dedupe
    const ev = {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_SAME', name: 'Write' } },
    };
    extractFromEvent('claude', ev, ctx, 'smoke');
    extractFromEvent('claude', ev, ctx, 'smoke');
    assert.equal(ctx.toolLog.length, 1, 'true replay of same tool_use_id must dedupe');
});

test('codex turn.failed surfaces error tool entry with parsed message', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), traceLog: [] };
    extractFromEvent('codex', {
        type: 'turn.failed',
        error: { message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-spark\' model is not supported when using Codex with a ChatGPT account."}}' },
    }, ctx, 'codex');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].icon, '❌');
    assert.equal(ctx.toolLog[0].status, 'error');
    assert.ok(ctx.toolLog[0].detail.includes('gpt-5.3-spark'), 'nested JSON error.message should be unwrapped');
    assert.ok(!ctx.toolLog[0].detail.includes('"type":"error"'), 'outer JSON envelope should be stripped');
});

test('codex standalone error event surfaces ❌ entry', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), traceLog: [] };
    extractFromEvent('codex', { type: 'error', message: 'network connection lost' }, ctx, 'codex');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].detail, 'network connection lost');
});

test('encrypted thinking: plaintext thinking does NOT also emit 🔒 badge (regression)', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // Open thinking block
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    }, ctx, 'test');
    // Plaintext thinking_delta arrives (sonnet/opus-4-6 path)
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning about the problem.' } },
    }, ctx, 'test');
    // Then signature_delta (also arrives in plaintext path as closing signature)
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    }, ctx, 'test');
    // Stop
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
    }, ctx, 'test');
    assert.equal(ctx.toolLog.length, 1, 'should emit exactly one badge');
    assert.equal(ctx.toolLog[0].icon, '💭', 'plaintext path must keep 💭 icon, not 🔒');
    assert.ok(ctx.toolLog[0].detail.includes('Reasoning about'), 'plaintext content preserved');
});

test('P1-2.2: Claude rate_limit_event emits warning tool entry', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'rate_limit_event',
        message: 'Rate limit exceeded',
    }, ctx, 'claude');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].icon, '⚠️');
    assert.equal(ctx.toolLog[0].status, 'warning');
});

test('P1-2.3: Claude result stores cache token breakdown', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'result',
        total_cost_usd: 0.5,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
    }, ctx, 'claude');
    assert.equal(ctx.tokens.cache_read, 80);
    assert.equal(ctx.tokens.cache_creation, 20);
});

test('P0-1.7+1.8: OpenCode multi-step token accumulation (including total_tokens)', () => {
    const ctx = { toolLog: [], fullText: '' };
    // Step 1
    extractFromEvent('opencode', {
        type: 'step_finish', sessionID: 'oc-1',
        part: { tokens: { input: 10, output: 20, total: 30, cache: { read: 5, write: 1 } }, cost: 0.01 },
    }, ctx, 'oc');
    // Step 2
    extractFromEvent('opencode', {
        type: 'step_finish', sessionID: 'oc-1',
        part: { tokens: { input: 15, output: 25, total: 40, cache: { read: 3, write: 2 } }, cost: 0.02 },
    }, ctx, 'oc');
    assert.equal(ctx.tokens.input_tokens, 25);
    assert.equal(ctx.tokens.output_tokens, 45);
    assert.equal(ctx.tokens.total_tokens, 70);  // 30 + 40, not just 40
    assert.equal(ctx.tokens.cached_read, 8);
    assert.equal(ctx.tokens.cached_write, 3);
    assert.equal(ctx.cost, 0.03);
});

test('P0-1.2: Claude user/tool_result updates existing tool label', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    // First emit a tool_use label
    extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tu_abc' }] },
    }, ctx, 'claude');
    assert.equal(ctx.toolLog.length, 1);
    assert.equal(ctx.toolLog[0].stepRef, 'claude:tooluse:tu_abc');

    // Now receive tool_result feedback (success)
    extractFromEvent('claude', {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_abc', content: 'output here', is_error: false }] },
    }, ctx, 'claude');
    assert.equal(ctx.toolLog[0].icon, '✅');
    assert.equal(ctx.toolLog[0].status, 'done');
    assert.ok(ctx.toolLog[0].detail.includes('output here'));

    // Error case
    const ctx2 = { toolLog: [], fullText: '', seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    extractFromEvent('claude', {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', id: 'tu_def' }] },
    }, ctx2, 'claude');
    extractFromEvent('claude', {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_def', content: 'permission denied', is_error: true }] },
    }, ctx2, 'claude');
    assert.equal(ctx2.toolLog[0].icon, '❌');
    assert.equal(ctx2.toolLog[0].status, 'error');
});

test('P1-2.1: Claude message_delta accumulates output_tokens', () => {
    const ctx = { toolLog: [], fullText: '', seenToolKeys: new Set() };
    extractFromEvent('claude', {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 42 } },
    }, ctx, 'claude');
    assert.equal(ctx.tokens.output_tokens, 42);
});

test('P1-2.4: Codex failed command shows error icon and exit code', () => {
    const labels = extractToolLabelsForTest('codex', {
        type: 'item.completed',
        item: { type: 'command_execution', id: 'cmd-1', command: 'npm test', exit_code: 1, aggregated_output: 'FAIL' },
    }, {});
    assert.equal(labels[0].icon, '❌');
    assert.equal(labels[0].status, 'error');
    assert.equal(labels[0].exitCode, 1);
    assert.equal(labels[0].stepRef, 'codex:item:cmd-1');
});

test('P0-1.3+1.4: Codex item.started emits running label with item.id stepRef', () => {
    const labels = extractToolLabelsForTest('codex', {
        type: 'item.started',
        item: { type: 'command_execution', id: 'cmd-42', command: 'ls -la' },
    }, {});
    assert.equal(labels[0].icon, '🔧');
    assert.equal(labels[0].status, 'running');
    assert.equal(labels[0].stepRef, 'codex:item:cmd-42');
});

test('P0-1.10: ACP tool_call_update status mapping covers all known + unknown statuses', () => {
    // running
    const running = extractFromAcpUpdate({
        update: { sessionUpdate: 'tool_call_update', name: 'X', id: 'r1', status: 'running' },
    });
    assert.equal(running.tool.icon, '🔧');
    assert.equal(running.tool.status, 'running');

    // in_progress
    const ip = extractFromAcpUpdate({
        update: { sessionUpdate: 'tool_call_update', name: 'X', id: 'r2', status: 'in_progress' },
    });
    assert.equal(ip.tool.icon, '🔧');
    assert.equal(ip.tool.status, 'running');

    // pending
    const pending = extractFromAcpUpdate({
        update: { sessionUpdate: 'tool_call_update', name: 'X', id: 'r3', status: 'pending' },
    });
    assert.equal(pending.tool.icon, '⏳');
    assert.equal(pending.tool.status, 'pending');

    // unknown status → neutral ❔
    const unknown = extractFromAcpUpdate({
        update: { sessionUpdate: 'tool_call_update', name: 'X', id: 'r4', status: 'cancelled' },
    });
    assert.equal(unknown.tool.icon, '❔');
    assert.equal(unknown.tool.status, 'cancelled');
});

test('P1-2.6: OpenCode failed exit code shows error icon', () => {
    const labels = extractToolLabelsForTest('opencode', {
        type: 'tool_use',
        part: {
            tool: 'bash',
            callID: 'call_xyz',
            state: { status: 'completed', metadata: { exit: 127 }, input: { command: 'bad-cmd' } },
        },
    }, {});
    assert.equal(labels[0].icon, '❌');
    assert.equal(labels[0].status, 'error');
    assert.equal(labels[0].exitCode, 127);
});

test('extractOutputChunk returns live assistant text for gemini, opencode, and codex', () => {
    assert.equal(
        extractOutputChunk('gemini', { type: 'message', role: 'assistant', content: 'hello', delta: true }),
        'hello',
    );
    assert.equal(
        extractOutputChunk('opencode', { type: 'text', part: { text: 'world' } }),
        'world',
    );
    // [P0-1.5] Codex now returns agent_message text as live chunk
    assert.equal(
        extractOutputChunk('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'codex reply' } }),
        'codex reply',
    );
    // Non-agent_message Codex events still return ''
    assert.equal(
        extractOutputChunk('codex', { type: 'item.completed', item: { type: 'command_execution' } }),
        '',
    );
});

// ─── #107 Gemini thought/thinking filtering ───

test('#107: extractOutputChunk skips Gemini thought events', () => {
    // Standalone thought event type (future Gemini CLI)
    assert.equal(
        extractOutputChunk('gemini', { type: 'thought', content: 'internal reasoning' }),
        '',
    );
    // Message event with thought flag
    assert.equal(
        extractOutputChunk('gemini', { type: 'message', role: 'assistant', content: 'thinking...', thought: true }),
        '',
    );
    // Normal message still works
    assert.equal(
        extractOutputChunk('gemini', { type: 'message', role: 'assistant', content: 'hello' }),
        'hello',
    );
});

test('#107: extractOutputChunk filters thought parts from array content', () => {
    const event = readFixture('gemini-message-with-thought.json');
    const chunk = extractOutputChunk('gemini', event);
    assert.equal(chunk, 'The current directory is /home/user.');
    assert.ok(!chunk.includes('thought'));
});

test('#107: extractFromEvent skips Gemini thought events from fullText', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [] };

    // Thought event should not accumulate
    extractFromEvent('gemini', {
        type: 'thought',
        content: 'Let me reason about this...',
    }, ctx, 'gemini');
    assert.equal(ctx.fullText, '');
    assert.ok(ctx.traceLog.some(l => l.includes('thought (hidden)')));

    // Message with thought=true should not accumulate
    extractFromEvent('gemini', {
        type: 'message',
        role: 'assistant',
        content: 'internal thinking',
        thought: true,
    }, ctx, 'gemini');
    assert.equal(ctx.fullText, '');

    // Normal message should still accumulate
    extractFromEvent('gemini', {
        type: 'message',
        role: 'assistant',
        content: 'final answer',
        delta: true,
    }, ctx, 'gemini');
    assert.equal(ctx.fullText, 'final answer');
});

test('#107: extractFromEvent filters thought parts from array content', () => {
    const ctx = { toolLog: [], fullText: '', traceLog: [] };
    const event = readFixture('gemini-message-with-thought.json');
    extractFromEvent('gemini', event, ctx, 'gemini');
    assert.equal(ctx.fullText, 'The current directory is /home/user.');
    assert.ok(!ctx.fullText.includes('should check'));
});

test('#107: extractOutputChunk handles null elements in content array', () => {
    const chunk = extractOutputChunk('gemini', {
        type: 'message',
        role: 'assistant',
        content: [null, { type: 'text', text: 'safe' }, undefined, { type: 'thought', thought: 'hidden' }],
    });
    assert.equal(chunk, 'safe');
});
