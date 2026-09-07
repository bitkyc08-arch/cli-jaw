// Thread continuation gate: a thread the bot participates in (started by a
// mention, or the bot replied into it) keeps flowing without re-mention.

import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldProcessSlackEvent, type SlackGateConfig } from '../../src/slack/events.ts';
import {
    markThreadParticipated,
    isThreadParticipated,
    threadParticipationKind,
    resetThreadTrackerForTest,
    threadKey,
    SLACK_THREADS_CAP,
} from '../../src/slack/thread-tracker.ts';

const gate = (over: Partial<SlackGateConfig> = {}): SlackGateConfig => ({
    selfUserId: 'UBOT',
    allowBots: false,
    mentionOnly: true,
    channelIds: [],
    threadRequireMention: false,
    threadParticipation: () => null,
    ...over,
});

/** The bot's own thread: its reply is the parent, so follow-ups need no mention. */
const owned = (channel: string, ts: string) =>
    (c: string, t: string) => (c === channel && t === ts ? 'owned' as const : null);

/** A thread the bot was pulled into partway; the rest is still other people talking. */
const joined = (channel: string, ts: string) =>
    (c: string, t: string) => (c === channel && t === ts ? 'joined' as const : null);

// ─── gate: thread continuation ──────────────────────

test('unmentioned reply in a thread the bot started is processed', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'U2', text: 'follow-up', thread_ts: '100.1' },
        gate({ threadParticipation: owned('C1', '100.1') }),
        'events_api',
    );
    assert.deepEqual(d, { process: true });
});

// THE #400 regression. One mention inside a thread that people were already using
// used to hand the bot every later message in it, whoever they were talking to.
test('unmentioned reply in a thread the bot only joined still requires a mention', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'U2', text: '<@U0BC2MR8U03> 지상님 주신거', thread_ts: '100.1' },
        gate({ threadParticipation: joined('C1', '100.1') }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'mention_required' });
});

test('a mention in a joined thread is still processed', () => {
    // Slack delivers a mention as BOTH a message copy and an app_mention copy; the
    // message copy is dropped as mention_via_app_mention so one mention is not two
    // runs. The canonical copy is the one asserted here.
    const d = shouldProcessSlackEvent(
        { type: 'app_mention', channel: 'C1', user: 'U2', text: 'hey <@UBOT> look', thread_ts: '100.1' },
        gate({ threadParticipation: joined('C1', '100.1') }),
        'events_api',
    );
    assert.deepEqual(d, { process: true });
});

test('the message copy of that mention is still deduped, not gated away', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'U2', text: 'hey <@UBOT> look', thread_ts: '100.1' },
        gate({ threadParticipation: joined('C1', '100.1') }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'mention_via_app_mention' });
});

test('unmentioned reply in a non-participated thread still requires a mention', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'U2', text: 'hi', thread_ts: '200.1' },
        gate({ threadParticipation: owned('C1', '100.1') }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'mention_required' });
});

test('threadRequireMention=true keeps the strict gate even in participated threads', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'U2', text: 'hi', thread_ts: '100.1' },
        gate({ threadRequireMention: true, threadParticipation: owned('C1', '100.1') }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'mention_required' });
});

test('top-level channel message (no thread_ts) still requires a mention', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'U2', text: 'hi' },
        gate({ threadParticipation: () => 'owned' }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'mention_required' });
});

test('self message in a participated thread is still dropped (gate order preserved)', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'UBOT', text: 'echo', thread_ts: '100.1' },
        gate({ threadParticipation: () => 'owned' }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'self_message' });
});

test('bot message in a participated thread is still gated by allowBots', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', bot_id: 'B9', text: 'bot says', thread_ts: '100.1' },
        gate({ threadParticipation: () => 'owned' }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'bot_message' });
});

test('DMs bypass the mention gate regardless of thread participation', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'D1', channel_type: 'im', user: 'U2', text: 'dm' },
        gate(),
        'events_api',
    );
    assert.deepEqual(d, { process: true });
});

// ─── tracker: persistence semantics ─────────────────

function freshStore(): string {
    const file = join(mkdtempSync(join(tmpdir(), 'slack-threads-')), 'slack-threads.json');
    resetThreadTrackerForTest(file);
    return file;
}

test('mark → is round-trips and keys are channel-scoped', () => {
    freshStore();
    markThreadParticipated('C1', '100.1');
    assert.equal(isThreadParticipated('C1', '100.1'), true);
    assert.equal(isThreadParticipated('C2', '100.1'), false);
    assert.equal(threadKey('C1', '100.1'), 'C1:100.1');
});

test('participation survives a reload from disk', () => {
    const file = freshStore();
    markThreadParticipated('C1', '100.1');
    // Simulate a restart: drop the in-memory cache, keep the file.
    resetThreadTrackerForTest(file);
    assert.equal(isThreadParticipated('C1', '100.1'), true);
});

test('corrupt store file degrades to an empty set', () => {
    const file = freshStore();
    writeFileSync(file, '{not json');
    resetThreadTrackerForTest(file);
    assert.equal(isThreadParticipated('C1', '100.1'), false);
    // and marking still works after the corrupt read
    markThreadParticipated('C1', '100.1');
    assert.equal(isThreadParticipated('C1', '100.1'), true);
});

test('cap trims the least-recently-marked half', () => {
    freshStore();
    for (let i = 0; i <= SLACK_THREADS_CAP; i++) {
        markThreadParticipated('C1', `${i}.0`);
    }
    // Oldest entries were trimmed; the newest survives.
    assert.equal(isThreadParticipated('C1', '0.0'), false);
    assert.equal(isThreadParticipated('C1', `${SLACK_THREADS_CAP}.0`), true);
});

test('empty channel or thread_ts never marks or matches', () => {
    freshStore();
    markThreadParticipated('', '100.1');
    markThreadParticipated('C1', '');
    assert.equal(isThreadParticipated('', '100.1'), false);
    assert.equal(isThreadParticipated('C1', ''), false);
});

// A store written before ownership existed holds bare numbers. Those records must
// survive the upgrade — losing them turns every open thread back into "mention
// required", which reads as the bot ignoring people mid-conversation — but their
// kind is unknowable, so they read as `joined`. Guessing `owned` would carry #400
// forward for everyone who already has this file.
test('legacy numeric records load as joined rather than owned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slack-threads-legacy-'));
    const file = join(dir, 'slack-threads.json');
    writeFileSync(file, JSON.stringify({ 'C1:100.1': 1787197301899 }), 'utf8');
    resetThreadTrackerForTest(file);

    assert.equal(isThreadParticipated('C1', '100.1'), true, 'the record must survive');
    assert.equal(threadParticipationKind('C1', '100.1'), 'joined');

    // And the gate consulted with that kind asks for a mention.
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'U2', text: 'follow-up', thread_ts: '100.1' },
        gate({ threadParticipation: threadParticipationKind }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'mention_required' });
});

test('ownership is recorded on first sight and never upgraded by a later reply', () => {
    freshStore();

    // Invited into someone else's thread...
    markThreadParticipated('C1', '100.1', 'joined');
    // ...and the bot's own reply into it must not promote the thread to ours.
    markThreadParticipated('C1', '100.1');
    assert.equal(threadParticipationKind('C1', '100.1'), 'joined');

    // A thread the bot parents stays owned across later replies.
    markThreadParticipated('C2', '200.1', 'owned');
    markThreadParticipated('C2', '200.1');
    assert.equal(threadParticipationKind('C2', '200.1'), 'owned');
});

test('a kind that round-trips through disk keeps its meaning', () => {
    const file = freshStore();
    markThreadParticipated('C1', '100.1', 'owned');
    resetThreadTrackerForTest(file);
    assert.equal(threadParticipationKind('C1', '100.1'), 'owned');
});

test('threadParticipationKind is null for a thread never seen', () => {
    freshStore();
    assert.equal(threadParticipationKind('C1', '999.9'), null);
});

