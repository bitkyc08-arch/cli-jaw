// ─── ChannelAdapter conformance suite ────────────────
// One suite, every adapter. The point is to make a capability declaration
// falsifiable: a `true` must survive an actual call, and a `false` must produce an
// explicit refusal without touching the vendor. A channel that cannot do something
// is fine; a channel that CLAIMS it can and cannot is what this catches.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CAPABILITY_METHODS,
    CAPABILITY_OPERATIONS,
    PROPERTY_CAPABILITY_KEYS,
    refuseUndeclared,
    type AdapterInteractiveRequest,
    type ChannelAdapter,
    type OperationCapabilityKey,
} from '../../src/messaging/channel-adapter.ts';
import {
    CHANNEL_CAPABILITY_KEYS,
    capabilitiesFor,
    type ChannelCapabilities,
} from '../../src/messaging/channel-capabilities.ts';
import { unsupportedReceipt, type DeliveryReceipt } from '../../src/messaging/delivery-outcome.ts';
import type { MessengerChannel, RemoteTarget } from '../../src/messaging/types.ts';
import { transportStarted, type TransportStartOutcome } from '../../src/messaging/runtime.ts';

const CHANNELS = ['telegram', 'discord', 'slack'] as const;

const ACCOUNT_IDS: Record<MessengerChannel, string> = {
    telegram: '1234567890',
    discord: '9876543210',
    slack: 'T01234567',
};

function targetFor(channel: MessengerChannel): RemoteTarget {
    return channel === 'telegram'
        ? { channel, targetKind: 'channel', peerKind: 'group', targetId: '-100999' }
        : channel === 'discord'
        ? { channel, targetKind: 'channel', peerKind: 'channel', targetId: 'D999', guildId: 'G1' }
        : { channel, targetKind: 'channel', peerKind: 'channel', targetId: 'C999' };
}

/** Records every vendor call so a `false` capability can be proven to make none. */
type VendorLog = { calls: string[] };

/**
 * A reference adapter driven entirely by the real capability declaration. It stands
 * in for the vendor transport, not for the contract: the declaration, the refusal
 * rule and the receipt shape under test are the shipped ones. Wiring the three live
 * transports into this port is the next migration step; until then this proves the
 * contract itself holds and that every declared capability has a reachable method.
 */
function referenceAdapter(channel: MessengerChannel, vendor: VendorLog): ChannelAdapter {
    const capabilities: ChannelCapabilities = capabilitiesFor(channel);
    const accountId = ACCOUNT_IDS[channel];
    const base = { channel, accountId, capabilities };

    const sent = (id: string, target: RemoteTarget): DeliveryReceipt => ({
        channel,
        accountId,
        platformMessageId: id,
        ...(target.threadId ? { threadId: target.threadId } : {}),
        status: 'sent',
        ambiguous: false,
    });

    const perform = async (
        key: OperationCapabilityKey,
        target: RemoteTarget,
    ): Promise<DeliveryReceipt> => {
        const refusal = refuseUndeclared(base, key);
        if (refusal) return refusal;
        if (target.channel !== channel) {
            return {
                channel,
                accountId,
                platformMessageId: null,
                status: 'failed',
                ambiguous: false,
                failure: { kind: 'format', retryAfterMs: 0, message: 'channel_target_mismatch' },
            };
        }
        vendor.calls.push(key);
        return sent(`${channel}-msg-1`, target);
    };

    return {
        channel,
        capabilities,
        accountId,
        start: async (): Promise<TransportStartOutcome> => transportStarted,
        stop: async () => {},
        health: () => ({ configured: true, activeInbound: true, sendCapable: true }),
        sendText: req => perform('sendText', req.target),
        editText: req => perform('editText', req.target),
        deleteMessage: req => perform('deleteMessage', req.target),
        addReaction: req => perform('reaction', req.target),
        setTyping: req => perform('typing', req.target),
        uploadFile: req => perform('fileUpload', req.target),
        sendVoice: req => perform('voice', req.target),
        sendInteractive: async (req: AdapterInteractiveRequest) => {
            const refusal = refuseUndeclared(base, 'interactiveActions');
            // The caller opting into a lesser delivery is the only way a false
            // capability still sends. It is recorded on the receipt, never silent.
            if (refusal && req.fallback !== 'text') return refusal;
            vendor.calls.push(refusal ? 'interactiveActions:text-fallback' : 'interactiveActions');
            const receipt = sent(`${channel}-msg-1`, req.target);
            return refusal
                ? { ...receipt, downgraded: { operation: 'interactiveActions' as const, to: 'text' as const } }
                : receipt;
        },
    };
}

function requestFor(key: OperationCapabilityKey, target: RemoteTarget) {
    switch (key) {
        case 'sendText':
            return { target, text: 'hello' };
        case 'editText':
            return { target, platformMessageId: 'm1', text: 'edited' };
        case 'deleteMessage':
            return { target, platformMessageId: 'm1' };
        case 'reaction':
            return { target, platformMessageId: 'm1', emoji: '+1' };
        case 'typing':
            return { target };
        case 'fileUpload':
        case 'voice':
            return { target, filePath: '/tmp/whatever' };
        case 'interactiveActions':
            return { target, text: 'pick one', actions: [{ id: 'a' }] };
    }
}

async function callOperation(
    adapter: ChannelAdapter,
    key: OperationCapabilityKey,
    target: RemoteTarget,
): Promise<DeliveryReceipt> {
    const method = CAPABILITY_METHODS[key];
    const request = requestFor(key, target) as never;
    return (adapter[method] as (req: never) => Promise<DeliveryReceipt>)(request);
}

// ─── The contract itself ────────────────────────────

test('capability key set is partitioned into operations and properties, with nothing left over', () => {
    const operations = Object.keys(CAPABILITY_OPERATIONS).sort();
    const properties = [...PROPERTY_CAPABILITY_KEYS].sort();
    assert.deepEqual(
        [...operations, ...properties].sort(),
        [...CHANNEL_CAPABILITY_KEYS].sort(),
        'every capability key must be either a callable operation or a declared property',
    );
    // A key in both halves would let an operation hide behind a property test.
    assert.deepEqual(operations.filter(k => properties.includes(k)), []);
});

test('every operation capability names a method that exists on the adapter', () => {
    const adapter = referenceAdapter('telegram', { calls: [] });
    for (const key of Object.keys(CAPABILITY_OPERATIONS) as OperationCapabilityKey[]) {
        const method = CAPABILITY_METHODS[key];
        assert.equal(typeof adapter[method], 'function', `${key} maps to a missing method ${method}`);
    }
});

test('unsupportedReceipt is a refusal, not a delivery failure', () => {
    const receipt = unsupportedReceipt('slack', 'T1', 'interactiveActions');
    assert.equal(receipt.status, 'unsupported');
    assert.equal(receipt.platformMessageId, null);
    // Nothing was dispatched, so there is no doubt about what reached the vendor,
    // and attaching a DeliveryFailure would invite a retry of a call never made.
    assert.equal(receipt.ambiguous, false);
    assert.equal(receipt.failure, undefined);
    assert.deepEqual(receipt.unsupported, {
        operation: 'interactiveActions',
        reason: 'capability_not_declared',
    });
});

// ─── Per-channel conformance ────────────────────────

for (const channel of CHANNELS) {
    test(`${channel}: declares every closed capability key and no extra key`, () => {
        const declared = Object.keys(capabilitiesFor(channel)).sort();
        assert.deepEqual(declared, [...CHANNEL_CAPABILITY_KEYS].sort());
    });

    test(`${channel}: a true capability never returns unsupported for a valid request`, async () => {
        const vendor: VendorLog = { calls: [] };
        const adapter = referenceAdapter(channel, vendor);
        const target = targetFor(channel);
        for (const key of Object.keys(CAPABILITY_OPERATIONS) as OperationCapabilityKey[]) {
            if (!adapter.capabilities[key]) continue;
            const receipt = await callOperation(adapter, key, target);
            assert.equal(receipt.status, 'sent', `${channel}.${key} declared true but did not send`);
            assert.equal(receipt.channel, channel);
            assert.equal(receipt.accountId, ACCOUNT_IDS[channel]);
            assert.notEqual(receipt.platformMessageId, null, 'a sent receipt must carry a message id');
        }
    });

    test(`${channel}: a false capability refuses without a vendor call`, async () => {
        const vendor: VendorLog = { calls: [] };
        const adapter = referenceAdapter(channel, vendor);
        const target = targetFor(channel);
        let checked = 0;
        for (const key of Object.keys(CAPABILITY_OPERATIONS) as OperationCapabilityKey[]) {
            if (adapter.capabilities[key]) continue;
            const receipt = await callOperation(adapter, key, target);
            checked++;
            assert.equal(receipt.status, 'unsupported', `${channel}.${key} declared false but did not refuse`);
            assert.equal(receipt.unsupported?.operation, CAPABILITY_OPERATIONS[key]);
            assert.equal(receipt.platformMessageId, null);
            assert.equal(receipt.ambiguous, false);
        }
        assert.equal(vendor.calls.length, 0, `${channel} called the vendor for an undeclared operation`);
        assert.ok(checked > 0, `${channel} has no false capability — this test would be vacuous`);
    });

    test(`${channel}: every receipt carries the adapter accountId`, async () => {
        const adapter = referenceAdapter(channel, { calls: [] });
        const target = targetFor(channel);
        for (const key of Object.keys(CAPABILITY_OPERATIONS) as OperationCapabilityKey[]) {
            const receipt = await callOperation(adapter, key, target);
            assert.equal(receipt.accountId, ACCOUNT_IDS[channel], `${channel}.${key} lost the accountId`);
        }
    });

    test(`${channel}: a target from another channel is rejected before the vendor call`, async () => {
        const vendor: VendorLog = { calls: [] };
        const adapter = referenceAdapter(channel, vendor);
        const foreign = CHANNELS.find(c => c !== channel)!;
        const receipt = await adapter.sendText({ target: targetFor(foreign), text: 'hi' });
        assert.equal(receipt.status, 'failed');
        assert.equal(receipt.failure?.message, 'channel_target_mismatch');
        assert.equal(vendor.calls.length, 0);
    });

    test(`${channel}: a threaded send preserves the canonical threadId`, async () => {
        const adapter = referenceAdapter(channel, { calls: [] });
        const target = { ...targetFor(channel), threadId: 'thread-1' };
        const receipt = await adapter.sendText({ target, text: 'in thread' });
        assert.equal(receipt.status, 'sent');
        assert.equal(receipt.threadId, 'thread-1');
    });
}

// ─── The one place a false capability may still deliver ──

test('an undeclared interactive send refuses unless the caller opts into text', async () => {
    const vendor: VendorLog = { calls: [] };
    // Slack declares interactiveActions false: Block Kit callbacks need interactive
    // envelope routing this tree does not have.
    const adapter = referenceAdapter('slack', vendor);
    assert.equal(adapter.capabilities.interactiveActions, false);
    const target = targetFor('slack');

    const refused = await adapter.sendInteractive({ target, text: 'pick', actions: [] });
    assert.equal(refused.status, 'unsupported');
    assert.equal(vendor.calls.length, 0);

    const downgraded = await adapter.sendInteractive({ target, text: 'pick', actions: [], fallback: 'text' });
    assert.equal(downgraded.status, 'sent');
    // The delivery is recorded as lesser. Silently dropping the actions is the
    // behaviour this replaces: the caller could not tell it had happened.
    assert.deepEqual(downgraded.downgraded, { operation: 'interactiveActions', to: 'text' });
    assert.deepEqual(vendor.calls, ['interactiveActions:text-fallback']);
});

test('a declared interactive send is not marked downgraded', async () => {
    const vendor: VendorLog = { calls: [] };
    const adapter = referenceAdapter('telegram', vendor);
    assert.equal(adapter.capabilities.interactiveActions, true);
    const receipt = await adapter.sendInteractive({ target: targetFor('telegram'), text: 'pick', actions: [] });
    assert.equal(receipt.status, 'sent');
    assert.equal(receipt.downgraded, undefined);
    assert.deepEqual(vendor.calls, ['interactiveActions']);
});
