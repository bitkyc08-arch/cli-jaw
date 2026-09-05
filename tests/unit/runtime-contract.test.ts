import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeEvent } from '../../src/shared/runtime-event-parse.ts';
import type { RuntimeEventIdentity, RuntimeRequestView } from '../../src/shared/runtime-contract.ts';

const identity: RuntimeEventIdentity = {
    version: 1, runId: 'run-a', sessionId: 'jaw-chat', scope: 'mention-watch:other',
    turnId: 'jaw-turn', seq: 7, parentItemId: 'jaw-parent',
};
const message = { kind: 'message', itemId: 'message-1', phase: 'unknown', text: 'answer', operation: 'append' };
const parse = (body: Record<string, unknown>) => parseRuntimeEvent({ ...identity, ...body });
function view(): RuntimeRequestView {
    return { title: 'Choose', fields: [{ id: 'field-1', label: 'Question',
        options: [{ id: 'option-1', label: 'First' }], multiSelect: false, allowFreeform: true }] };
}
const request = (value: unknown) => parse({ kind: 'request', requestId: 'request-1', requestType: 'question', view: value });

test('rejects non-record boundaries and unsupported versions/discriminants', () => {
    for (const value of [null, undefined, [], true, 1, 'event']) assert.equal(parseRuntimeEvent(value), null);
    for (const version of [undefined, null, 0, 2, '1']) assert.equal(parse({ ...message, version }), null);
    for (const kind of [undefined, null, 'future-event', 'constructor', '__proto__']) assert.equal(parse({ ...message, kind }), null);
});

test('requires all jaw identity fields and preserves distinct scope/session and noncontiguous seq', () => {
    for (const key of ['runId', 'sessionId', 'scope', 'turnId', 'parentItemId']) {
        for (const value of ['', null, 7, [], 'x'.repeat(241)]) {
            assert.equal(parse({ ...message, [key]: value }), null, key + ':' + String(value));
        }
        assert.ok(parse({ ...message, [key]: 'x'.repeat(240) }));
    }
    for (const seq of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7']) {
        assert.equal(parse({ ...message, seq }), null, String(seq));
    }
    assert.deepEqual(parse(message), { ...identity, ...message });
    assert.equal(parse({ ...message, seq: Number.MAX_SAFE_INTEGER })?.seq, Number.MAX_SAFE_INTEGER);
    const withoutParent = { ...identity, ...message };
    delete withoutParent.parentItemId;
    assert.equal(Object.hasOwn(parseRuntimeEvent(withoutParent)!, 'parentItemId'), false);
});

test('message phase and operation are explicit, never inferred from text', () => {
    for (const phase of ['commentary', 'final', 'unknown']) {
        for (const operation of ['append', 'replace']) {
            assert.deepEqual(parse({ ...message, phase, operation, text: 'FINAL ANSWER' }), {
                ...identity, ...message, phase, operation, text: 'FINAL ANSWER',
            });
        }
    }
    for (const phase of [undefined, null, '', 'final_answer', 'reasoning']) assert.equal(parse({ ...message, phase }), null);
    for (const operation of [undefined, null, 'delta', 'merge']) assert.equal(parse({ ...message, operation }), null);
    assert.equal(parse({ ...message, itemId: '' }), null);
});

test('reasoning remains its own kind and drops message-only or provider fields', () => {
    assert.deepEqual(parse({ kind: 'reasoning', itemId: 'r', text: 'summary', operation: 'replace',
        phase: 'final', signature: 'opaque-native', providerRefs: { id: 'native' } }), {
        ...identity, kind: 'reasoning', itemId: 'r', text: 'summary', operation: 'replace',
    });
});

test('terminal null, empty and whitespace values are distinct; missing final is invalid', () => {
    for (const status of ['done', 'error', 'stopped']) {
        for (const finalText of [null, '', ' \n\t ', 'real final']) {
            assert.deepEqual(parse({ kind: 'turn-end', status, finalText }), { ...identity, kind: 'turn-end', status, finalText });
        }
    }
    for (const status of ['running', 'completed', undefined]) assert.equal(parse({ kind: 'turn-end', status, finalText: null }), null);
    for (const finalText of [undefined, 0, false, [], {}]) assert.equal(parse({ kind: 'turn-end', status: 'done', finalText }), null);
    assert.equal(parse({ kind: 'turn-end', status: 'error', finalText: null, error: {} }), null);
    assert.deepEqual(parse({ kind: 'turn-end', status: 'error', finalText: null, error: '' }), {
        ...identity, kind: 'turn-end', status: 'error', finalText: null, error: '',
    });
});

test('text bounds reject oversized strings without silently truncating', () => {
    for (const text of ['', 'x'.repeat(200_000)]) assert.equal(parse({ ...message, text })?.kind, 'message');
    for (const text of ['x'.repeat(200_001), null, 4, {}]) assert.equal(parse({ ...message, text }), null);
    assert.equal(parse({ kind: 'turn-end', status: 'done', finalText: 'x'.repeat(200_001) }), null);
});

test('tool fields preserve snapshots and only accept canonical statuses', () => {
    for (const status of ['running', 'done', 'error', 'stopped']) {
        const tool = { kind: 'tool', itemId: 'tool-1', name: 'command', status, input: '', output: 'one\ntwo', detail: '' };
        assert.deepEqual(parse(tool), { ...identity, ...tool });
    }
    const tool = { kind: 'tool', itemId: 'tool-1', name: 'command', status: 'running' };
    for (const key of ['input', 'output', 'detail']) {
        assert.equal(parse({ ...tool, [key]: null }), null);
        assert.equal(parse({ ...tool, [key]: 'x'.repeat(200_001) }), null);
    }
    for (const status of ['failed', 'completed', undefined]) assert.equal(parse({ ...tool, status }), null);
    for (const key of ['name', 'itemId']) assert.equal(parse({ ...tool, [key]: '' }), null);
});

test('usage accepts exact nonnegative integer counts, including zero, and no invented defaults', () => {
    assert.deepEqual(parse({ kind: 'usage' }), { ...identity, kind: 'usage' });
    const counts = { inputTokens: 0, outputTokens: 17, cachedTokens: Number.MAX_SAFE_INTEGER };
    assert.deepEqual(parse({ kind: 'usage', ...counts }), { ...identity, kind: 'usage', ...counts });
    for (const key of Object.keys(counts)) {
        for (const value of [-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
            assert.equal(parse({ kind: 'usage', [key]: value }), null);
        }
    }
});

test('turn-start and request-settled require bounded identifiers', () => {
    assert.deepEqual(parse({ kind: 'turn-start', provider: 'pi' }), { ...identity, kind: 'turn-start', provider: 'pi' });
    assert.equal(parse({ kind: 'turn-start', provider: '' }), null);
    assert.deepEqual(parse({ kind: 'request-settled', requestId: 'request-1' }), { ...identity, kind: 'request-settled', requestId: 'request-1' });
    assert.equal(parse({ kind: 'request-settled', requestId: 'x'.repeat(241) }), null);
});

test('both request subtypes decode and invalid request types or missing views reject', () => {
    for (const requestType of ['approval', 'question']) {
        const body = { kind: 'request', requestId: 'request-1', requestType, view: view() };
        assert.deepEqual(parse(body), { ...identity, ...body });
    }
    assert.equal(parse({ kind: 'request', requestId: 'request-1', requestType: 'other', view: view() }), null);
    for (const value of [null, undefined, [], {}]) assert.equal(request(value), null);
});

test('request fields/options must have unique IDs at their respective levels', () => {
    const field = view().fields[0]!;
    assert.equal(request({ title: 'Choose', fields: [field, { ...field }] }), null);
    assert.equal(request({ title: 'Choose', fields: [{ ...field, options: [field.options[0], field.options[0]] }] }), null);
    assert.ok(request({ title: 'Choose', fields: [field, { ...field, id: 'field-2' }] }), 'option IDs may repeat in distinct fields');
});

test('request cardinality, labels and booleans are validated at the boundary', () => {
    const field = view().fields[0]!;
    const fields = Array.from({ length: 8 }, (_, i) => ({ ...field, id: 'field-' + i,
        label: 'x'.repeat(500), options: Array.from({ length: 20 }, (_, j) => ({ id: 'option-' + j, label: 'y'.repeat(500) })) }));
    assert.ok(request({ title: 't'.repeat(500), fields }));
    assert.equal(request({ title: 't'.repeat(501), fields }), null);
    assert.equal(request({ title: 't', fields: [...fields, { ...field, id: 'extra' }] }), null);
    assert.equal(request({ title: 't', fields: [{ ...field, label: 'x'.repeat(501) }] }), null);
    assert.equal(request({ title: 't', fields: [{ ...field, options: Array.from({ length: 21 }, (_, i) => ({ id: 'o-' + i, label: 'x' })) }] }), null);
    for (const key of ['multiSelect', 'allowFreeform']) assert.equal(request({ title: 't', fields: [{ ...field, [key]: 1 }] }), null);
    assert.equal(request({ title: 't', fields: [{ ...field, options: [{ id: 'o', label: 'x'.repeat(501) }] }] }), null);
});

test('parser reconstructs a detached allowlist, not provider payload or extra identity', () => {
    const original = { ...identity, kind: 'request', requestId: 'request-1', requestType: 'question',
        nativeThreadId: 'native-thread', providerRefs: { token: 'opaque' }, callback: () => {},
        view: { ...view(), payload: 'secret', fields: [{ ...view().fields[0]!, nativeId: 'native-field',
            options: [{ id: 'option-1', label: 'First', nativeId: 'native-option', action: 'execute' }] }] } };
    const parsed = parseRuntimeEvent(original);
    assert.deepEqual(parsed, { ...identity, kind: 'request', requestId: 'request-1', requestType: 'question', view: view() });
    assert.ok(parsed?.kind === 'request');
    original.view.fields[0]!.options[0]!.label = 'mutated caller';
    assert.equal(parsed.view.fields[0]?.options[0]?.label, 'First');
    parsed.view.title = 'mutated result';
    assert.equal(original.view.title, 'Choose');
});

test('parsing is stateless: repeated seq and separate owners remain data, not reducer behavior', () => {
    const original = { ...identity, ...message };
    assert.deepEqual(parseRuntimeEvent(original), original);
    assert.deepEqual(parseRuntimeEvent(original), original);
    const other = { ...original, runId: 'run-b', scope: 'scope-b', seq: 19 };
    assert.deepEqual(parseRuntimeEvent(other), other);
    assert.equal(original.runId, 'run-a');
});
