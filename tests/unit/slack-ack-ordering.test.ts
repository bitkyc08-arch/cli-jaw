// Slack append-before-ACK ordering (M3c).
//
// The regression this file guards against is silent: acking an envelope whose record
// never reached disk means Slack considers it delivered and never sends it again. The
// only way to catch that is to assert WHEN the ack goes out relative to the durable
// write, so every test here watches the ordering rather than the end state.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SlackSocketClient,
    type SlackEnvelope,
    type SlackPreflightResult,
    type SlackSocketLike,
} from '../../src/slack/socket.ts';

type Harness = {
    client: SlackSocketClient;
    emit: (frame: unknown) => Promise<void>;
    acked: string[];
    dispatched: SlackEnvelope[];
    order: string[];
    closed: number;
};

async function makeHarness(options: {
    preflight?: (e: SlackEnvelope, order: string[]) => Promise<SlackPreflightResult>;
} = {}): Promise<Harness> {
    const acked: string[] = [];
    const dispatched: SlackEnvelope[] = [];
    const order: string[] = [];
    let closed = 0;
    const listeners = new Map<string, (event: unknown) => void>();

    const socket: SlackSocketLike = {
        send: (data: string) => {
            const parsed = JSON.parse(data) as { envelope_id?: string };
            if (parsed.envelope_id) {
                acked.push(parsed.envelope_id);
                order.push('ack');
            }
        },
        close: () => { closed++; },
        addEventListener: (type, listener) => { listeners.set(type, listener); },
    };

    const fetchImpl = (async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, url: 'wss://example.invalid/link' }),
    } as unknown as Response)) as unknown as typeof fetch;

    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        socketFactory: () => socket,
        baseReconnectDelayMs: 1000,
        onEnvelope: async (e) => { dispatched.push(e); order.push('dispatch'); },
        ...(options.preflight ? { preflightEnvelope: (e: SlackEnvelope) => options.preflight!(e, order) } : {}),
    });
    await client.start();

    const emit = async (frame: unknown) => {
        const listener = listeners.get('message');
        assert.ok(listener, 'no message listener registered');
        listener({ data: JSON.stringify(frame) });
        await new Promise(resolve => setTimeout(resolve, 5));
    };

    // `hello` is what moves the client out of `connecting`; without it every frame
    // is left un-acked by the reconnect-window guard and no ordering is observable.
    const listener = listeners.get('message');
    assert.ok(listener, 'no message listener registered');
    listener({ data: JSON.stringify({ type: 'hello' }) });
    await new Promise(resolve => setTimeout(resolve, 5));
    order.length = 0;

    return {
        client,
        emit,
        acked,
        dispatched,
        order,
        get closed() { return closed; },
    };
}

function eventsFrame(envelopeId: string) {
    return {
        envelope_id: envelopeId,
        type: 'events_api',
        payload: { event: { type: 'message', channel: 'C1', ts: '1700000000.000100', user: 'U1', text: 'hi' } },
    };
}

test('the durable write happens before the ack', async () => {
    const harness = await makeHarness({
        preflight: async (_e, order) => { order.push('append'); return 'committed'; },
    });
    await harness.emit(eventsFrame('env-1'));
    // This exact sequence is the contract. Any other order means a crash window where
    // Slack believes a message was delivered that was never recorded.
    assert.deepEqual(harness.order, ['append', 'ack', 'dispatch']);
    assert.deepEqual(harness.acked, ['env-1']);
    harness.client.stop();
});

test('a failed durable write withholds the ack and recycles the socket', async () => {
    const harness = await makeHarness({
        preflight: async () => { throw new Error('disk full'); },
    });
    await harness.emit(eventsFrame('env-2'));
    // No ack means Slack redelivers. Acking here would lose the message outright.
    assert.deepEqual(harness.acked, []);
    assert.deepEqual(harness.dispatched, []);
    assert.equal(harness.closed, 1, 'the socket must be recycled so the redelivery arrives');
    harness.client.stop();
});

test('an already-handled event is acked but not dispatched again', async () => {
    const harness = await makeHarness({
        preflight: async () => 'duplicate',
    });
    await harness.emit(eventsFrame('env-3'));
    // The ack is what Slack was still waiting for; the work is already done.
    assert.deepEqual(harness.acked, ['env-3']);
    assert.deepEqual(harness.dispatched, []);
    harness.client.stop();
});

test('an event the gate drops is acked and never dispatched', async () => {
    const harness = await makeHarness({
        preflight: async () => 'ignored',
    });
    await harness.emit(eventsFrame('env-4'));
    assert.deepEqual(harness.acked, ['env-4']);
    assert.deepEqual(harness.dispatched, []);
    harness.client.stop();
});

test('an unhandled envelope type is acked without any durable write', async () => {
    let preflightCalls = 0;
    const harness = await makeHarness({
        preflight: async () => { preflightCalls++; return 'committed'; },
    });
    await harness.emit({ envelope_id: 'env-5', type: 'hello_there', payload: {} });
    // Acked so Slack stops retrying something we will never act on, but there is
    // nothing to record — journaling it would fill the table with noise.
    assert.deepEqual(harness.acked, ['env-5']);
    assert.equal(preflightCalls, 0);
    assert.deepEqual(harness.dispatched, []);
    harness.client.stop();
});

test('a redelivered envelope id is acked and dropped without a second dispatch', async () => {
    let preflightCalls = 0;
    const harness = await makeHarness({
        preflight: async () => { preflightCalls++; return 'committed'; },
    });
    await harness.emit(eventsFrame('env-6'));
    await harness.emit(eventsFrame('env-6'));
    assert.deepEqual(harness.acked, ['env-6', 'env-6'], 'the retry needs its own ack');
    assert.equal(harness.dispatched.length, 1);
    assert.equal(preflightCalls, 1, 'the connection-local duplicate check runs before the journal');
    harness.client.stop();
});

test('without a preflight the socket keeps its previous behaviour', async () => {
    const harness = await makeHarness();
    await harness.emit(eventsFrame('env-7'));
    // CLI and test callers pass no preflight; they must not start losing events.
    assert.deepEqual(harness.order, ['ack', 'dispatch']);
});

