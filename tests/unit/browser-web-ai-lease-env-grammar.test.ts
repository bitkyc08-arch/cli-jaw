// Cycle 1 slice 1.4 (parity2 010): provider-limit env grammar is strict digits-only
// (agbrowse tab-lease-store.mjs cdf93ce parity — silent fallback, strict grammar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderLimitEnv } from '../../src/browser/web-ai/tab-lease-store.ts';

test('LS-ENV1: plain decimal integers are honored', () => {
    assert.equal(parseProviderLimitEnv('7', 5), 7);
    assert.equal(parseProviderLimitEnv('0', 5, { allowZero: true }), 0);
});

test('LS-ENV2: garbage and non-decimal grammars fall back to the default', () => {
    assert.equal(parseProviderLimitEnv('banana', 5), 5);
    assert.equal(parseProviderLimitEnv('1e3', 5), 5);
    assert.equal(parseProviderLimitEnv('0x10', 5), 5);
    assert.equal(parseProviderLimitEnv('-3', 5), 5);
    assert.equal(parseProviderLimitEnv('3.5', 5), 5);
    assert.equal(parseProviderLimitEnv('', 5), 5);
    assert.equal(parseProviderLimitEnv(undefined, 5), 5);
});

test('LS-ENV3: zero rejected unless allowZero', () => {
    assert.equal(parseProviderLimitEnv('0', 5), 5);
    assert.equal(parseProviderLimitEnv('0', 5, { allowZero: true }), 0);
});

