import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLegacyA1Migration } from '../../src/prompt/builder.js';

test('PLM-001: current source hash adopts current template', () => {
    const action = resolveLegacyA1Migration({
        normalizedFileHash: 'abc',
        currentSourceHash: 'abc',
        knownSourceHashes: new Set(['old']),
    });
    assert.equal(action, 'adopt-current-template');
});

test('PLM-002: known old stock hash adopts current template', () => {
    const action = resolveLegacyA1Migration({
        normalizedFileHash: '70ff952b074ad95f6a6f1f40f59bde09',
        currentSourceHash: 'current',
        knownSourceHashes: new Set(['70ff952b074ad95f6a6f1f40f59bde09']),
    });
    assert.equal(action, 'adopt-current-template');
});

test('PLM-003: unknown hash preserves custom file', () => {
    const action = resolveLegacyA1Migration({
        normalizedFileHash: 'custom',
        currentSourceHash: 'current',
        knownSourceHashes: new Set(['old']),
    });
    assert.equal(action, 'preserve-custom-file');
});
