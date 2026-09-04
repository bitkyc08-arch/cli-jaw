import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSlackThreadPlacement, resolveSlackThreadTs, slackTargetFromId } from '../../src/messaging/slack-target.ts';
import { buildRemoteBindingKey, buildRemoteSessionKey } from '../../src/messaging/session-key.ts';
import { deliveryTargetKey } from '../../src/messaging/turn-delivery.ts';
import { isRemoteTarget } from '../../src/messaging/types.ts';

// #520: a top-level Slack message has no thread_ts, so its OWN ts was promoted
// into the session key. Every such message therefore minted a fresh
// chat_sessions row — a table with no eviction, no TTL and no cap. One live
// database reached 186MB.
//
// The fix has to separate two questions that shared one value: WHERE a reply
// goes, and WHICH conversation this is.

function topLevel() {
    const p = resolveSlackThreadPlacement({ ts: '1000.1' }, true);
    return slackTargetFromId('C520', {
        ...(p.threadTs ? { threadTs: p.threadTs } : {}),
        ...(p.synthetic ? { threadIsSynthetic: true } : {}),
    });
}

test('STK-001: two top-level messages in one channel share one binding key', () => {
    const a = topLevel();
    const b = slackTargetFromId('C520', { threadTs: '2000.2', threadIsSynthetic: true });
    assert.equal(buildRemoteBindingKey(a), 'jaw:slack:channel:C520', 'no :thread: segment for a thread that does not exist');
    assert.equal(buildRemoteBindingKey(a), buildRemoteBindingKey(b), 'one channel conversation, not one per message');
});

test('STK-002: the reply address survives the fold', () => {
    // The whole risk of a naive fix: losing the ts means the reply can no longer
    // open a thread under the message it answers.
    const t = topLevel();
    assert.equal(t.threadId, '1000.1', 'the reply still knows where to go');
    assert.equal(t.threadIsSynthetic, true);
});

test('STK-003: a REAL thread keeps its own session', () => {
    const real = slackTargetFromId('C520', { threadTs: '1000.1' });
    assert.equal(buildRemoteBindingKey(real), 'jaw:slack:channel:C520:thread:1000.1');
    assert.equal(real.threadIsSynthetic, undefined, 'nothing synthetic about a thread that exists');
});

test('STK-004: delivery keys stay DISTINCT — the lane invariant is not folded', () => {
    // This is the assertion that catches the tempting wrong fix. Putting the
    // check inside the shared normalizedThreadId would fold buildRemoteSessionKey
    // too, and turn-delivery states plainly that a thread reply and a channel
    // post are different destinations. Two messages must not dedupe each other.
    const a = topLevel();
    const b = slackTargetFromId('C520', { threadTs: '2000.2', threadIsSynthetic: true });
    assert.notEqual(deliveryTargetKey(a), deliveryTargetKey(b), 'per-turn delivery must still tell them apart');
    assert.notEqual(buildRemoteSessionKey(a), buildRemoteSessionKey(b), 'and so must the session key that feeds it');
});

test('STK-005: resolveSlackThreadPlacement separates address from identity', () => {
    assert.deepEqual(resolveSlackThreadPlacement({ ts: '1.1' }, true), { threadTs: '1.1', synthetic: true });
    assert.deepEqual(resolveSlackThreadPlacement({ ts: '2.2', thread_ts: '1.1' }, true), { threadTs: '1.1', synthetic: false });
    assert.deepEqual(resolveSlackThreadPlacement({ ts: '1.1' }, false), { synthetic: false });
});

test('STK-006: the legacy resolver is unchanged for its own callers', () => {
    // Four existing tests pin this contract; the reply address it returns is
    // still correct, it simply no longer decides the session.
    assert.equal(resolveSlackThreadTs({ ts: '1.1' }, true), '1.1');
    assert.equal(resolveSlackThreadTs({ ts: '2.2', thread_ts: '1.1' }, true), '1.1');
    assert.equal(resolveSlackThreadTs({ ts: '1.1' }, false), undefined);
});

test('STK-007: a malformed flag never discards the address', () => {
    // Rejecting the whole target would send the reply down the last-active
    // fallback chain and into a different conversation (#474). A bad value must
    // degrade to "not synthetic", which is the safe default.
    const target = { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C520', threadId: '1.1', threadIsSynthetic: 'yes' };
    assert.equal(isRemoteTarget(target), true, 'the address is still valid and must be kept');
    assert.equal(buildRemoteBindingKey(target as never), 'jaw:slack:channel:C520:thread:1.1',
        'anything but true is not synthetic, so the thread keeps its own key');
});

test('STK-008: Telegram and Discord are untouched', () => {
    const tg = { channel: 'telegram', targetKind: 'user', peerKind: 'direct', targetId: '99', threadId: '7' } as const;
    const dc = { channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: 'D1', threadId: 'T9' } as const;
    assert.equal(buildRemoteBindingKey(tg), 'jaw:telegram:direct:99:thread:7');
    assert.equal(buildRemoteBindingKey(dc), 'jaw:discord:channel:D1:thread:T9');
});
