import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelSelectionEvidence } from '../../src/browser/web-ai/chatgpt-model.js';

// 104.5: selectChatGptModel now yields structured, persistable model-selection evidence.
test('BWAI-MODELSEL-001: evidence captures requested vs resolved + verification status', () => {
    const verified = createModelSelectionEvidence({ requestedModel: 'pro', resolvedLabel: 'pro', normalizedModel: 'pro', verified: true });
    assert.equal(verified.requestedModel, 'pro');
    assert.equal(verified.resolvedLabel, 'pro');
    assert.equal(verified.normalizedModel, 'pro');
    assert.equal(verified.strategy, 'select');
    assert.equal(verified.status, 'verified');
    assert.equal(verified.verified, true);
    assert.equal(verified.source, 'chatgpt-model-picker');
    assert.ok(verified.capturedAt);

    const unverified = createModelSelectionEvidence({ requestedModel: 'thinking', resolvedLabel: null, normalizedModel: 'thinking', verified: false });
    assert.equal(unverified.status, 'unverified');
    assert.equal(unverified.verified, false);
    assert.equal(unverified.resolvedLabel, null);

    // omitted inputs default to null
    const empty = createModelSelectionEvidence({ verified: false });
    assert.equal(empty.requestedModel, null);
    assert.equal(empty.normalizedModel, null);
});
