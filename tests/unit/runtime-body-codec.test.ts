import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRuntimeBody, decodeRuntimeBody, redactRuntimeContent, sanitizeRuntimeRequestView } from '../../src/trace/runtime-body-codec.ts';
import { stringifyTraceValue, redactTraceValue } from '../../src/trace/redact.ts';
import type { RuntimeEventBody, RuntimeEventIdentity, RuntimeRequestView } from '../../src/shared/runtime-contract.ts';

const identity: RuntimeEventIdentity = {
    version: 1, runId: 'trusted-run', sessionId: 'trusted-chat', scope: 'trusted-scope',
    turnId: 'trusted-turn', seq: 7,
};
const message: RuntimeEventBody = {
    kind: 'message', itemId: 'message-1', phase: 'unknown', text: 'safe text', operation: 'replace',
};

test('encode rejects body parent injection when trusted identity has no parent', () => {
    const bodyWithExtraParent = { ...message, parentItemId: 'attacker-parent' };
    const encoded = encodeRuntimeBody(identity, bodyWithExtraParent);
    assert.equal(Object.hasOwn(encoded.raw, 'parentItemId'), false,
        'absence of a trusted parent must not be filled from an extra body property');
    assert.deepEqual(decodeRuntimeBody(encoded.raw, identity, 'message'), { ...identity, ...message });
});

test('encode trusted parent overrides a different injected body parent', () => {
    const trusted = { ...identity, parentItemId: 'trusted-parent' };
    const encoded = encodeRuntimeBody(trusted, { ...message, parentItemId: 'attacker-parent' });
    assert.equal(encoded.raw.parentItemId, 'trusted-parent');
    assert.deepEqual(decodeRuntimeBody(encoded.raw, identity, 'message'), { ...trusted, ...message });
});

test('decode absent raw parent does not inherit extra parent from a wider identity object', () => {
    const raw = { turnId: 'stored-turn', fields: Object.entries(message) };
    const widerIdentity = { ...identity, turnId: 'not-the-stored-turn', parentItemId: 'attacker-parent' };
    const decoded = decodeRuntimeBody(raw, widerIdentity, 'message');
    assert.ok(decoded);
    assert.equal(Object.hasOwn(decoded, 'parentItemId'), false,
        'raw absence is authoritative even when the caller has an extra parent property');
    assert.deepEqual(decoded, { ...identity, turnId: 'stored-turn', ...message });
});

function view(): RuntimeRequestView {
    return { title: '[docs](https://example.test)', fields: [{ id: 'field-1', label: 'Choose',
        options: [{ id: 'option-1', label: '[ -f file ]' }], multiSelect: false, allowFreeform: true }] };
}
// Eight event discriminants, with both request subtypes: nine payload shapes.
const variants: RuntimeEventBody[] = [
    { kind: 'turn-start', provider: 'codex-app' },
    message,
    { kind: 'reasoning', itemId: 'reasoning-1', text: 'summary', operation: 'append' },
    { kind: 'tool', itemId: 'tool-1', name: 'command', status: 'done', input: '[ -f file ]', output: '', detail: 'complete' },
    { kind: 'request', requestId: 'approval-1', requestType: 'approval', view: view() },
    { kind: 'request', requestId: 'question-1', requestType: 'question', view: view() },
    { kind: 'request-settled', requestId: 'request-1' },
    { kind: 'usage', inputTokens: 17, outputTokens: 0, cachedTokens: 4 },
    { kind: 'turn-end', status: 'stopped', finalText: null, error: 'cancelled' },
];
for (const body of variants) {
    test('round-trips through actual trace redaction: ' + body.kind + ('requestType' in body ? ':' + body.requestType : ''), () => {
        const owner = { ...identity, parentItemId: 'trusted-parent' };
        const before = structuredClone(body);
        const encoded = encodeRuntimeBody(owner, body);
        const stored: unknown = JSON.parse(stringifyTraceValue(encoded.raw));
        const storedAgain: unknown = JSON.parse(stringifyTraceValue(stored));
        assert.deepEqual(storedAgain, stored, 'second raw-writer redaction is idempotent');
        assert.deepEqual(decodeRuntimeBody(storedAgain, identity, body.kind), { ...owner, ...body });
        assert.deepEqual(body, before, 'encoding must not mutate caller payloads');
        assert.deepEqual(Object.keys(encoded.raw).sort(), ['fields', 'parentItemId', 'turnId']);
        for (const key of ['version', 'runId', 'sessionId', 'scope', 'seq', 'providerRefs', 'parentItemId', 'turnId']) {
            assert.ok(!encoded.raw.fields.some(([field]) => field === key), key + ' is not a body tuple');
        }
    });
}

test('numeric usage survives object-key redaction without weakening global policy', () => {
    const counts = { inputTokens: 0, outputTokens: 23, cachedTokens: 7 };
    assert.deepEqual(redactTraceValue(counts), { inputTokens: '[REDACTED]', outputTokens: '[REDACTED]', cachedTokens: '[REDACTED]' });
    const body: RuntimeEventBody = { kind: 'usage', ...counts };
    const encoded = encodeRuntimeBody(identity, body);
    assert.deepEqual(Object.fromEntries(encoded.raw.fields), body);
    assert.deepEqual(decodeRuntimeBody(JSON.parse(stringifyTraceValue(encoded.raw)), identity, 'usage'), { ...identity, ...body });
});

test('extra body identity cannot override any trusted identity or enter stored fields', () => {
    const forged = { ...message, version: 99, runId: 'forged-run', sessionId: 'forged-chat',
        scope: 'forged-scope', turnId: 'forged-turn', seq: 999, providerRefs: { id: 'native-only' } };
    const encoded = encodeRuntimeBody(identity, forged);
    assert.deepEqual(encoded.body, message);
    assert.deepEqual(decodeRuntimeBody(encoded.raw, identity, 'message'), { ...identity, ...message });
    assert.ok(!JSON.stringify(encoded.raw).includes('forged'));
    assert.ok(!JSON.stringify(encoded.raw).includes('native-only'));
});

test('decoder rejects malformed, duplicate, unknown and identity tuples before reconstruction', () => {
    const fields = Object.entries(message);
    const invalid: unknown[] = [null, [], 'raw', {}, { turnId: '', fields }, { turnId: 'x'.repeat(241), fields },
        { turnId: 't', fields: 'bad' }, { turnId: 't', fields: [null] },
        { turnId: 't', fields: [['kind']] }, { turnId: 't', fields: [['kind', 'message', 'extra']] },
        { turnId: 't', fields: [[1, 'message']] }, { turnId: 't', fields: [...fields, ['kind', 'tool']] },
        { turnId: 't', fields: [['kind', 'future']] }, { turnId: 't', fields, extra: true },
        { turnId: 't', fields, parentItemId: null }, { turnId: 't', fields, parentItemId: '' },
        { turnId: 't', fields: Array.from({ length: 9 }, (_, i) => ['key-' + i, i]) }];
    for (const key of ['runId', 'sessionId', 'scope', 'seq', 'version', 'parentItemId', 'turnId', 'providerRefs', '__proto__', 'constructor', 'prototype']) {
        invalid.push({ turnId: 't', fields: [...fields, [key, { polluted: true }]] });
    }
    for (const raw of invalid) assert.equal(decodeRuntimeBody(raw, identity, 'message'), null, JSON.stringify(raw));
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
    assert.equal(decodeRuntimeBody({ turnId: 't', fields }, identity, 'tool'), null);
    assert.equal(decodeRuntimeBody({ turnId: 't', fields }, { ...identity, seq: 0 }, 'message'), null);
});

test('invalid canonical data fails before encoding rather than manufacturing a body', () => {
    assert.throws(() => encodeRuntimeBody({ ...identity, seq: 0 }, message), /invalid_runtime_event/);
    assert.throws(() => encodeRuntimeBody(identity, { kind: 'tool', itemId: '', name: 'tool', status: 'done' }), /invalid_runtime_event/);
    const fields = [['kind', 'turn-end'], ['status', 'running'], ['finalText', null]];
    assert.equal(decodeRuntimeBody({ turnId: 't', fields }, identity, 'turn-end'), null);
});

const prose = [
    '', ' \n\t ', '[docs](https://example.test)', '[1] citation', '{brace prose}', '[ -f file ]',
    '```ts\nconst x = { safe: true };\n```', 'First paragraph.\r\n\r\n둘째 문단 e\u0301 😀',
    '  {\r\n  "safe":  1,\r\n  "list": [1, 2]\r\n}\r\n', '```json\n{ "safe": 1 }\n```',
];
for (const text of prose) {
    test('default content and final retain exact prose/JSON bytes: ' + JSON.stringify(text), () => {
        assert.equal(redactRuntimeContent(text), text);
        const body: RuntimeEventBody = { kind: 'turn-end', status: 'done', finalText: text };
        const encoded = encodeRuntimeBody(identity, body);
        assert.deepEqual(decodeRuntimeBody(JSON.parse(stringifyTraceValue(encoded.raw)), identity, 'turn-end'), { ...identity, ...body });
    });
}

test('null remains absent, not empty, through the codec', () => {
    const body: RuntimeEventBody = { kind: 'turn-end', status: 'done', finalText: null };
    const encoded = encodeRuntimeBody(identity, body);
    assert.deepEqual(decodeRuntimeBody(encoded.raw, identity, 'turn-end'), { ...identity, ...body });
});

test('only explicit structured mode withholds incomplete JSON; complete later snapshot redacts', () => {
    for (const partial of ['{"password":"piece', '[{"password":"piece', '```json\n{"password":"piece']) {
        assert.equal(redactRuntimeContent(partial), partial, 'prose mode never guesses from punctuation');
        assert.equal(redactRuntimeContent(partial, { structured: true }), '[structured content withheld]');
    }
    const full = '[{"password":"whole-canary","safe":1}]';
    assert.deepEqual(JSON.parse(redactRuntimeContent(full, { structured: true })), [{ password: '[REDACTED]', safe: 1 }]);
});

test('structured secrets, escaped keys and shadowed duplicate secrets are redacted idempotently', () => {
    const samples = [
        '{"password":"first-canary","password":"second-canary"}',
        '{"pass\\u0077ord":"escaped-canary"}',
        '{"pass\\u0077ord":"shadow-canary","password":"[REDACTED]"}',
        '{"safe":{"cookie":"cookie-canary"},"items":[{"api_key":"key-canary"},{"token":"token-canary"}]}',
        '```json\n{"password":"fenced-canary"}\n```',
    ];
    for (const source of samples) {
        const safe = redactRuntimeContent(source, { structured: true });
        assert.ok(!safe.includes('canary'), safe);
        assert.ok(safe.includes('[REDACTED]'));
        assert.equal(redactRuntimeContent(safe, { structured: true }), safe);
        const body: RuntimeEventBody = { kind: 'tool', itemId: 'tool-1', name: 'tool', status: 'done', input: source, output: source, detail: source };
        const encoded = encodeRuntimeBody(identity, body);
        const stored = JSON.parse(stringifyTraceValue(encoded.raw));
        assert.ok(!JSON.stringify(stored).includes('canary'));
        assert.ok(!JSON.stringify(decodeRuntimeBody(stored, identity, 'tool')).includes('canary'));
    }
});

test('ordinary token patterns are masked in prose and final error text', () => {
    const source = 'Use Bearer abcdefghijklmnop and PASSWORD=plain-canary';
    assert.equal(redactRuntimeContent(source), 'Use Bearer [REDACTED] and PASSWORD=[REDACTED]');
    const encoded = encodeRuntimeBody(identity, { kind: 'turn-end', status: 'error', finalText: source, error: source });
    assert.ok(!JSON.stringify(encoded.raw).includes('abcdefghijklmnop'));
    assert.ok(!JSON.stringify(encoded.raw).includes('plain-canary'));
});

test('safe request view redacts complete labels before clipping and clones only whitelisted fields', () => {
    const canary = 'ordinaryValueCanaryBeforeTheCap';
    const label = JSON.stringify({ password: canary, padding: 'x'.repeat(1200) });
    const original = { title: label, nativePayload: 'private', fields: [{ id: 'jaw-field', label,
        nativeId: 'native-field', options: [{ id: 'jaw-option', label, nativeId: 'native-option', action: () => {} }],
        multiSelect: true, allowFreeform: false }] };
    const safe = sanitizeRuntimeRequestView(original);
    assert.ok(safe);
    assert.ok(safe.title.length <= 500 && safe.title.includes('[REDACTED]'));
    assert.ok(safe.fields[0]!.label.length <= 500 && safe.fields[0]!.options[0]!.label.length <= 500);
    assert.ok(!JSON.stringify(safe).includes(canary));
    assert.ok(!JSON.stringify(safe).includes('native-'));
    assert.deepEqual(Object.keys(safe).sort(), ['fields', 'title']);
    assert.deepEqual(Object.keys(safe.fields[0]!).sort(), ['allowFreeform', 'id', 'label', 'multiSelect', 'options']);
    assert.deepEqual(Object.keys(safe.fields[0]!.options[0]!).sort(), ['id', 'label']);
    assert.deepEqual(sanitizeRuntimeRequestView(safe), safe);
    original.fields[0]!.options[0]!.label = 'caller mutation';
    assert.notEqual(safe.fields[0]!.options[0]!.label, 'caller mutation');
    safe.fields[0]!.label = 'result mutation';
    assert.equal(original.fields[0]!.label, label);
});

test('request sanitizer preserves Markdown, avoids splitting surrogate pairs and validates identifiers', () => {
    assert.deepEqual(sanitizeRuntimeRequestView(view()), view());
    assert.equal(sanitizeRuntimeRequestView({ title: 'a'.repeat(498) + '😀' + 'b'.repeat(50), fields: [] })?.title, 'a'.repeat(498) + '…');
    const field = view().fields[0]!;
    for (const id of ['', 'bad/id', 'has space', '__proto__', 'x'.repeat(241)]) {
        assert.equal(sanitizeRuntimeRequestView({ title: 't', fields: [{ ...field, id }] }), null);
        assert.equal(sanitizeRuntimeRequestView({ title: 't', fields: [{ ...field, options: [{ id, label: 'x' }] }] }), null);
    }
    assert.equal(sanitizeRuntimeRequestView({ title: 't', fields: [field, field] }), null);
    assert.equal(sanitizeRuntimeRequestView({ title: 't', fields: [{ ...field, options: [field.options[0], field.options[0]] }] }), null);
    assert.equal(sanitizeRuntimeRequestView({ title: 't', fields: Array.from({ length: 9 }, (_, i) => ({ ...field, id: 'f-' + i })) }), null);
    assert.equal(sanitizeRuntimeRequestView({ title: 't', fields: [{ ...field, options: Array.from({ length: 21 }, (_, i) => ({ id: 'o-' + i, label: 'x' })) }] }), null);
    assert.equal(sanitizeRuntimeRequestView({ title: 't', fields: [{ ...field, multiSelect: 'yes' }] }), null);
    assert.equal(sanitizeRuntimeRequestView(null), null);
});
