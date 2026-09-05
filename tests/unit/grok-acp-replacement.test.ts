import test from 'node:test';
import assert from 'node:assert/strict';
import { GrokReplacement, GrokReplacementError } from '../../src/agent/runtime/acp/grok-control.ts';
import { AcpReplacement, AcpReplacementError } from '../../src/agent/runtime/acp/replacement.ts';

test('Grok compatibility exports preserve controller and fatal error identity', () => {
    assert.equal(GrokReplacement, AcpReplacement);
    assert.equal(GrokReplacementError, AcpReplacementError);
    assert.ok(new AcpReplacementError('cancel', new Error('fixture')) instanceof GrokReplacementError);
});
