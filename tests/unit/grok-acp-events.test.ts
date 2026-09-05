import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { grokUsage } from '../../src/agent/runtime/acp/grok-events.ts';

test('captured two-model-call tool turn uses aggregate usage, not last-call top-level counters', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/grok-acp-read-file.json', import.meta.url), 'utf8'));
    assert.equal(fixture.result._meta.inputTokens, 17610);
    assert.deepEqual(grokUsage(fixture.result), { kind: 'usage', inputTokens: 35136, outputTokens: 123, cachedTokens: 17408 });
});

test('Grok original-response usage maps observed fields without summing cached input twice', () => {
    assert.deepEqual(grokUsage({ stopReason: 'end_turn', _meta: { usage: {
        inputTokens: 17579, outputTokens: 45, cachedReadTokens: 17408, totalTokens: 17624,
        reasoningTokens: 31, costUsdTicks: 15837200, modelUsage: { private: 'ignored' },
    } } }), { kind: 'usage', inputTokens: 17579, outputTokens: 45, cachedTokens: 17408 });
    assert.deepEqual(grokUsage({ _meta: { usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 } } }),
        { kind: 'usage', inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    assert.deepEqual(grokUsage({ _meta: { usage: { outputTokens: 7 } } }), { kind: 'usage', outputTokens: 7 });
});

test('missing usage remains absent; session context, totals and extensions do not become token counts', () => {
    for (const result of [{}, { _meta: {} }, { _meta: { usage: {} } },
        { used: 5000, size: 500000 }, { usage: { inputTokens: 123 } },
        { _meta: { inputTokens: 123 } }, { agentResult: { usage: { outputTokens: 12 } } },
        { _meta: { usage: { totalTokens: 10, reasoningTokens: 4, cachedTokens: 5 } } }]) {
        assert.equal(grokUsage(result), null);
    }
});

test('malformed optional counts omit the whole usage event without throwing or returning partial counters', () => {
    for (const key of ['inputTokens', 'outputTokens', 'cachedReadTokens']) {
        for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, 'secret-invalid-count', null]) {
            assert.equal(grokUsage({ _meta: { usage: { inputTokens: 1, [key]: value } } }), null);
        }
    }
    for (const result of [{ _meta: [] }, { _meta: 'bad' }, { _meta: { usage: [] } }, { _meta: { usage: 'bad' } }]) {
        assert.equal(grokUsage(result), null);
    }
});
