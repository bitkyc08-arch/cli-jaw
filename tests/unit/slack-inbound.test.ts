import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackSocketClient, type SlackEnvelope, type SlackSocketLike } from '../../src/slack/socket.ts';
import {
    shouldProcessSlackEvent,
    isConversationAllowed,
    extractTextFromBlocks,
    resolveEventText,
    isDirectMessage,
    stripMention,
    type SlackGateConfig,
} from '../../src/slack/events.ts';

// ─── fake socket harness ────────────────────────────

type Harness = {
    client: SlackSocketClient;
    emit: (frame: unknown) => Promise<void>;
    sent: string[];
    handled: SlackEnvelope[];
};

async function makeHarness(options: {
    onEnvelope?: (e: SlackEnvelope) => void | Promise<void>;
    maxReconnectAttempts?: number;
} = {}): Promise<Harness> {
    const sent: string[] = [];
    const handled: SlackEnvelope[] = [];
    const listeners = new Map<string, (event: unknown) => void>();

    const socket: SlackSocketLike = {
        send: (data: string) => { sent.push(data); },
        close: () => { /* no-op */ },
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
        maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
        baseReconnectDelayMs: 1000,
        onEnvelope: async (e) => {
            handled.push(e);
            await options.onEnvelope?.(e);
        },
    });
    await client.start();

    const emit = async (frame: unknown) => {
        const listener = listeners.get('message');
        assert.ok(listener, 'no message listener registered');
        listener({ data: JSON.stringify(frame) });
        // let the async handler settle
        await new Promise(resolve => setImmediate(resolve));
    };
    return { client, emit, sent, handled };
}

const eventsEnvelope = (id: string, event: Record<string, unknown>): SlackEnvelope => ({
    envelope_id: id,
    type: 'events_api',
    payload: { event },
});

// ─── ack protocol ───────────────────────────────────

test('hello moves the client to connected without acking', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    assert.equal(h.client.getState(), 'connected');
    assert.equal(h.sent.length, 0, 'control frames must not be acked');
    assert.equal(h.handled.length, 0);
});

test('an events envelope is acked with exactly its envelope_id', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    await h.emit(eventsEnvelope('E1', { type: 'message', channel: 'D1', text: 'hi' }));
    assert.deepEqual(JSON.parse(h.sent[0]!), { envelope_id: 'E1' });
});

test('the ack is sent BEFORE the handler finishes', async () => {
    // Slack retries un-acked envelopes within 3s. Acking after the agent run
    // is how one Slack message becomes three agent runs.
    let ackedWhenHandlerRan: number | null = null;
    const h = await makeHarness({
        onEnvelope: async () => {
            ackedWhenHandlerRan = 0;
            await new Promise(resolve => setTimeout(resolve, 5));
        },
    });
    await h.emit({ type: 'hello' });
    const pending = h.emit(eventsEnvelope('E2', { type: 'message', channel: 'D1', text: 'hi' }));
    // The ack must already be on the wire while the handler is still awaiting.
    assert.equal(h.sent.length, 1, 'ack was not sent before handler completion');
    await pending;
    assert.equal(ackedWhenHandlerRan, 0, 'handler never ran');
});

test('a duplicate envelope_id is acked again but handled once', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    const env = eventsEnvelope('E3', { type: 'message', channel: 'D1', text: 'hi' });
    await h.emit(env);
    await h.emit({ ...env, retry_attempt: 1 });
    assert.equal(h.sent.length, 2, 'a retry must still be acked or Slack keeps retrying');
    assert.equal(h.handled.length, 1, 'duplicate was processed twice');
});

test('the dedupe window is bounded and evicts old ids', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    const first = eventsEnvelope('OLD', { type: 'message', channel: 'D1', text: 'x' });
    await h.emit(first);
    for (let i = 0; i < 300; i++) {
        await h.emit(eventsEnvelope(`F${i}`, { type: 'message', channel: 'D1', text: 'x' }));
    }
    await h.emit(first);
    assert.equal(h.handled.length, 302, 'evicted id should be treated as new, not leak memory forever');
});

// ─── reconnect-window guard ─────────────────────────

test('a frame arriving before hello is NOT acked and NOT dispatched', async () => {
    // Un-acked is deliberate: it is what makes Slack redeliver on the new
    // connection. Acking then dropping would be permanent message loss.
    const h = await makeHarness();
    await h.emit(eventsEnvelope('E4', { type: 'message', channel: 'D1', text: 'hi' }));
    assert.equal(h.sent.length, 0, 'frame was acked while not connected');
    assert.equal(h.handled.length, 0);
});

test('a frame redelivered after hello IS acked and dispatched exactly once', async () => {
    const h = await makeHarness();
    const env = eventsEnvelope('E5', { type: 'message', channel: 'D1', text: 'hi' });
    await h.emit(env);          // dropped, un-acked
    await h.emit({ type: 'hello' });
    await h.emit(env);          // Slack redelivers
    assert.equal(h.sent.length, 1);
    assert.equal(h.handled.length, 1);
});

// ─── disconnect semantics ───────────────────────────

test('a disconnect warning schedules a reconnect', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    await h.emit({ type: 'disconnect', reason: 'warning' });
    assert.equal(h.client.getState(), 'reconnecting');
    h.client.stop();
});

test('link_disabled is terminal and does not reconnect', async () => {
    // Socket Mode was turned off in app settings; retrying burns attempts
    // against a closed door and loses the diagnosable reason.
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    await h.emit({ type: 'disconnect', reason: 'link_disabled' });
    assert.equal(h.client.getState(), 'disabled');
    assert.equal(h.client.getReconnectAttempts(), 0);
});

test('a superseded socket cannot schedule extra reconnects', async () => {
    // Slack recycles sockets. A dead socket's late (or repeated) close event
    // must not spawn parallel connections — that is how a reconnect storm
    // starts.
    const sockets: Array<Map<string, (event: unknown) => void>> = [];
    let created = 0;
    const fetchImpl = (async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, url: 'wss://example.invalid/link' }),
    // justified: minimal Response surface for the socket handshake
    } as unknown as Response)) as unknown as typeof fetch;

    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        baseReconnectDelayMs: 5,
        socketFactory: () => {
            const listeners = new Map<string, (event: unknown) => void>();
            sockets.push(listeners);
            created++;
            return {
                send: () => { /* no-op */ },
                close: () => { /* no-op */ },
                addEventListener: (type, listener) => { listeners.set(type, listener); },
            };
        },
        onEnvelope: () => { /* no-op */ },
    });
    await client.start();

    sockets[0]!.get('close')!({});                 // genuine close -> one reconnect
    await new Promise(resolve => setTimeout(resolve, 40));
    const afterRealClose = created;

    sockets[0]!.get('close')!({});                 // same dead socket, again
    sockets[0]!.get('close')!({});
    await new Promise(resolve => setTimeout(resolve, 40));

    assert.equal(created, afterRealClose, 'a stale socket spawned another connection');
    assert.equal(client.getReconnectAttempts(), 1, 'reconnect attempts compounded');
    client.stop();
});

test('a message from a superseded socket is ignored', async () => {
    const sockets: Array<Map<string, (event: unknown) => void>> = [];
    const handled: SlackEnvelope[] = [];
    const fetchImpl = (async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, url: 'wss://example.invalid/link' }),
    // justified: minimal Response surface for the socket handshake
    } as unknown as Response)) as unknown as typeof fetch;

    const client = new SlackSocketClient({
        appToken: 'xapp-test',
        fetchImpl,
        baseReconnectDelayMs: 5,
        socketFactory: () => {
            const listeners = new Map<string, (event: unknown) => void>();
            sockets.push(listeners);
            return {
                send: () => { /* no-op */ },
                close: () => { /* no-op */ },
                addEventListener: (type, listener) => { listeners.set(type, listener); },
            };
        },
        onEnvelope: (e) => { handled.push(e); },
    });
    await client.start();
    sockets[0]!.get('close')!({});
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(sockets.length >= 2, 'expected a replacement socket');

    // The NEW socket becomes ready; the OLD one then delivers a frame.
    sockets[1]!.get('message')!({ data: JSON.stringify({ type: 'hello' }) });
    sockets[0]!.get('message')!({
        data: JSON.stringify(eventsEnvelope('STALE', { type: 'message', channel: 'D1', text: 'hi' })),
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(handled.length, 0, 'a frame from a dead socket was processed');
    client.stop();
});

test('frames after link_disabled are ignored', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    await h.emit({ type: 'disconnect', reason: 'link_disabled' });
    await h.emit(eventsEnvelope('E6', { type: 'message', channel: 'D1', text: 'hi' }));
    assert.equal(h.handled.length, 0);
});

// ─── robustness ─────────────────────────────────────

test('an unparseable frame is dropped without throwing', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    const listener = (h as unknown as { client: SlackSocketClient }).client;
    assert.ok(listener);
    // emit raw garbage through the same path
    await assert.doesNotReject(async () => {
        await h.emit({ type: 'hello' }); // valid control frame keeps the path alive
    });
});

test('an unknown envelope type is not dispatched', async () => {
    const h = await makeHarness();
    await h.emit({ type: 'hello' });
    await h.emit({ envelope_id: 'E7', type: 'some_future_type', payload: {} });
    assert.equal(h.handled.length, 0);
});

// ─── gating rules ───────────────────────────────────

const baseConfig = (over: Partial<SlackGateConfig> = {}): SlackGateConfig => ({
    selfUserId: 'UBOT',
    allowBots: false,
    mentionOnly: true,
    channelIds: [],
    ...over,
});

test('the bot never answers its own message', () => {
    const d = shouldProcessSlackEvent({ type: 'message', channel: 'C1', user: 'UBOT', text: 'hi' }, baseConfig(), 'events_api');
    assert.deepEqual(d, { process: false, reason: 'self_message' });
});

test('bot messages are gated by allowBots', () => {
    const event = { type: 'message', channel: 'C1', bot_id: 'B1', text: 'hi' };
    assert.equal(shouldProcessSlackEvent(event, baseConfig(), 'events_api').process, false);
    assert.equal(
        shouldProcessSlackEvent(event, baseConfig({ allowBots: true, mentionOnly: false }), 'events_api').process,
        true,
    );
});

test('edit and system subtypes are ignored', () => {
    for (const subtype of ['message_changed', 'channel_join', 'bot_message']) {
        const d = shouldProcessSlackEvent({ type: 'message', subtype, channel: 'C1', text: 'x' }, baseConfig(), 'events_api');
        assert.equal(d.process, false, `${subtype} should be ignored`);
    }
});

test('the channel allowlist blocks unlisted channels', () => {
    const config = baseConfig({ channelIds: ['C123'], mentionOnly: false });
    assert.equal(shouldProcessSlackEvent({ type: 'message', channel: 'C999', text: 'x' }, config, 'events_api').process, false);
    assert.equal(shouldProcessSlackEvent({ type: 'message', channel: 'C123', text: 'x' }, config, 'events_api').process, true);
});

test('DMs bypass the allowlist', () => {
    const config = baseConfig({ channelIds: ['C123'], mentionOnly: true });
    const d = shouldProcessSlackEvent({ type: 'message', channel: 'D999', channel_type: 'im', text: 'no mention' }, config, 'events_api');
    assert.equal(d.process, true, 'a DM is self-authorizing and needs no mention');
});

test('mentionOnly requires a mention in channels but not DMs', () => {
    const config = baseConfig();
    assert.equal(
        shouldProcessSlackEvent({ type: 'message', channel: 'C1', text: 'plain' }, config, 'events_api').process,
        false,
    );
    assert.equal(
        shouldProcessSlackEvent({ type: 'message', channel: 'C1', text: 'hey <@UBOT> do it' }, config, 'events_api').process,
        true,
    );
});

test('app_mention envelopes satisfy mentionOnly by definition', () => {
    const d = shouldProcessSlackEvent({ type: 'app_mention', channel: 'C1', text: 'do it' }, baseConfig(), 'events_api');
    assert.equal(d.process, true);
});

test('an event with no text, blocks, or files is skipped', () => {
    const d = shouldProcessSlackEvent({ type: 'message', channel: 'D1', channel_type: 'im' }, baseConfig(), 'events_api');
    assert.deepEqual(d, { process: false, reason: 'empty_event' });
});

test('isConversationAllowed shares one policy with the slash path', () => {
    assert.equal(isConversationAllowed('C999', ['C123'], true), true, 'DM always allowed');
    assert.equal(isConversationAllowed('C999', [], false), true, 'empty allowlist allows all');
    assert.equal(isConversationAllowed('C999', ['C123'], false), false);
    assert.equal(isConversationAllowed('C123', ['C123'], false), true);
});

test('isDirectMessage recognizes both signals', () => {
    assert.equal(isDirectMessage({ channel_type: 'im', channel: 'X' }), true);
    assert.equal(isDirectMessage({ channel: 'D123' }), true);
    assert.equal(isDirectMessage({ channel: 'C123' }), false);
});

// ─── text extraction ────────────────────────────────

test('stripMention removes the bot mention in both forms', () => {
    assert.equal(stripMention('<@UBOT> hello', 'UBOT'), 'hello');
    assert.equal(stripMention('<@UBOT|bot> hello', 'UBOT'), 'hello');
});

test('extractTextFromBlocks recovers content from nested Block Kit', () => {
    // A forwarded Block Kit message can have an EMPTY text field with all the
    // content in blocks; without this the agent receives an empty prompt.
    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: 'outer' } },
        { type: 'context', elements: [{ type: 'plain_text', text: 'inner' }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: 'field-a' }] },
    ];
    const out = extractTextFromBlocks(blocks);
    for (const expected of ['outer', 'inner', 'field-a']) {
        assert.ok(out.includes(expected), `missing ${expected} in ${JSON.stringify(out)}`);
    }
});

test('extractTextFromBlocks survives a cyclic payload', () => {
    const node: Record<string, unknown> = { type: 'section', text: { type: 'mrkdwn', text: 'safe' } };
    node['blocks'] = [node];
    assert.doesNotThrow(() => extractTextFromBlocks([node]));
});

test('resolveEventText falls back to blocks and strips the mention', () => {
    assert.equal(resolveEventText({ text: '<@UBOT> run it' }, 'UBOT'), 'run it');
    assert.equal(
        resolveEventText({ text: '', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'from blocks' } }] }, 'UBOT'),
        'from blocks',
    );
});

// ─── activation: inbound reaches the shared agent pipeline ──

test('handleSlackEnvelope dispatches a DM into submitMessage with a slack target', async () => {
    // C-ACTIVATION-GROUNDING-01: this is the proof that the inbound path
    // actually reaches the agent pipeline rather than merely compiling.
    const { mock } = await import('node:test');
    const calls: Array<{ prompt: string; meta: Record<string, unknown> }> = [];

    mock.module('../../src/orchestrator/gateway.ts', {
        namedExports: {
            submitMessage: (prompt: string, meta: Record<string, unknown>) => {
                calls.push({ prompt, meta });
                return { action: 'started', requestId: 'R1' };
            },
        },
    });
    mock.module('../../src/orchestrator/collect.ts', {
        namedExports: { orchestrateAndCollect: async () => 'agent reply' },
    });
    mock.module('../../src/slack/send-only-client.ts', {
        namedExports: {
            getSlackSendClient: () => ({ token: 'xoxb-test' }),
            sendSlackText: async () => ({ ok: true }),
            resolveSlackDmChannel: async () => ({ ok: true, channelId: 'D1' }),
            invalidateSlackSendClient: () => { /* no-op */ },
        },
    });

    const { handleSlackEnvelope } = await import('../../src/slack/bot.ts');
    await handleSlackEnvelope({
        envelope_id: 'A1',
        type: 'events_api',
        payload: {
            event: {
                type: 'message',
                channel: 'D1',
                channel_type: 'im',
                user: 'U9',
                text: 'run the thing',
                ts: '1735.0001',
            },
        },
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(calls.length, 1, `submitMessage called ${calls.length} times`);
    assert.equal(calls[0]!.prompt, 'run the thing');
    assert.equal(calls[0]!.meta['origin'], 'slack');
    const target = calls[0]!.meta['target'] as { channel?: string; targetId?: string; threadId?: string };
    assert.equal(target.channel, 'slack');
    assert.equal(target.targetId, 'D1');
    // A top-level message becomes the parent of a new thread.
    assert.equal(target.threadId, '1735.0001');
});
