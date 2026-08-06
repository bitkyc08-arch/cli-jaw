// Thread continuation gate: a thread the bot participates in (started by a
// mention, or the bot replied into it) keeps flowing without re-mention.
// Plan: devlog/_plan/260806_slack_thread_dynamic_lookup/010.
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
    isParticipatedThread: () => false,
    ...over,
});

const participated = (channel: string, ts: string) =>
    (c: string, t: string) => c === channel && t === ts;

// ─── gate: thread continuation ──────────────────────

test('unmentioned reply in a participated thread is processed', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'U2', text: 'follow-up', thread_ts: '100.1' },
        gate({ isParticipatedThread: participated('C1', '100.1') }),
        'events_api',
    );
    assert.deepEqual(d, { process: true });
});

test('unmentioned reply in a non-participated thread still requires a mention', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'U2', text: 'hi', thread_ts: '200.1' },
        gate({ isParticipatedThread: participated('C1', '100.1') }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'mention_required' });
});

test('threadRequireMention=true keeps the strict gate even in participated threads', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'U2', text: 'hi', thread_ts: '100.1' },
        gate({ threadRequireMention: true, isParticipatedThread: participated('C1', '100.1') }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'mention_required' });
});

test('top-level channel message (no thread_ts) still requires a mention', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'U2', text: 'hi' },
        gate({ isParticipatedThread: () => true }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'mention_required' });
});

test('self message in a participated thread is still dropped (gate order preserved)', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', user: 'UBOT', text: 'echo', thread_ts: '100.1' },
        gate({ isParticipatedThread: () => true }),
        'events_api',
    );
    assert.deepEqual(d, { process: false, reason: 'self_message' });
});

test('bot message in a participated thread is still gated by allowBots', () => {
    const d = shouldProcessSlackEvent(
        { type: 'message', channel: 'C1', bot_id: 'B9', text: 'bot says', thread_ts: '100.1' },
        gate({ isParticipatedThread: () => true }),
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
