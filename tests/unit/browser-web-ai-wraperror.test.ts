import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapError, WebAiError } from '../../src/browser/web-ai/errors.js';

// 104.15: wrapError preserves the structured fields of a plain error-like object that
// already carries an errorCode, instead of flattening everything to internal.unhandled.
test('BWAI-WRAPERR-001: preserves errorCode/stage/retryHint/evidence from an error-like object', () => {
    const wrapped = wrapError({ errorCode: 'provider.poll-timeout', stage: 'poll', retryHint: 'retry', message: 'timed out', evidence: { a: 1 } });
    assert.equal(wrapped.errorCode, 'provider.poll-timeout');
    assert.equal(wrapped.stage, 'poll');
    assert.equal(wrapped.retryHint, 'retry');
    assert.equal(wrapped.message, 'timed out');
    assert.deepEqual(wrapped.evidence, { a: 1 });
});

test('BWAI-WRAPERR-002: plain Error still flattens; WebAiError passes through unchanged', () => {
    const wrapped = wrapError(new Error('boom'));
    assert.equal(wrapped.errorCode, 'internal.unhandled');
    assert.equal(wrapped.message, 'boom');

    const original = new WebAiError({ errorCode: 'x.y', stage: 's', message: 'm' });
    assert.equal(wrapError(original), original);

    // fallback overrides the preserved fields when provided
    const overridden = wrapError({ errorCode: 'a.b' }, { errorCode: 'c.d' });
    assert.equal(overridden.errorCode, 'c.d');
});
