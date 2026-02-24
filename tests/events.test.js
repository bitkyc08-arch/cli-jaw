import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    extractFromEvent,
    extractSessionId,
    extractToolLabel,
    extractToolLabelsForTest,
    makeClaudeToolKeyForTest,
} from '../src/events.js';

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

    assert.deepEqual(first, [{ icon: '🔧', label: 'Bash' }]);
    assert.equal(second.length, 0);
    assert.equal(ctx.hasClaudeStreamEvents, true);
});

test('claude assistant fallback works when stream was not seen', () => {
    const ctx = createClaudeCtx();
    const evt = readFixture('claude-assistant-tool.json');

    const labels = extractToolLabelsForTest('claude', evt, ctx);
    assert.deepEqual(labels, [{ icon: '🔧', label: 'Read' }]);
});

test('claude assistant blocks are ignored after stream event', () => {
    const ctx = createClaudeCtx();
    ctx.hasClaudeStreamEvents = true;
    const evt = readFixture('claude-assistant-tool.json');

    const labels = extractToolLabelsForTest('claude', evt, ctx);
    assert.equal(labels.length, 0);
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
            name: 'claude stream thinking',
            cli: 'claude',
            fixture: 'claude-stream-thinking.json',
            expected: [{ icon: '💭', label: 'thinking...' }],
        },
        {
            name: 'codex web search',
            cli: 'codex',
            fixture: 'codex-web-search.json',
            expected: [{ icon: '🔍', label: 'node test runner' }],
        },
        {
            name: 'codex open page',
            cli: 'codex',
            fixture: 'codex-open-page.json',
            expected: [{ icon: '🌐', label: 'example.com' }],
        },
        {
            name: 'codex open page invalid fallback',
            cli: 'codex',
            fixture: 'codex-open-page-invalid.json',
            expected: [{ icon: '🌐', label: 'page' }],
        },
        {
            name: 'codex command execution',
            cli: 'codex',
            fixture: 'codex-command.json',
            expected: [{ icon: '⚡', label: 'npm run test:events' }],
        },
        {
            name: 'codex reasoning',
            cli: 'codex',
            fixture: 'codex-reasoning.json',
            expected: [{ icon: '💭', label: 'Plan isolate regression' }],
        },
        {
            name: 'gemini tool use',
            cli: 'gemini',
            fixture: 'gemini-tool-use.json',
            expected: [{ icon: '🔧', label: 'shell: npm run lint' }],
        },
        {
            name: 'gemini tool result success',
            cli: 'gemini',
            fixture: 'gemini-tool-result-success.json',
            expected: [{ icon: '✅', label: 'success' }],
        },
        {
            name: 'gemini tool result error',
            cli: 'gemini',
            fixture: 'gemini-tool-result-error.json',
            expected: [{ icon: '❌', label: 'error' }],
        },
        {
            name: 'opencode tool use',
            cli: 'opencode',
            fixture: 'opencode-tool-use.json',
            expected: [{ icon: '🔧', label: 'web-search' }],
        },
        {
            name: 'opencode tool result',
            cli: 'opencode',
            fixture: 'opencode-tool-result.json',
            expected: [{ icon: '✅', label: 'web-search' }],
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
    assert.deepEqual(claudeCtx.toolLog, [{ icon: '🔧', label: 'Read' }]);
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
    assert.deepEqual(codexCtx.tokens, { input_tokens: 10, output_tokens: 20 });

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
    assert.deepEqual(opencodeCtx.tokens, { input_tokens: 11, output_tokens: 22 });
    assert.equal(opencodeCtx.cost, 0.7);
});

test('extractToolLabel keeps backward compatibility and claude keys are deterministic', () => {
    const first = extractToolLabel('gemini', { type: 'tool_result', status: 'failed' });
    assert.deepEqual(first, { icon: '❌', label: 'failed' });

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
