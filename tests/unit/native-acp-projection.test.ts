import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acpText, acpSnapshot } from '../../src/agent/runtime/acp/content.ts';
import { FULLTEXT_MAX_CHARS } from '../../src/agent/events/fulltext-bound.ts';
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
import { encodeRuntimeBody, decodeRuntimeBody } from '../../src/trace/runtime-body-codec.ts';
import { stringifyTraceValue } from '../../src/trace/redact.ts';

// This suite injects every recorder; loading the unused SQLite default races other test processes.
mock.module('../../src/trace/activity-journal.js', { namedExports: {
    markActivityFailure: () => {},
    appendActivityBody: () => assert.fail('default trace recorder must not be used by a pure projector test'),
} });
const { RuntimeProjection } = await import('../../src/agent/runtime/projection.ts');
const { AcpProjection } = await import('../../src/agent/runtime/acp/projection.ts');

function harness(scope = 'one', failure?: 'null' | 'throw') {
    const events: RuntimeEvent[] = [], beforeCodec: RuntimeEventBody[] = [], notices: string[] = [];
    let seq = 0;
    const state = new RuntimeProjection({ runId: 'run-' + scope, sessionId: 'jaw-chat-' + scope,
        scope, turnId: 'turn-' + scope, audience: 'internal' }, (context, body) => {
        beforeCodec.push(body);
        if (failure === 'null') return null;
        if (failure === 'throw') throw new Error('fixture recorder unavailable');
        const identity = { version: 1 as const, runId: context.runId, sessionId: context.sessionId,
            scope: context.scope, turnId: context.turnId, seq: seq += 3 };
        const encoded = encodeRuntimeBody(identity, body);
        const event = decodeRuntimeBody(JSON.parse(stringifyTraceValue(encoded.raw)), identity, body.kind);
        assert.ok(event); events.push(event); return event;
    }, reason => notices.push(reason));
    const mapper = new AcpProjection(state);
    const update = (kind: string, fields: Record<string, unknown> = {}) => mapper.update({
        sessionId: 'native', update: { sessionUpdate: kind, ...fields },
    }, 'native');
    const message = (text: string, messageId?: string) => update('agent_message_chunk', {
        content: { type: 'text', text }, ...(messageId === undefined ? {} : { messageId }),
    });
    return { state, mapper, events, beforeCodec, notices, update, message };
}
const messages = (h: ReturnType<typeof harness>) => h.events.filter(e => e.kind === 'message');
const tools = (h: ReturnType<typeof harness>) => h.events.filter(e => e.kind === 'tool');
const end = { stopReason: 'end_turn' };

test('captured Grok read-file flow selects only its trailing anonymous answer', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/grok-acp-read-file.json', import.meta.url), 'utf8'));
    const h = harness();
    for (const frame of fixture.frames) h.mapper.update(frame.params, 'fixture-native');
    assert.equal(h.mapper.finalText(fixture.result), fixture.expectedFinal);
    assert.ok(h.mapper.partialText.startsWith("I'll read"));
    assert.ok(h.mapper.partialText.endsWith(fixture.expectedFinal));
    assert.equal(messages(h).at(-1)!.phase, 'final');
    assert.equal(messages(h).at(-1)!.text, fixture.expectedFinal);
    assert.equal(tools(h).at(-1)!.status, 'done');
    assert.equal(tools(h).at(-1)!.name, 'read_file');
    assert.match(tools(h).at(-1)!.output!, /GROK_TOOL_7689_CEDAR/);
    assert.equal(new Set(tools(h).map(e => e.itemId)).size, 1);
    assert.equal(h.events.some(e => e.kind === 'turn-end' || e.kind === 'turn-start'), false);
    assert.equal(JSON.stringify(h.events).includes('fixture-read'), false);
});

test('explicit and anonymous segments use actual ID and structural boundaries', () => {
    const h = harness();
    h.message('first', 'one'); h.message(' continued', 'one');
    h.message('second', 'two'); assert.equal(h.mapper.finalText(end), 'second');
    h.message('anonymous'); assert.equal(h.mapper.finalText(end), 'anonymous');
    h.message(' answer'); assert.equal(h.mapper.finalText(end), 'anonymous answer');
    h.message('explicit again', 'three'); assert.equal(h.mapper.finalText(end), 'explicit again');
    h.update('agent_thought_chunk', { content: { type: 'text', text: 'thinking' } });
    assert.equal(h.mapper.finalText(end), null);
    h.message('after thought'); h.update('user_message_chunk', { content: { type: 'text', text: 'user' } });
    assert.equal(h.mapper.finalText(end), null);
    h.message('new answer');
    assert.equal(h.mapper.finalText(end), 'new answer');
    assert.equal(h.mapper.partialText.includes('thinking'), false);
    assert.equal(h.mapper.partialText.includes('user'), false);
});

test('closed-only text never revives; empty text is distinct from missing and stopped output', () => {
    const h = harness(); assert.equal(h.mapper.finalText(end), null);
    h.message('commentary'); h.update('tool_call', { toolCallId: 'read', title: 'Read' });
    assert.equal(h.mapper.finalText(end), null);
    h.message(''); assert.equal(h.mapper.finalText(end), '');
    const count = h.events.length; assert.equal(h.mapper.finalText(end), ''); assert.equal(h.events.length, count);
    assert.equal(h.mapper.partialText, 'commentary');
    for (const reason of ['cancelled', 'max_tokens', 'max_turn_requests', 'refusal', 'unknown', undefined]) {
        assert.equal(h.mapper.finalText({ stopReason: reason }), null);
    }
    h.mapper.stopTools(); assert.equal(h.mapper.finalText(end), null);
    const stopped = h.events.length; h.mapper.stopTools(); assert.equal(h.events.length, stopped);
    h.message('replacement'); assert.equal(h.mapper.finalText(end), 'replacement');
    assert.equal(h.mapper.partialText, 'commentaryreplacement');
});

test('a duplicate terminal tool snapshot does not discard a newer assistant answer', () => {
    const h = harness(), terminal = { toolCallId: 'retired', title: 'Read', status: 'completed' };
    h.update('tool_call', terminal); h.message('answer');
    const count = h.events.length; h.update('tool_call_update', terminal);
    assert.equal(h.events.length, count); assert.equal(h.mapper.finalText(end), 'answer');
});

test('an explicit ID boundary without text closes the old candidate without inventing empty final', () => {
    for (const ids of [['one', 'two'], ['one', undefined], [undefined, 'two']] as const) {
        const h = harness(); h.message('old', ids[0]);
        h.update('agent_message_chunk', { content: [], ...(ids[1] === undefined ? {} : { messageId: ids[1] }) });
        assert.equal(h.mapper.finalText(end), null); assert.equal(h.mapper.partialText, 'old');
    }
});

test('tool snapshots preserve identity, richer detail and native completion semantics', () => {
    const h = harness();
    h.update('tool_call', { toolCallId: 'private-id', title: 'run_terminal_command', rawInput: { command: 'fixture' } });
    h.update('tool_call_update', { toolCallId: 'private-id', title: 'Execute fixture', rawOutput: 'first' });
    h.update('tool_call_update', { toolCallId: 'private-id', rawOutput: '' });
    assert.equal(tools(h).at(-1)!.output, ''); assert.equal(tools(h).at(-1)!.status, 'running');
    assert.equal(tools(h).at(-1)!.name, 'run_terminal_command'); assert.match(tools(h).at(-1)!.detail!, /Execute fixture/);
    const terminal = { toolCallId: 'private-id', status: 'completed', rawOutput: { exit_code: 1, output_for_prompt: 'failed command' } };
    h.update('tool_call_update', terminal);
    assert.equal(tools(h).at(-1)!.status, 'done'); assert.match(tools(h).at(-1)!.detail!, /[Ee]xit.*1/);
    const count = h.events.length; h.update('tool_call_update', terminal);
    h.update('tool_call_update', { toolCallId: 'private-id', status: 'in_progress' }); h.mapper.stopTools();
    assert.equal(h.events.length, count);
    assert.equal(JSON.stringify(h.events).includes('private-id'), false);
});

test('unknown-first updates work, failed status remains error and stop retires only running tools', () => {
    const h = harness();
    h.update('tool_call_update', { toolCallId: 'one', content: [{ type: 'content', content: { type: 'text', text: 'output' } }] });
    h.update('tool_call', { toolCallId: 'two', title: 'Second', status: 'failed' });
    h.mapper.stopTools();
    assert.equal(tools(h).findLast(e => e.name === 'Second')!.status, 'error');
    assert.equal(tools(h).at(-1)!.status, 'stopped');
    const oldId = tools(h).at(-1)!.itemId;
    h.update('tool_call', { toolCallId: 'one', title: 'New attempt' });
    assert.equal(tools(h).at(-1)!.status, 'running'); assert.notEqual(tools(h).at(-1)!.itemId, oldId);
});

test('binary-only message closes final eligibility and tool binary content is marked without retaining bytes', () => {
    const h = harness(); h.message('earlier');
    const binary = { type: 'image', data: 'PRIVATE_BINARY_CANARY'.repeat(10000), mimeType: 'image/png' };
    h.update('agent_message_chunk', { content: binary }); assert.equal(h.mapper.finalText(end), null);
    h.update('tool_call', { toolCallId: 'binary', content: [{ type: 'content', content: binary }], title: 'Image' });
    assert.match(tools(h).at(-1)!.detail!, /unsupported/i);
    assert.equal(JSON.stringify(h.beforeCodec).includes('PRIVATE_BINARY_CANARY'), false);
    h.update('agent_message_chunk', { content: [binary, { type: 'text', text: 'supported text' }] });
    assert.equal(h.mapper.finalText(end), 'supported text'); assert.equal(h.mapper.partialText, 'earliersupported text');
});

test('whole typed JSON is sanitized before recorder/codec clipping; prose is not guessed structured', () => {
    const h = harness(), secret = 'CANARY_PRIVATE_JSON_SECRET';
    h.update('tool_call', { toolCallId: 'json', rawInput: { password: secret, padding: 'x'.repeat(250000) },
        rawOutput: { password: secret, padding: 'y'.repeat(250000) } });
    h.update('tool_call_update', { toolCallId: 'json', rawInput: '{"password":"' + secret });
    assert.equal(tools(h).at(-1)!.input, '[structured content withheld]');
    h.update('tool_call_update', { toolCallId: 'json', rawInput: JSON.stringify({ password: secret }), rawOutput: '[ -f file ]' });
    h.message('[docs](url) [ -f file ]'); assert.equal(h.mapper.finalText(end), '[docs](url) [ -f file ]');
    assert.equal(tools(h).at(-1)!.output, '[ -f file ]');
    assert.equal(JSON.stringify(h.beforeCodec).includes(secret), false);
    assert.equal(JSON.stringify(h.events).includes(secret), false);
    assert.ok(h.state.diagnostics().withinSnapshotCap);
});

test('raw final and partial survive null/throwing recorders and are not preview-clipped', () => {
    for (const failure of [undefined, 'null', 'throw'] as const) {
        const h = harness('failure-' + failure, failure), answer = 'z'.repeat(5000);
        h.message('commentary'); h.update('agent_thought_chunk', { content: { type: 'text', text: 'reason' } });
        h.message(answer);
        assert.equal(h.mapper.finalText(end), answer); assert.equal(h.mapper.partialText, 'commentary' + answer);
        if (!failure) assert.ok(messages(h).at(-1)!.text.length <= 3000);
        else assert.equal(h.state.diagnostics().recordingFailed, true);
    }
});

test('cumulative raw bound rejects atomically across segments while preserving salvage', () => {
    const h = harness('limit', 'null'), part = 'x'.repeat(FULLTEXT_MAX_CHARS / 2);
    h.message(part); h.update('agent_thought_chunk', { content: { type: 'text', text: 'boundary' } }); h.message(part);
    assert.equal(h.mapper.partialText.length, FULLTEXT_MAX_CHARS);
    assert.throws(() => h.message('overflow', 'new-id'), /acp_text_limit/);
    assert.equal(h.mapper.partialText.length, FULLTEXT_MAX_CHARS); assert.equal(h.mapper.finalText(end), part);
    h.message(''); assert.equal(h.mapper.finalText(end), part);
});

test('malformed identity/status/content rejects while unknown metadata does not invent a terminal', () => {
    const h = harness(); h.message('answer');
    assert.throws(() => h.mapper.update({ sessionId: 'other', update: {} }, 'native'), /acp_wrong_session/);
    assert.throws(() => h.update('agent_message_chunk', { content: { type: 'text', text: 42 } }), /acp_invalid_content/);
    assert.throws(() => h.update('agent_message_chunk', { messageId: 42, content: { type: 'text', text: 'bad' } }), /acp_invalid_id/);
    assert.throws(() => h.update('tool_call', { toolCallId: '' }), /acp_invalid_id/);
    assert.throws(() => h.update('tool_call', { toolCallId: 'x', status: 'future' }), /acp_invalid_tool_status/);
    h.update('unknown-metadata', { result: 'not final' }); assert.equal(h.mapper.finalText(end), 'answer');
});

test('tool reference capacity is bounded and context identity disambiguates generic item IDs', () => {
    const h = harness('capacity', 'null');
    for (let i = 0; i < 4096; i++) h.update('tool_call', { toolCallId: 'tool-' + i });
    assert.throws(() => h.update('tool_call', { toolCallId: 'overflow' }), /acp_tool_limit/);
    const a = harness('a'), b = harness('b'); a.message('A'); b.message('B');
    assert.notDeepEqual([messages(a)[0]!.runId, messages(a)[0]!.itemId], [messages(b)[0]!.runId, messages(b)[0]!.itemId]);
    assert.equal(a.mapper.finalText(end), 'A'); assert.equal(b.mapper.finalText(end), 'B');
});

test('content helper distinguishes absent/empty, bounds arrays and snapshots, and never serializes binary blocks', () => {
    assert.deepEqual(acpText(undefined), { text: null, unsupported: false });
    assert.deepEqual(acpText([]), { text: null, unsupported: false });
    assert.deepEqual(acpText({ type: 'text', text: '' }), { text: '', unsupported: false });
    assert.deepEqual(acpText([{ type: 'text', text: 'A' }, { type: 'content', content: { type: 'text', text: 'B' } }]),
        { text: 'AB', unsupported: false });
    assert.deepEqual(acpText({ type: 'resource', toJSON() { throw new Error('must not serialize'); } }), { text: null, unsupported: true });
    assert.throws(() => acpText(Array(4097).fill({ type: 'text', text: '' })), /acp_content_limit/);
    assert.throws(() => acpText({ type: 'text', text: 'x'.repeat(FULLTEXT_MAX_CHARS + 1) }), /acp_content_limit/);
    assert.throws(() => acpSnapshot('x'.repeat(FULLTEXT_MAX_CHARS + 1)), /acp_content_limit/);
    assert.throws(() => acpSnapshot(undefined), /acp_invalid_content/);
    assert.throws(() => acpText({ type: 'content', content: null }), /acp_invalid_content/);
    assert.equal(acpSnapshot({ content: 'raw' }), '{"content":"raw"}');
});
