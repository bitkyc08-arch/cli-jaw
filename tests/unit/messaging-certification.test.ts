import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMessagingCertification } from '../../scripts/validate-messaging-certification.mts';

function valid() {
    return {
        schemaVersion: 1,
        commitSha: 'a'.repeat(40),
        nodeVersion: 'v24.0.0',
        certification: 'functional-certified',
        channels: {
            telegram: { conformance: 'pass', scenarios: [{ name: 'durable-ingress', traceId: 't', invariant: 'one-row', pass: true }] },
            slack: { conformance: 'pass', scenarios: [{ name: 'durable-ingress', traceId: 's', invariant: 'ack', pass: true }] },
            discord: { conformance: 'pass', scenarios: [{ name: 'durable-ingress', traceId: 'd', invariant: 'journal', pass: true }] },
        },
        ambiguousAutoRetryCount: 0,
        protectedEffectDuplicateCount: 0,
        deadLetterCountAfterReplay: 0,
    };
}

test('a complete functional artifact is valid', () => {
    assert.deepEqual(validateMessagingCertification(valid()), []);
});

test('release-certified is refused', () => {
    const row = valid();
    row.certification = 'release-certified';
    assert.ok(validateMessagingCertification(row).some((p) => p.includes('functional-certified')));
});

test('a missing channel is refused', () => {
    const row = valid() as Record<string, unknown>;
    const channels = { ...(row.channels as Record<string, unknown>) };
    delete channels.slack;
    row.channels = channels;
    assert.ok(validateMessagingCertification(row).some((p) => p.includes('slack')));
});
