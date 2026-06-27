import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TIER_DEFAULT_TIMEOUT_SEC,
    tierDefaultTimeoutSec,
    deriveTimeoutTier,
    resolveTimeoutDefaultSec,
} from '../../src/browser/web-ai/tier-timeout.js';

test('BWAI-TIER-001: tier table + lookup (deep-research/pro → 1h, unknown → 1200)', () => {
    assert.equal(TIER_DEFAULT_TIMEOUT_SEC['deep-research'], 3600);
    assert.equal(tierDefaultTimeoutSec('deep-research'), 3600);
    assert.equal(tierDefaultTimeoutSec('pro'), 3600);
    assert.equal(tierDefaultTimeoutSec('thinking'), 600);
    assert.equal(tierDefaultTimeoutSec('instant'), 120);
    assert.equal(tierDefaultTimeoutSec(null), 1200);
    assert.equal(tierDefaultTimeoutSec('bogus'), 1200);
});

test('BWAI-TIER-002: chatgpt deep-research resolves to a 1h default (catalog 105.4 bug)', () => {
    // research:'deep' → deep-research tier → 3600s, regardless of the model normalizer
    assert.equal(deriveTimeoutTier('chatgpt', undefined, 'deep'), 'deep-research');
    assert.equal(resolveTimeoutDefaultSec({ research: 'deep' }, 'chatgpt'), 3600);
    // no model/research → unknown tier → 1200s fallback (unchanged behavior)
    assert.equal(resolveTimeoutDefaultSec({}, 'chatgpt'), 1200);
});

test('BWAI-TIER-003: chatgpt model choices map to tiers', () => {
    assert.equal(resolveTimeoutDefaultSec({ model: 'pro' }, 'chatgpt'), 3600);
    assert.equal(resolveTimeoutDefaultSec({ model: 'instant' }, 'chatgpt'), 120);
    assert.equal(resolveTimeoutDefaultSec({ model: 'thinking' }, 'chatgpt'), 600);
});
