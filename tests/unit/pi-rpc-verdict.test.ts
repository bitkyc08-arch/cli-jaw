import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySecondPromptOutcome } from '../../src/agent/pi-rpc-verdict.ts';

const base = {
    secondPromptId: 3,
    timedOut: false,
    selfExited: false,
    firstPromptSucceeded: true,
};

test('provider errors correlated to the second prompt are inconclusive', () => {
    for (const message of ['rate limit', '502 Bad Gateway']) {
        assert.equal(classifySecondPromptOutcome({
            ...base,
            records: [{ id: 3, error: { message } }],
        }), 'inconclusive');
    }
});

test('protocol-looking errors with a mismatched id are inconclusive', () => {
    assert.equal(classifySecondPromptOutcome({
        ...base,
        records: [{ id: 2, error: { message: 'unknown type' } }],
    }), 'inconclusive');
});

test('protocol rejection correlated to the second prompt is proven unsupported', () => {
    assert.equal(classifySecondPromptOutcome({
        ...base,
        records: [{ id: 3, error: { message: 'unknown type: prompt' } }],
    }), 'proven-unsupported');
});

test('self-exit after the first prompt is proven unsupported', () => {
    assert.equal(classifySecondPromptOutcome({
        ...base,
        records: [],
        selfExited: true,
    }), 'proven-unsupported');
});

test('SECOND text on an agent_end-normalized record is supported', () => {
    assert.equal(classifySecondPromptOutcome({
        ...base,
        records: [
            { id: 3, type: 'response', command: 'prompt', success: true },
            { type: 'agent_end', done: true, text: 'SECOND' },
        ],
    }), 'supported');
});

test('thinking-only agent_end with SECOND user echo and acceptance is supported (model nondeterminism)', () => {
    assert.equal(classifySecondPromptOutcome({
        ...base,
        records: [
            { id: 3, type: 'response', command: 'prompt', success: true },
            { type: 'agent_end', done: true, userEcho: 'Reply with the single token: SECOND' },
        ],
    }), 'supported');
});

test('done without id-correlated acceptance is inconclusive', () => {
    assert.equal(classifySecondPromptOutcome({
        ...base,
        records: [{ type: 'agent_end', done: true, text: 'SECOND' }],
    }), 'inconclusive');
});

test('acceptance without a completed second turn is inconclusive', () => {
    assert.equal(classifySecondPromptOutcome({
        ...base,
        records: [{ id: 3, type: 'response', command: 'prompt', success: true }],
    }), 'inconclusive');
});

test('a failed first prompt makes the result inconclusive', () => {
    assert.equal(classifySecondPromptOutcome({
        ...base,
        records: [{ done: true, text: 'SECOND' }],
        firstPromptSucceeded: false,
    }), 'inconclusive');
});
