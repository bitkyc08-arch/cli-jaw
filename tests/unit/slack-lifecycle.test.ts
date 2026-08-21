import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// initSlack/shutdownSlack lifecycle. Isolated in its own file because it mocks
// the socket client and the send path.

const state: {
    started: number;
    stopped: number;
    authOk: boolean;
} = { started: 0, stopped: 0, authOk: true };

mock.module('../../src/slack/api.ts', {
    namedExports: {
        slackApi: async (_token: string, method: string) => {
            if (method === 'auth.test') {
                return state.authOk
                    ? { ok: true, data: { user_id: 'UBOT', team_id: 'T1' } }
                    : { ok: false, error: 'invalid_auth' };
            }
            return { ok: true, data: {} };
        },
        describeSlackError: (e?: string) => e ?? 'unknown',
        redactSlackTokens: (s: string) => s,
        isRetryableSlackError: () => false,
        // inbound-file.ts imports this from the same module; a partial mock
        // that omits it makes the whole import graph fail to link.
        neededScopeFrom: () => '',
        // Same rule for the ACK/notice wrappers bot.ts pulls in (#412): every
        // named import in the graph has to exist here or nothing links.
        addSlackReaction: async () => ({ ok: true }),
        removeSlackReaction: async () => ({ ok: true }),
        deleteSlackMessage: async () => ({ ok: true }),
        updateSlackMessage: async () => ({ ok: true }),
        stripEmojiColons: (name: string) => name.replace(/^:+|:+$/g, ''),
        SLACK_CLEANUP_TIMEOUT_MS: 5000,
        slackFailure: (error: string, status?: number) =>
            status === undefined ? { ok: false, error } : { ok: false, error, status },
    },
});

mock.module('../../src/slack/socket.ts', {
    namedExports: {
        SlackSocketClient: class {
            async start() { state.started++; }
            stop() { state.stopped++; }
            getState() { return 'connected'; }
            getReconnectAttempts() { return 0; }
        },
    },
});

async function loadBot(slack: Record<string, unknown>) {
    const { settings } = await import('../../src/core/config.ts');
    (settings as Record<string, unknown>)['slack'] = slack;
    return import('../../src/slack/bot.ts');
}

test('initSlack actually starts the socket for a fully configured workspace', async () => {
    // Regression: initSlack claimed a lifecycle generation BEFORE calling
    // shutdownSlack, whose own bump then invalidated it — so every normal
    // start aborted after auth.test and Slack inbound never came up at all.
    state.started = 0;
    state.stopped = 0;
    state.authOk = true;

    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t' });
    await bot.initSlack();
    assert.equal(state.started, 1, 'the socket never started — init self-superseded');
    assert.equal(bot.getSlackSelfUserId(), 'UBOT', 'auth identity was not recorded');

    await bot.shutdownSlack();
    assert.equal(state.stopped >= 1, true, 'shutdown did not stop the socket');
    assert.equal(bot.getSlackSelfUserId(), null);
});

test('initSlack stays outbound-only without an app token', async () => {
    state.started = 0;
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: '' });
    await bot.initSlack();
    assert.equal(state.started, 0, 'inbound must not start without the app-level token');
});

test('initSlack does nothing when slack is disabled', async () => {
    state.started = 0;
    const bot = await loadBot({ enabled: false, botToken: 'xoxb-t', appToken: 'xapp-t' });
    await bot.initSlack();
    assert.equal(state.started, 0);
});

test('initSlack aborts cleanly on an auth failure', async () => {
    state.started = 0;
    state.authOk = false;
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-bad', appToken: 'xapp-t' });
    await bot.initSlack();
    assert.equal(state.started, 0, 'a failed auth.test must not open a socket');
    state.authOk = true;
});

test('shutdownSlack is safe to call when nothing is running', async () => {
    const bot = await loadBot({ enabled: false });
    await assert.doesNotReject(() => bot.shutdownSlack());
});

test('an external shutdown during init is not lost', async () => {
    // Regression: initSlack awaited its own teardown BEFORE claiming a
    // generation, so a shutdown landing in that window was overwritten and the
    // init resumed to start a transport the caller had already stopped.
    state.started = 0;
    state.stopped = 0;
    state.authOk = true;

    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t' });
    const pending = bot.initSlack();
    await bot.shutdownSlack();
    await pending;

    assert.equal(
        bot.getSlackSelfUserId(),
        null,
        'init resurrected the transport after an external shutdown',
    );
});

test('an init that arrives during another init is not discarded', async () => {
    // Regression: a rapid disable/re-enable sequence (init -> shutdown ->
    // init) dropped the final start because the second init returned early on
    // the lock while the first was aborting. Slack stayed off until something
    // else happened to call init again.
    state.started = 0;
    state.stopped = 0;
    state.authOk = true;

    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t' });
    const first = bot.initSlack();
    await bot.shutdownSlack();     // supersedes the first init
    const second = bot.initSlack(); // lands while the first is still unwinding
    await Promise.all([first, second]);

    assert.equal(
        bot.getSlackSelfUserId(),
        'UBOT',
        'the final init request was dropped and Slack stayed off',
    );
    assert.ok(state.started >= 1, 'no socket was ever started');
    await bot.shutdownSlack();
});

test('repeated inits settle without runaway recursion', async () => {
    state.started = 0;
    state.authOk = true;
    const bot = await loadBot({ enabled: true, botToken: 'xoxb-t', appToken: 'xapp-t' });
    await Promise.all([bot.initSlack(), bot.initSlack(), bot.initSlack()]);
    assert.ok(state.started <= 3, `init ran away: ${state.started} starts`);
    await bot.shutdownSlack();
});
