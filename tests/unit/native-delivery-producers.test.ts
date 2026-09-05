import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.ts';
import { broadcast } from '../../src/core/bus.ts';
import { registerSendTransport, sendChannelOutput } from '../../src/messaging/send.ts';
import * as sendModule from '../../src/messaging/send.ts';
import { loadLocales, t } from '../../src/core/i18n.ts';
import { fileURLToPath } from 'node:url';
import { log } from '../../src/core/logger.ts';

// Actual bot producers; only collection, gateway admission and external transports
// are faked. No polling sockets, SDK clients or real message requests are started.
const operations: string[] = [];
const optionsSeen: boolean[] = [];
let completion: Record<string, unknown> = {};
let body = 'answer';
let eraseBody = false;
let selfDelivered = false;
let queued = false;
let id = 0;
let activeRequest = '';
let hubResponse: Record<string, unknown> | null = null;
const hubRequests: Record<string, unknown>[] = [];
const outboundResults: unknown[] = [];
const reportedErrors: unknown[][] = [];
const routed: Array<{ request: Parameters<typeof sendChannelOutput>[0]; promise: ReturnType<typeof sendChannelOutput> }> = [];
let senderGate: { entered(): void; wait: Promise<void> } | null = null;
const handlers = new Map<string, (ctx: any) => Promise<void>>();
const send = async (channel: string, text: string, opts?: { requireBodyDelivery?: boolean }) => {
    if (channel === 'telegram' && senderGate) {
        senderGate.entered();
        await senderGate.wait;
    }
    optionsSeen.push(opts?.requireBodyDelivery === true);
    if (eraseBody && opts?.requireBodyDelivery) return { ok: false, error: 'empty_message' };
    operations.push(`post:${channel}:${text}`);
    return { ok: true, ts: 'notice-ts' };
};

// Observe the existing router promise without cloning the request: native
// guards bind the original object through a private WeakSet in each producer.
mock.module('../../src/messaging/send.ts', { namedExports: {
    ...sendModule,
    sendChannelOutput: (request: Parameters<typeof sendChannelOutput>[0]) => {
        const promise = sendModule.sendChannelOutput(request);
        routed.push({ request, promise });
        void promise.catch(() => undefined); // caller still observes the original rejection
        return promise;
    },
} });

mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (hubResponse && String(url) === 'http://127.0.0.1:24576/api/dashboard/telegram-hub/outbound') {
        hubRequests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(hubResponse));
    }
    throw new Error('Unexpected network request in delivery test');
});
mock.method(log, 'event', (name: string, detail: Record<string, unknown>) => {
    if (name === 'outbound.send') outboundResults.push(detail['result']);
});
mock.method(log, 'error', (...args: unknown[]) => { reportedErrors.push(args); });
mock.module('../../src/orchestrator/collect.ts', { namedExports: {
    orchestrateAndCollect: async () => { throw new Error('Producer dropped native metadata'); },
    orchestrateAndCollectData: async () => ({ text: body, data: completion }),
} });
mock.module('../../src/orchestrator/gateway.ts', { namedExports: {
    submitMessage: () => ({ action: queued ? 'queued' : 'started', disposition: queued ? 'queued' : 'new_run',
        pending: 1, requestId: activeRequest, sessionContext: { scope: 'default', chatSessionId: 'default' } }),
} });
const ack = await import('../../src/messaging/ack-reaction.ts');
mock.module('../../src/messaging/ack-reaction.ts', { namedExports: { ...ack,
    shouldAck: () => true,
    createAckHandle: () => ({ to: async () => { operations.push('ack:running'); },
        settle: async (outcome: string) => { operations.push(`ack:${outcome}`); } }),
} });
const delivery = await import('../../src/messaging/turn-delivery.ts');
mock.module('../../src/messaging/turn-delivery.ts', { namedExports: { ...delivery, wasSelfDelivered: () => selfDelivered } });
const slackSend = await import('../../src/slack/send-only-client.ts');
mock.module('../../src/slack/send-only-client.ts', { namedExports: { ...slackSend,
    getSlackSendClient: () => ({ token: 'fake' }),
    sendSlackText: (_token: string, _target: unknown, text: string, opts: any) => send('slack', text, opts),
} });
const discordSend = await import('../../src/discord/send-only-client.ts');
mock.module('../../src/discord/send-only-client.ts', { namedExports: { ...discordSend,
    getDiscordSendClient: () => ({ token: 'fake' }),
    sendDiscordTextRest: (_token: string, _target: unknown, text: string, opts: any) => send('discord', text, opts),
} });
const rich = await import('../../src/telegram/rich-message.ts');
mock.module('../../src/telegram/rich-message.ts', { namedExports: { ...rich,
    sendTelegramMarkdown: async (_api: unknown, _target: unknown, text: string, opts: any) => {
        const result = await send('telegram', text, opts);
        if (!result.ok) throw new Error(result.error);
        return result;
    },
} });
for (const channel of ['slack', 'discord', 'telegram']) {
    const path = `../../src/${channel}/forwarder.ts`;
    const original = await import(path);
    const name = channel[0]!.toUpperCase() + channel.slice(1);
    mock.module(path, { namedExports: { ...original,
        [`relay${name}Images`]: async () => { operations.push(`images:${channel}`); },
    } });
}

const identity = await import('../../src/slack/identity.ts');
mock.module('../../src/slack/identity.ts', { namedExports: { ...identity,
    resolveSenderIdentity: async () => ({ id: 'U1', name: 'User', kind: 'user' }),
    buildSenderPrompt: (_identity: unknown, text: string) => text,
    buildSenderDisplay: (_identity: unknown, text: string) => text,
} });
mock.module('../../src/slack/progress.ts', { namedExports: {
    startSlackProgress: async () => ({ update() {}, finish: async () => { operations.push('progress:finish'); } }),
    statusFromToolEvent: () => null,
} });
const slackApi = await import('../../src/slack/api.ts');
mock.module('../../src/slack/api.ts', { namedExports: { ...slackApi,
    slackApi: async (_token: string, method: string) => {
        if (method.startsWith('chat.')) operations.push(`slack-api:${method}`);
        return { ok: true, data: { ts: 'notice-ts' } };
    },
} });
mock.module('../../src/slack/notice-transport.ts', { namedExports: {
    createSlackNoticeTransport: () => ({
        delete: async () => { operations.push('notice:delete'); },
        edit: async () => { operations.push('notice:edit'); },
    }),
} });

class FakeBot {
    api = {
        getMe: async () => ({ id: 999, username: 'testbot' }),
        sendChatAction: async () => {}, setMyCommands: async () => {},
        deleteMessage: async () => { operations.push('notice:delete'); return true; },
        editMessageText: async () => { operations.push('notice:edit'); return {}; },
        sendMessage: async () => ({ message_id: 99 }),
    };
    catch() { return this; } use() { return this; } command() { return this; }
    callbackQuery() { return this; }
    on(name: string, fn: (ctx: any) => Promise<void>) { handlers.set(name, fn); return this; }
    async stop() {} async handleUpdate() {}
}
const grammy = await import('grammy');
mock.module('grammy', { namedExports: { ...grammy, Bot: FakeBot } });
const offsets = await import('../../src/telegram/update-offset.ts');
mock.module('../../src/telegram/update-offset.ts', { namedExports: { ...offsets,
    TelegramDurablePoller: class { async start() {} async stop() {} },
} });

const slack = await import('../../src/slack/bot.ts');
const discord = await import('../../src/discord/bot.ts');
const telegram = await import('../../src/telegram/bot.ts');
registerSendTransport('discord', discord.discordSendHandler);
const target = (channel: string) => ({ channel, targetKind: 'channel', peerKind: 'channel', targetId: channel === 'slack' ? 'C1' : '123' });
const client = { token: 'fake', user: { id: 'BOT' }, rest: {
    patch: async () => { operations.push('notice:edit'); }, delete: async () => { operations.push('notice:delete'); },
} };

async function drain() { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); }
function standingTarget(data: Record<string, unknown>) {
    const from = routed.length;
    broadcast('orchestrate_done', data);
    return routed.slice(from);
}
async function settleStanding(data: Record<string, unknown>, expectedTelegramDispatches = 1) {
    const dispatched = standingTarget(data);
    if (data['origin'] === 'telegram') assert.equal(dispatched.length, expectedTelegramDispatches);
    const results = await Promise.all(dispatched.map(entry => entry.promise));
    await drain(); // settle already-completed handler bookkeeping, not transport admission
    return results;
}
async function run(channel: string) {
    activeRequest = `native-delivery-${++id}`;
    if (channel === 'slack') {
        return slack.processSlackMessageEvent({ user: 'U1', ts: String(id), channel: 'C1' } as never,
            target(channel) as never, 'prompt', new AbortController().signal);
    }
    if (channel === 'discord') {
        const msg = { id: String(id), channelId: '123', client, author: { id: 'USER', bot: false },
            content: 'prompt', attachments: new Map(), mentions: { has: () => false },
            channel: { isTextBased: () => true, isSendable: () => true, isThread: () => false, send() {}, sendTyping: async () => {} },
            reply: async (text: string) => { operations.push(`reply:discord:${text}`); return { id: 'notice', channelId: '123', client }; } };
        return discord.handleDiscordMessage(client as never, msg as never);
    }
    const ctx = { chat: { id: 123, type: 'private' }, from: { id: 1 }, update: { update_id: id },
        message: { message_id: id, text: 'prompt' }, api: new FakeBot().api,
        reply: async (text: string) => { operations.push(`reply:telegram:${text}`); return { message_id: 99 }; },
        replyWithChatAction: async () => {},
    };
    return handlers.get('message:text')!(ctx);
}

test.before(async () => {
    loadLocales(fileURLToPath(new URL('../../public/locales/', import.meta.url)));
    Object.assign(settings, { multiSession: { enabled: false },
        slack: { enabled: true, botToken: 'fake', appToken: 'fake', channelIds: ['C1'], progress: { enabled: true } },
        discord: { enabled: true, token: 'fake', channelIds: ['123'], mentionOnly: false },
        telegram: { enabled: true, token: 'fake', allowedChatIds: [123], forwardAll: false, mentionOnly: false },
    });
    await telegram.initTelegram(); // FakeBot + inert fake poller only
});
test.after(async () => { await telegram.shutdownTelegram(); });
test.beforeEach(() => {
    operations.length = 0; optionsSeen.length = 0; completion = {}; body = 'answer';
    eraseBody = false; selfDelivered = false; queued = false;
    senderGate = null; routed.length = 0;
    hubResponse = null; hubRequests.length = 0; outboundResults.length = 0; reportedErrors.length = 0;
    delete (settings as Record<string, unknown>)['telegramHub'];
});

test('forged public send fields cannot opt into the private standing-target guard', async () => {
    for (const channel of ['discord', 'telegram']) {
        optionsSeen.length = 0;
        const request = { channel, type: 'text', text: 'answer', target: target(channel),
            requireBodyDelivery: true, runtimeFinality: 'present', runtimeStatus: 'done' };
        assert.equal((await sendChannelOutput(request as never)).ok, true);
        assert.deepEqual(optionsSeen, [false]);
    }
});

test('native hub relay requires exact body receipt; legacy keeps ok truthiness and never resends', async () => {
    (settings as Record<string, unknown>)['telegramHub'] = { mode: 'hub-member', hubCallbackUrl: 'http://127.0.0.1:24576' };
    const remoteTarget = { ...target('telegram'), threadId: '42' };
    for (const response of [
        { ok: true, bodyDelivered: true }, { ok: true, bodyDelivered: false }, { ok: true },
        { ok: 'yes', bodyDelivered: true }, { ok: true, bodyDelivered: 'true' },
        { ok: false, bodyDelivered: true, error: 'rejected' },
    ]) {
        hubResponse = response;
        hubRequests.length = 0; outboundResults.length = 0; reportedErrors.length = 0;
        const results = await settleStanding({ origin: 'telegram', text: 'answer', replyViaTarget: true,
            target: remoteTarget, runtimeFinality: 'present', runtimeStatus: 'done' });
        const confirmed = response.ok === true && response.bodyDelivered === true;
        assert.equal(results[0]?.ok, confirmed);
        assert.deepEqual(outboundResults, [confirmed ? 'ok' : 'error']);
        assert.deepEqual(hubRequests, [{ chatId: '123', threadId: '42', type: 'text', text: 'answer' }]);
        if (!confirmed && response.ok !== false) {
            assert.match(String(reportedErrors.flat()), /telegram_hub_body_delivery_unconfirmed/);
        }
        hubRequests.length = 0; outboundResults.length = 0;
        const legacy = await sendChannelOutput({ channel: 'telegram', type: 'text', text: 'answer', target: remoteTarget as never });
        assert.equal(legacy.ok, Boolean(response.ok));
        assert.deepEqual(outboundResults, [response.ok ? 'ok' : 'error']);
        assert.deepEqual(hubRequests, [{ chatId: '123', threadId: '42', type: 'text', text: 'answer' }]);
    }
});

test('standing Telegram delivery awaits its exact router promise after a deferred sender', { timeout: 3_000 }, async t => {
    for (const native of [false, true]) {
        optionsSeen.length = 0;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const abort = () => { entered.reject(new Error('deferred sender did not enter')); release.resolve(); };
        t.signal.addEventListener('abort', abort, { once: true });
        senderGate = { entered: entered.resolve, wait: release.promise };
        const from = routed.length;
        const completion = settleStanding({ origin: 'telegram', text: 'answer', replyViaTarget: true,
            target: target('telegram'), ...(native ? { runtimeFinality: 'present', runtimeStatus: 'done' } : {}) });
        const dispatched = routed.slice(from);
        let barrierSettled = false;
        void completion.then(() => { barrierSettled = true; }, () => { barrierSettled = true; });
        try {
            assert.equal(dispatched.length, 1);
            await entered.promise;
            await drain();
            assert.deepEqual(optionsSeen, [], 'event-loop yields are not a transport completion barrier');
            assert.equal(barrierSettled, false, 'the helper must still await the exact dispatch');
            release.resolve();
            assert.equal((await completion)[0]?.ok, true);
            assert.deepEqual(optionsSeen, [native], 'the real router preserves private request identity');
        } finally {
            release.resolve();
            senderGate = null;
            t.signal.removeEventListener('abort', abort);
            await Promise.allSettled([completion]);
            await Promise.allSettled(dispatched.map(entry => entry.promise));
        }
    }
});

for (const channel of ['slack', 'discord', 'telegram']) {
    test(`${channel} direct native diagnostic preserves baseline operations and ACK order`, async () => {
        body = t('tg.noResponse', {}, 'ko');
        await run(channel); await drain();
        const baseline = [...operations];
        assert.ok(baseline.includes(`post:${channel}:${body}`), JSON.stringify(baseline));
        assert.equal(baseline.filter(x => x === 'ack:success').length, 1);
        for (const runtimeFinality of ['present', 'absent']) {
            for (const runtimeStatus of ['done', 'error', 'stopped']) {
                operations.length = 0; optionsSeen.length = 0;
                completion = { runtimeFinality, runtimeStatus };
                await run(channel); await drain();
                assert.deepEqual(operations, baseline);
                assert.deepEqual(optionsSeen, [true]);
            }
        }
    });
    test(`${channel} native formatter failure cannot ACK success`, async () => {
        completion = { runtimeFinality: 'present', runtimeStatus: 'done' }; eraseBody = true;
        await run(channel); await drain();
        assert.ok(optionsSeen.includes(true));
        assert.equal(operations.includes('ack:success'), false, JSON.stringify(operations));
        assert.equal(operations.filter(x => x === 'ack:failure').length, 1);
    });
    test(`${channel} proven self-delivery retains success without duplicate body`, async () => {
        completion = { runtimeFinality: 'present', runtimeStatus: 'done' }; selfDelivered = true;
        await run(channel); await drain();
        assert.equal(operations.some(x => x.startsWith(`post:${channel}:`)), false);
        assert.equal(operations.filter(x => x === 'ack:success').length, 1);
    });
    test(`${channel} queued native whitespace expires without inventing diagnostic`, async () => {
        queued = true;
        const pending = run(channel);
        await drain();
        operations.length = 0; optionsSeen.length = 0;
        broadcast('orchestrate_done', { origin: channel, requestId: activeRequest, text: ' \n',
            runtimeFinality: 'present', runtimeStatus: 'done', fromQueue: true, target: target(channel) });
        await pending; await drain();
        assert.equal(optionsSeen.length, 0);
        assert.equal(operations.includes('ack:success'), false);
        assert.equal(operations.filter(x => x === 'ack:failure').length, 1, JSON.stringify(operations));
        assert.equal(operations.some(x => x.startsWith('post:') || x.startsWith('reply:')), false);
    });
    test(`${channel} standing target native guard stays private and ignores invalid tags`, async () => {
        for (const tags of [ {}, { runtimeFinality: 'present' }, { runtimeStatus: 'done' },
            { runtimeFinality: 'invalid', runtimeStatus: 'done' }, { runtimeFinality: 'present', runtimeStatus: 'invalid' },
            { runtimeFinality: 'absent', runtimeStatus: 'error' } ]) {
            optionsSeen.length = 0;
            const results = await settleStanding({ origin: channel, text: 'answer', fromQueue: true, replyViaTarget: true,
                target: target(channel), ...tags });
            for (const result of results) assert.equal(result.ok, true);
            assert.deepEqual(optionsSeen, [tags.runtimeStatus === 'error']);
        }
    });
    test(`${channel} queued nonempty native preserves baseline send/notice/ACK/image order`, async () => {
        async function deliver(tags: Record<string, unknown>) {
            queued = true;
            const pending = run(channel); await drain();
            operations.length = 0; optionsSeen.length = 0;
            broadcast('orchestrate_done', { origin: channel, requestId: activeRequest,
                text: 'queued answer', fromQueue: true, target: target(channel), ...tags });
            await pending; await drain();
            return [...operations];
        }
        const baseline = await deliver({});
        assert.ok(baseline.includes(`post:${channel}:queued answer`));
        assert.equal(baseline.filter(x => x === 'ack:success').length, 1);
        assert.ok(baseline.indexOf(`post:${channel}:queued answer`) < baseline.indexOf('notice:delete'));
        const native = await deliver({ runtimeFinality: 'present', runtimeStatus: 'done' });
        assert.deepEqual(native, baseline);
        assert.deepEqual(optionsSeen, [true]);
    });
    test(`${channel} queued formatted-away native expires instead of answered`, async () => {
        queued = true;
        const pending = run(channel); await drain();
        operations.length = 0; optionsSeen.length = 0; eraseBody = true;
        broadcast('orchestrate_done', { origin: channel, requestId: activeRequest,
            text: 'format removes this', fromQueue: true, target: target(channel),
            runtimeFinality: 'absent', runtimeStatus: 'error' });
        if (channel === 'telegram') await assert.rejects(pending, /empty_message/);
        else await pending;
        await drain();
        assert.deepEqual(optionsSeen, [true]);
        assert.equal(operations.includes('notice:delete'), false);
        assert.ok(operations.includes('notice:edit'), JSON.stringify(operations));
        assert.equal(operations.filter(x => x === 'ack:failure').length, 1);
        assert.equal(operations.includes('ack:success'), false);
    });
    test(`${channel} standing target empty native and formatter failure cannot claim success`, async () => {
        await settleStanding({ origin: channel, text: ' \n', fromQueue: true, replyViaTarget: true,
            target: target(channel), runtimeFinality: 'absent', runtimeStatus: 'done' }, 0);
        assert.deepEqual(optionsSeen, []);
        assert.deepEqual(operations, []);
        eraseBody = true;
        const failed = settleStanding({ origin: channel, text: 'removed', fromQueue: true, replyViaTarget: true,
            target: target(channel), runtimeFinality: 'present', runtimeStatus: 'done' });
        if (channel === 'telegram') await assert.rejects(failed, /empty_message/);
        else for (const result of await failed) assert.equal(result.ok, false);
        await drain();
        assert.deepEqual(optionsSeen, [true]);
        assert.deepEqual(operations, []);
    });
}
