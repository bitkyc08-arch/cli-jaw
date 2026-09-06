import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { stringifyTraceValue } from '../../src/trace/redact.ts';
import { decodeRuntimeBody, RUNTIME_BODY_BYTES } from '../../src/trace/runtime-body-codec.ts';
import type { TraceEventInput, TracePointer } from '../../src/trace/types.ts';
import type { RuntimeEventContext } from '../../src/agent/runtime/events.ts';

const attempts: TraceEventInput[] = [];
const stored: unknown[] = [];
const publications: Array<{ topic: string; event: string; data: Record<string, unknown> }> = [];
let appendMode: 'ok' | 'null' | 'throw' = 'ok';

// Register before loading the real emitter: neither DB nor real event bus loads.
mock.module('../../src/trace/store.js', {
    namedExports: {
        appendTraceEvent: (entry: TraceEventInput): TracePointer | null => {
            attempts.push(structuredClone(entry));
            if (appendMode === 'null') return null;
            if (appendMode === 'throw') throw new Error('fixture append failure');
            // Model the existing writer's second redaction, not an identity stub.
            stored.push(JSON.parse(stringifyTraceValue(entry.raw)));
            return { traceRunId: 'pointer-run-not-an-identity-source', traceSeq: 7,
                detailAvailable: true, detailBytes: 100, rawRetentionStatus: 'available' };
        },
    },
});
mock.module('../../src/core/event-bus.js', {
    namedExports: {
        publish: (topic: string, event: string, data: Record<string, unknown>): void => {
            publications.push({ topic, event, data });
        },
    },
});
const { recordRuntimeEvent } = await import('../../src/agent/runtime/events.js');

test.beforeEach(() => {
    attempts.length = 0;
    stored.length = 0;
    publications.length = 0;
    appendMode = 'ok';
});
const context: RuntimeEventContext = {
    runId: 'run-owner', sessionId: 'jaw-chat', scope: 'mention-watch:separate-scope',
    turnId: 'jaw-turn', parentItemId: 'jaw-parent', audience: 'public',
};

test('public emitter allocates seq from append pointer and publishes the trusted context', () => {
    const body = { kind: 'message' as const, itemId: 'message-1', phase: 'unknown' as const,
        text: 'hello', operation: 'replace' as const };
    const result = recordRuntimeEvent(context, body);
    assert.deepEqual(result, {
        version: 1, runId: 'run-owner', sessionId: 'jaw-chat', scope: 'mention-watch:separate-scope',
        turnId: 'jaw-turn', parentItemId: 'jaw-parent', seq: 7, ...body,
    });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.runId, context.runId);
    assert.equal(attempts[0]?.source, 'runtime');
    assert.equal(attempts[0]?.eventType, 'message');
    assert.equal(attempts[0]?.preview, 'message');
    assert.deepEqual(publications, [{ topic: 'agent', event: 'agent_runtime', data: result }]);
    assert.equal(Object.hasOwn(result!, 'audience'), false);
});

test('stored redaction, decoded record and public event agree for JSON secrets and usage', () => {
    const body = { kind: 'tool' as const, itemId: 'tool-1', name: 'command', status: 'done' as const,
        input: '{"password":"input-canary","safe":1}',
        output: '[{"cookie":"output-canary"}]', detail: 'Bearer abcdefghijklmnop' };
    const result = recordRuntimeEvent(context, body);
    assert.ok(result?.kind === 'tool');
    assert.deepEqual(JSON.parse(result.input!), { password: '[REDACTED]', safe: 1 });
    assert.deepEqual(JSON.parse(result.output!), [{ cookie: '[REDACTED]' }]);
    assert.equal(result.detail, 'Bearer [REDACTED]');
    const owner = { version: 1 as const, runId: context.runId, sessionId: context.sessionId, scope: context.scope, seq: 7 };
    assert.deepEqual(decodeRuntimeBody(stored[0], owner, 'tool'), result);
    assert.deepEqual(publications[0]?.data, result);
    assert.ok(!JSON.stringify(attempts).includes('canary'));
    assert.ok(!JSON.stringify(stored).includes('canary'));
    assert.ok(!JSON.stringify(publications).includes('canary'));
    assert.equal(body.input, '{"password":"input-canary","safe":1}', 'original caller is not mutated');
    const usage = recordRuntimeEvent(context, { kind: 'usage', inputTokens: 0, outputTokens: 17, cachedTokens: 3 });
    assert.deepEqual(usage, { ...owner, turnId: context.turnId, parentItemId: 'jaw-parent',
        kind: 'usage', inputTokens: 0, outputTokens: 17, cachedTokens: 3 });
    assert.deepEqual(decodeRuntimeBody(stored[1], owner, 'usage'), usage);
});

test('internal audience records and returns an event but never publishes publicly', () => {
    const result = recordRuntimeEvent({ ...context, audience: 'internal' }, { kind: 'turn-start', provider: 'pi' });
    assert.equal(result?.seq, 7);
    assert.equal(result?.kind, 'turn-start');
    assert.equal(stored.length, 1);
    assert.deepEqual(publications, []);
});

for (const mode of ['null', 'throw'] as const) {
    test('append ' + mode + ' returns null and produces no canonical event', t => {
        t.mock.method(console, 'warn', () => {});
        appendMode = mode;
        assert.equal(recordRuntimeEvent(context, { kind: 'turn-end', status: 'done', finalText: 'final value' }), null);
        assert.equal(attempts.length, 1);
        assert.equal(stored.length, 0);
        assert.deepEqual(publications, []);
        // No wp05 gap/latch or lifecycle delivery assertion belongs in this test.
    });
}

test('byte-oversized payload is rejected before append or publish', () => {
    const text = '한'.repeat(Math.floor(RUNTIME_BODY_BYTES / 2));
    assert.ok(text.length < RUNTIME_BODY_BYTES);
    assert.ok(Buffer.byteLength(text, 'utf8') > RUNTIME_BODY_BYTES);
    assert.equal(recordRuntimeEvent(context, { kind: 'message', itemId: 'message-1',
        phase: 'unknown', operation: 'replace', text }), null);
    assert.deepEqual(attempts, []);
    assert.deepEqual(publications, []);
});

test('invalid trusted context cannot write or publish an event', t => {
    t.mock.method(console, 'warn', () => {});
    assert.equal(recordRuntimeEvent({ ...context, runId: '' }, { kind: 'usage', inputTokens: 1 }), null);
    assert.equal(recordRuntimeEvent({ ...context, parentItemId: '' }, { kind: 'usage', inputTokens: 1 }), null);
    assert.deepEqual(attempts, []);
    assert.deepEqual(publications, []);
});

test('emitter preserves null versus empty versus whitespace without selecting a final', () => {
    for (const finalText of [null, '', ' \n\t ']) {
        const result = recordRuntimeEvent(context, { kind: 'turn-end', status: 'done', finalText });
        assert.ok(result?.kind === 'turn-end');
        assert.equal(result.finalText, finalText);
        assert.equal(result.seq, 7);
        assert.deepEqual(decodeRuntimeBody(stored.at(-1), {
            version: 1, runId: context.runId, sessionId: context.sessionId, scope: context.scope, seq: 7,
        }, 'turn-end'), result);
    }
    assert.equal(publications.length, 3, 'one event per independent invocation, not a reducer test');
});

test('extra body identity cannot inject parent or override context at the emitter boundary', () => {
    const noParent = { ...context };
    delete noParent.parentItemId;
    const body = { kind: 'reasoning' as const, itemId: 'reasoning-1', text: 'summary', operation: 'append' as const,
        runId: 'forged', sessionId: 'forged', scope: 'forged', turnId: 'forged', seq: 999, parentItemId: 'forged' };
    const absent = recordRuntimeEvent(noParent, body);
    assert.ok(absent);
    assert.equal(Object.hasOwn(absent, 'parentItemId'), false);
    assert.equal(absent.runId, 'run-owner');
    const present = recordRuntimeEvent(context, body);
    assert.equal(present?.parentItemId, 'jaw-parent');
    assert.ok(!JSON.stringify(stored).includes('forged'));
    assert.ok(!JSON.stringify(publications).includes('forged'));
});

test('request emission uses the sanitized cloned view with no native callback fields', () => {
    const view = { title: '{"password":"title-canary"}', nativeRequest: 'native-request',
        fields: [{ id: 'jaw-field', label: 'Choose', multiSelect: false, allowFreeform: true,
            options: [{ id: 'jaw-option', label: 'Bearer abcdefghijklmnop', nativeOption: 'native-option', action: 'execute' }] }] };
    const result = recordRuntimeEvent(context, { kind: 'request', requestId: 'jaw-request', requestType: 'approval', view });
    assert.ok(result?.kind === 'request');
    assert.deepEqual(JSON.parse(result.view.title), { password: '[REDACTED]' });
    assert.deepEqual(result.view.fields[0]?.options, [{ id: 'jaw-option', label: 'Bearer [REDACTED]' }]);
    assert.ok(!JSON.stringify(stored).includes('native-'));
    assert.ok(!JSON.stringify(publications).includes('title-canary'));
    assert.equal(view.fields[0]!.options[0]!.label, 'Bearer abcdefghijklmnop');
    view.fields[0]!.options[0]!.label = 'caller mutation';
    assert.equal(result.view.fields[0]?.options[0]?.label, 'Bearer [REDACTED]');
});
