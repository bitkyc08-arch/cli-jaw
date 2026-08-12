import '../setup/isolated-home.ts';
import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const slackUrl = new URL('../../src/slack/send-only-client.ts', import.meta.url).href;
const telegramUrl = new URL('../../src/telegram/bot.ts', import.meta.url).href;
const discordUrl = new URL('../../src/discord/send-only-client.ts', import.meta.url).href;
const realSlack = await import('../../src/slack/send-only-client.js');
const realTelegram = await import('../../src/telegram/bot.js');
const realDiscord = await import('../../src/discord/send-only-client.js');

type Platform = 'slack' | 'telegram' | 'discord';
const delivered: Record<Platform, string[]> = { slack: [], telegram: [], discord: [] };
let failedPlatform: Platform | null = null;

mock.module(slackUrl, { namedExports: {
    ...realSlack,
    getSlackSendClient: () => ({ token: 'xoxb-test' }),
    resolveSlackDmChannel: async () => ({ ok: true, channelId: 'D-OPERATOR' }),
    sendSlackText: async (_token: string, _target: unknown, text: string) => {
        delivered.slack.push(text);
        if (failedPlatform === 'slack') throw new Error('slack_delivery_failed');
        return { ok: true };
    },
} });
mock.module(telegramUrl, { namedExports: {
    ...realTelegram,
    sendTelegramText: async (_userId: string, text: string) => {
        delivered.telegram.push(text);
        if (failedPlatform === 'telegram') throw new Error('telegram_delivery_failed');
        return { message_id: 1 };
    },
} });
mock.module(discordUrl, { namedExports: {
    ...realDiscord,
    getDiscordSendClient: () => ({ token: 'discord-test' }),
    sendDiscordDm: async (_token: string, _userId: string, text: string) => {
        delivered.discord.push(text);
        if (failedPlatform === 'discord') throw new Error('discord_delivery_failed');
        return { ok: true };
    },
} });

const { registerOrchestrateRoutes } = await import('../../src/routes/orchestrate.js');
const { dispatchApprovalStore } = await import('../../src/core/dispatch-approval.js');
const { settings } = await import('../../src/core/config.js');

type Handler = (req: any, res: any) => Promise<unknown> | unknown;
const routes = new Map<string, Handler>();
const capture = (method: string) => (path: string, ...handlers: Handler[]) => routes.set(`${method} ${path}`, handlers.at(-1)!);
registerOrchestrateRoutes({ post: capture('POST'), get: capture('GET'), put: capture('PUT'), delete: capture('DELETE'), patch: capture('PATCH') } as never,
    ((_req: unknown, _res: unknown, next: () => void) => next()) as never);
const pendingHandler = routes.get('POST /api/orchestrate/dispatch/pending')!;

function fakeRes() {
    const state: { status: number; body: Record<string, any> | null } = { status: 200, body: null };
    const res = {
        status(code: number) { state.status = code; return res; },
        json(body: Record<string, any>) { state.body = body; return res; },
    };
    return { res, state };
}

beforeEach(() => {
    delivered.slack.length = 0;
    delivered.telegram.length = 0;
    delivered.discord.length = 0;
    failedPlatform = null;
    settings['workingDir'] = '/approval-project';
    settings['projectDirs'] = ['/approval-project'];
    settings['dispatchApproval'] = { operators: { slack: ['U1'], telegram: [42], discord: ['D1'] }, ttlSeconds: 120 };
});

test('pending submission delivers every bound field to every operator channel and does not dispatch', async () => {
    let dispatchCalls = 0;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => { dispatchCalls++; throw new Error('dispatch must wait for approval'); }) as typeof fetch;
    try {
        const { res, state } = fakeRes();
        await pendingHandler({ body: { virtual: 'Reviewer', task: 'inspect the auth boundary', mutable: true, scope: 'src/core' }, headers: {} }, res);
        assert.equal(state.status, 202);
        assert.equal(dispatchCalls, 0, 'pending submission must not execute dispatch before approval');
        const expectedTaskDigest = createHash('sha256').update('inspect the auth boundary').digest('hex');
        const expectedExpiry = new Date(state.body!.expiresAt).toISOString();
        for (const platform of ['slack', 'telegram', 'discord'] as const) {
            assert.equal(delivered[platform].length, 1, `${platform} receives one operator DM`);
            const text = delivered[platform][0]!;
            assert.match(text, /Target: virtual:Reviewer/);
            assert.match(text, /Project root: \/approval-project/);
            assert.match(text, new RegExp(`Task digest: ${expectedTaskDigest}`));
            assert.match(text, /Mutable scope: src\/core/);
            assert.match(text, /Fan-out cap: 1/);
            assert.match(text, /Audience: cli-jaw:[0-9a-f-]{36}/);
            assert.match(text, new RegExp(`JTI: ${state.body!.jti}`));
            assert.match(text, new RegExp(`Expires: ${expectedExpiry.replaceAll('.', '\\.')}`));
        }
    } finally {
        globalThis.fetch = oldFetch;
    }
});

test('one configured channel delivery failure cancels pending fail-closed', async () => {
    failedPlatform = 'slack';
    let dispatchCalls = 0;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => { dispatchCalls++; throw new Error('dispatch must not run'); }) as typeof fetch;
    try {
        const { res, state } = fakeRes();
        await pendingHandler({ body: { agent: 'Backend', task: 'do not run', mutable: false }, headers: {} }, res);
        assert.equal(state.status, 503);
        const jti = /JTI: ([0-9a-f-]{36})/.exec(delivered.slack[0]!)?.[1];
        assert.ok(jti, 'delivery attempted with a concrete pending JTI');
        assert.equal(dispatchApprovalStore.get(jti!)?.status, 'cancelled');
        assert.equal(dispatchCalls, 0);
    } finally {
        globalThis.fetch = oldFetch;
    }
});
