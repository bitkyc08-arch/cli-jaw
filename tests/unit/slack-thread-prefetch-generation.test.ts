import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.ts';
import {
    bumpScopeSessionGeneration,
    bumpSessionOwnershipGeneration,
    getSessionOwnershipGeneration,
    resetSessionOwnershipGenerationForTest,
} from '../../src/agent/session-persistence.ts';
import {
    claimThreadPrefetch,
    commitThreadPrefetch,
    resetThreadPrefetchClaims,
} from '../../src/slack/thread-tracker.ts';

const submitted: string[] = [];
let threadMessages: Array<Record<string, unknown>> = [];

mock.module('../../src/orchestrator/gateway.ts', {
    namedExports: {
        submitMessage: (prompt: string) => {
            submitted.push(prompt);
            return { action: 'rejected', reason: 'duplicate', disposition: 'duplicate' };
        },
        dedupKey: () => 'generation-test',
    },
});

mock.module('../../src/slack/send-only-client.ts', {
    namedExports: {
        getSlackSendClient: () => ({ token: 'xoxb-test' }),
        sendSlackText: async () => ({ ok: true }),
    },
});

mock.module('../../src/slack/forwarder.ts', {
    namedExports: {
        createSlackForwarder: () => () => {},
        relaySlackImages: async () => {},
    },
});

mock.module('../../src/slack/attachment-recovery.ts', {
    namedExports: {
        recoverSlackAttachments: async () => [],
    },
});

mock.module('../../src/slack/conversation.ts', {
    namedExports: {
        resolveConversationInfo: async () => ({
            id: 'C1', name: 'general', kind: 'channel', resolved: true,
        }),
        resolveThreadInfo: async () => ({
            threadTs: '100.1', replyCount: threadMessages.length,
            participants: [], messages: threadMessages, resolved: true,
        }),
        cachedNameMap: () => new Map<string, string>(),
        resetSlackConversationCache: () => {},
    },
});

const { handleSlackEnvelope } = await import('../../src/slack/bot.ts');
const { resetSlackIngress, clearSlackEventDedupForTest } = await import('../../src/slack/ingress.ts');
const { primeSlackIdentityCache, resetSlackIdentityCache } =
    await import('../../src/slack/identity.ts');

const scope = 'jaw:slack:channel:C1:thread:100.1';

test.beforeEach(async () => {
    await resetSlackIngress();
    clearSlackEventDedupForTest();
    submitted.length = 0;
    threadMessages = [
        { ts: '100.1', user: 'U2', text: 'earlier context' },
        { ts: '100.3', user: 'U1', text: 'current' },
    ];
    resetThreadPrefetchClaims();
    resetSessionOwnershipGenerationForTest();
    resetSlackIdentityCache();
    primeSlackIdentityCache('T-generation', [{ id: 'U1', profile: { display_name: 'Jun' } }]);
    settings.slack.conversationContext = true;
    settings.slack.channelRoster = false;
    settings.slack.teamId = 'T-generation';
    settings.slack.senderIdentity = true;
    settings.slack.mentionOnly = true;
    settings.slack.threadRequireMention = false;
    settings.multiSession.enabled = true;
    settings.multiSession.channels.slack = true;
});

async function deliver(ts: string, text = 'current'): Promise<string> {
    const expected = submitted.length + 1;
    await handleSlackEnvelope({
        envelope_id: `E-${ts}`,
        type: 'events_api',
        payload: {
            event: {
                type: 'app_mention', channel: 'C1', user: 'U1', text,
                ts, thread_ts: '100.1',
            },
        },
    });
    for (let i = 0; submitted.length < expected && i < 20; i += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(submitted.length, expected, 'the envelope must reach admission');
    return submitted.at(-1) ?? '';
}

test('a scoped reset re-arms prefetch for the next message', async () => {
    assert.match(await deliver('100.3'), /earlier context/);
    const firstOwner = getSessionOwnershipGeneration(scope);
    assert.equal(claimThreadPrefetch('C1', '100.1', firstOwner), 0);

    bumpScopeSessionGeneration(scope);
    assert.match(await deliver('100.4', 'next'), /earlier context/);
});

test('a global settings bump also re-arms prefetch', async () => {
    assert.match(await deliver('100.3'), /earlier context/);

    bumpSessionOwnershipGeneration();
    assert.match(await deliver('100.4', 'next'), /earlier context/);
});

test('LRU pressure evicts completed claims without dropping a live owner', () => {
    const owner = getSessionOwnershipGeneration(scope);
    const live = claimThreadPrefetch('C-live', 'live.1', owner);
    for (let i = 0; i < 499; i += 1) {
        const threadTs = `done-${i}.1`;
        const token = claimThreadPrefetch('C-done', threadTs, owner);
        assert.ok(commitThreadPrefetch('C-done', threadTs, owner, token));
    }

    assert.ok(claimThreadPrefetch('C-new', 'new.1', owner) > 0);
    assert.equal(
        claimThreadPrefetch('C-live', 'live.1', owner), 0,
        'the in-flight claim must survive completed-entry eviction',
    );
    assert.ok(live > 0);
});

test('LRU pressure preserves a recently used completed claim', () => {
    const owner = getSessionOwnershipGeneration(scope);
    for (let i = 0; i < 500; i += 1) {
        const threadTs = `done-${i}.1`;
        const token = claimThreadPrefetch('C-done', threadTs, owner);
        assert.ok(commitThreadPrefetch('C-done', threadTs, owner, token));
    }
    assert.equal(
        claimThreadPrefetch('C-done', 'done-0.1', owner), 0,
        'touching the oldest claim makes it most recently used',
    );

    assert.ok(claimThreadPrefetch('C-new', 'new.1', owner) > 0);
    assert.equal(
        claimThreadPrefetch('C-done', 'done-0.1', owner), 0,
        'the recently used completed claim must survive eviction',
    );
    assert.ok(
        claimThreadPrefetch('C-done', 'done-1.1', owner) > 0,
        'a colder completed claim should have been evicted',
    );
});

test('without a bound session every message injects history', async () => {
    settings.multiSession.enabled = false;
    await deliver('100.3');
    await deliver('100.4', 'next');

    assert.equal(submitted.length, 2);
    assert.ok(submitted.every(prompt => prompt.includes('earlier context')));
});
