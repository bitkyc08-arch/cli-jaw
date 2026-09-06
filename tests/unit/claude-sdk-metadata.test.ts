import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeMetadata } from '../../src/agent/runtime/claude-sdk-metadata.ts';
test('query cumulative costs become per-turn deltas with legitimate zero', () => {
    const read = createClaudeMetadata();
    assert.equal(read({ total_cost_usd: 1 }, true, 'sid').cost, 1);
    assert.equal(read({ total_cost_usd: 1.5 }, true, 'sid').cost, .5);
    assert.equal(read({ total_cost_usd: 1.5 }, true, 'sid').cost, 0);
});
test('unknown, negative, reset and failed costs never manufacture a zero or span a gap', () => {
    const read = createClaudeMetadata();
    read({ total_cost_usd: 1 }, true, 'sid');
    assert.equal(read({}, true, 'sid').cost, undefined);
    assert.equal(read({ total_cost_usd: 2 }, true, 'sid').cost, undefined);
    assert.equal(read({ total_cost_usd: 3 }, true, 'sid').cost, 1);
    assert.equal(read({ total_cost_usd: .5 }, true, 'sid').cost, undefined);
    assert.equal(read({ total_cost_usd: 4 }, false, 'sid').cost, undefined);
    assert.equal(read({ total_cost_usd: 5 }, true, 'sid').cost, undefined);
    assert.equal(read({ total_cost_usd: -1 }, true, 'sid').cost, undefined);
});
test('new or resumed SDK query has independent accounting and known usage fields only', () => {
    const old = createClaudeMetadata(); old({ total_cost_usd: 30 }, true, 'sid');
    const resumed = createClaudeMetadata();
    const result = resumed({ total_cost_usd: .25, usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5,
        cache_creation_input_tokens: 6, unknown: 99 } }, true, 'sid');
    assert.equal(result.cost, .25);
    assert.deepEqual(result.tokens, { input: 3, output: 4, cache_read: 5, cache_creation: 6 });
});
