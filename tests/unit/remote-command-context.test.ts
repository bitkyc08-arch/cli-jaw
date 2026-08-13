// RemoteCommandContext resolver (M4-A0). Transports do not call this yet.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRemoteCommandContext } from '../../src/messaging/remote-command-context.ts';

test('complete input becomes a context', () => {
    const result = resolveRemoteCommandContext({
        channel: 'telegram',
        actorId: 'U1',
        conversationKey: 'telegram:C1',
        chatSessionId: 's1',
        generation: 0,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.deepEqual(result.context, {
            channel: 'telegram',
            actorId: 'U1',
            conversationKey: 'telegram:C1',
            chatSessionId: 's1',
            generation: 0,
        });
    }
});

test('missing fields are a typed refusal', () => {
    assert.deepEqual(resolveRemoteCommandContext({ channel: 'slack' }), {
        ok: false, reason: 'missing_field', field: 'actorId',
    });
    assert.deepEqual(resolveRemoteCommandContext({
        channel: 'discord', actorId: 'U1', conversationKey: 'd:C', chatSessionId: 's1',
    }), { ok: false, reason: 'missing_field', field: 'generation' });
    assert.deepEqual(resolveRemoteCommandContext({
        channel: 'discord', actorId: 'U1', conversationKey: 'd:C', chatSessionId: 's1', generation: -1,
    }), { ok: false, reason: 'missing_field', field: 'generation' });
});
