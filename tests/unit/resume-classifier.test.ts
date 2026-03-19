import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldInvalidateResumeSession } from '../../src/agent/resume-classifier.ts';

test('resume classifier invalidates explicit stale Claude session errors', () => {
    const invalid = shouldInvalidateResumeSession(
        'claude',
        1,
        'No conversation found with session ID abc123',
        '',
    );
    assert.equal(invalid, true);
});

test('resume classifier invalidates generic invalid resume errors', () => {
    const invalid = shouldInvalidateResumeSession(
        'codex',
        1,
        'invalid resume target: session not found',
        '',
    );
    assert.equal(invalid, true);
});

test('resume classifier preserves session for recoverable 429 errors', () => {
    const invalid = shouldInvalidateResumeSession(
        'claude',
        1,
        'RESOURCE_EXHAUSTED: 429 rate limit exceeded',
        '',
    );
    assert.equal(invalid, false);
});

test('resume classifier preserves session for auth errors', () => {
    const invalid = shouldInvalidateResumeSession(
        'claude',
        1,
        'auth failed: credentials expired',
        '',
    );
    assert.equal(invalid, false);
});

test('resume classifier preserves session when no stale signal is present', () => {
    const invalid = shouldInvalidateResumeSession(
        'copilot',
        1,
        '',
        '',
    );
    assert.equal(invalid, false);
});
