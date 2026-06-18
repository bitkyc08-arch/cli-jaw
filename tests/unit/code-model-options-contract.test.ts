import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJwcModelOptions } from '../../src/code-mode/model-options.ts';

test('code model options return authenticated providers without unauthenticated additions', () => {
    const options = buildJwcModelOptions(['cursor', 'xai']);

    assert.deepEqual(options.providers.map(provider => provider.id), ['cursor', 'xai']);
    assert.equal(options.defaultProvider, 'cursor');
    assert.equal(options.degraded, undefined);
    assert.equal(options.error, undefined);
});

test('code model options use top-level degraded fallback when auth discovery is empty', () => {
    const options = buildJwcModelOptions([]);

    assert.deepEqual(options.providers.map(provider => provider.id), ['anthropic']);
    assert.equal(options.defaultProvider, 'anthropic');
    assert.equal(options.degraded, true);
    assert.match(options.error ?? '', /No authenticated JWC providers/);
});

test('code model options preserve auth discovery errors on degraded fallback', () => {
    const options = buildJwcModelOptions([], 'auth storage unavailable');

    assert.deepEqual(options.providers.map(provider => provider.id), ['anthropic']);
    assert.equal(options.degraded, true);
    assert.equal(options.error, 'auth storage unavailable');
});
