import { mock } from 'node:test';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

let socket: { emit(state: string): void } | null = null;
let stopped = 0;

mock.module('../../src/slack/api.ts', {
    namedExports: {
        slackApi: async (_token: string, method: string) => method === 'auth.test'
            ? { ok: true, data: { user_id: 'UBOT', team_id: 'T1' } }
            : { ok: true, data: {} },
        describeSlackError: (error?: string) => error ?? 'unknown',
        redactSlackTokens: (value: string) => value,
        isRetryableSlackError: () => false,
        neededScopeFrom: () => '',
        addSlackReaction: async () => ({ ok: true }),
        removeSlackReaction: async () => ({ ok: true }),
        deleteSlackMessage: async () => ({ ok: true }),
        updateSlackMessage: async () => ({ ok: true }),
        stripEmojiColons: (name: string) => name.replace(/^:+|:+$/g, ''),
        SLACK_CLEANUP_TIMEOUT_MS: 5000,
        listSlackConversations: async () => ({ ok: true, data: { channels: [] } }),
        joinSlackConversation: async () => ({ ok: true, data: {} }),
        slackFailure: (error: string, status?: number) => status === undefined
            ? { ok: false, error }
            : { ok: false, error, status },
    },
});

mock.module('../../src/slack/socket.ts', {
    namedExports: {
        HELLO_DEADLINE_MS: 15_000,
        SlackSocketClient: class {
            constructor(private options: { onStateChange?: (state: string) => void }) {
                socket = this;
            }
            async start() {
                if (process.env['SLACK_FIXTURE_INITIAL_HELLO'] === '1') this.emit('connected');
            }
            async waitForReady() {
                return process.env['SLACK_FIXTURE_INITIAL_HELLO'] === '1' ? 'connected' : 'timeout';
            }
            stop() { stopped++; this.options.onStateChange?.('disconnected'); }
            getState() { return 'connected'; }
            getReconnectAttempts() { return 0; }
            emit(state: string) { this.options.onStateChange?.(state); }
        },
    },
});

const [{ settings, JAW_HOME }, runtime, bot, claimModule] = await Promise.all([
    import('../../src/core/config.ts'),
    import('../../src/messaging/runtime.ts'),
    import('../../src/slack/bot.ts'),
    import('../../src/slack/token-claim.ts'),
]);

settings['port'] = process.env['SLACK_FIXTURE_PORT']!;
settings['slack'] = {
    enabled: true,
    botToken: 'xoxb-two-home-fixture',
    appToken: 'xapp-two-home-fixture',
    teamId: 'T1',
    attachPort: process.env['SLACK_FIXTURE_PORT']!,
    channelIds: [],
};
runtime.__resetTransportRegistryForTests();
runtime.registerTransport('slack', { init: ctx => bot.initSlack(ctx), shutdown: () => bot.shutdownSlack() });

function claimId(): string | null {
    try {
        return JSON.parse(readFileSync(claimModule.slackTokenClaimPath('xapp-two-home-fixture'), 'utf8')).claimId;
    } catch {
        return null;
    }
}

function report(event: string, extra: Record<string, unknown> = {}): void {
    process.stdout.write(`FIXTURE ${JSON.stringify({
        event,
        home: JAW_HOME,
        running: runtime.isMessagingTransportRunning('slack'),
        stopped,
        claimId: claimId(),
        ...extra,
    })}\n`);
}

const outcome = await runtime.startMessagingTransport('slack');
report('ready', { outcome });

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
    void (async () => {
        if (line === 'hello') {
            socket?.emit('connected');
            await new Promise(resolve => setImmediate(resolve));
            report('hello');
        } else if (line === 'status') {
            report('status');
        } else if (line === 'shutdown') {
            await bot.shutdownSlack();
            report('shutdown');
            process.exit(0);
        }
    })();
});
