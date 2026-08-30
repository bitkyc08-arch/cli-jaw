// The legacy quarantine state machine. Two failure shapes are what this guards:
// a job held forever because the v1 rows never go away, and a job that slips past
// the hold because detection ran only once.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    detectLegacyMentionWatch,
    isQuarantined,
    quarantineState,
    approveLegacyFreshStart,
} from '../../src/memory/legacy-mention-watch-quarantine.ts';
import { insertMentionWatchSeen, upsertMentionWatchCursor, getLegacyQuarantine } from '../../src/core/db.ts';

/** Write a v1 row, which is what an unmigrated ledger looks like. */
function seedLegacy(jobId: string, channelId = 'C_LEGACY', ts = '900.000100') {
    insertMentionWatchSeen.run(jobId, channelId, ts, Date.now());
    upsertMentionWatchCursor.run(jobId, channelId, ts, Date.now());
}

test('a job with v1 rows is held', () => {
    const job = 'q_basic';
    seedLegacy(job);
    const held = detectLegacyMentionWatch(1);
    assert.ok(held.includes(job));
    assert.equal(isQuarantined(job), true);
});

test('detection is idempotent and does not re-pend a resolved job', () => {
    const job = 'q_idempotent';
    seedLegacy(job);
    detectLegacyMentionWatch(1);
    detectLegacyMentionWatch(2);
    assert.equal(isQuarantined(job), true);

    assert.equal(approveLegacyFreshStart(job, 'since=1000.0', 3), 'resolved');
    assert.equal(isQuarantined(job), false);
    // Re-running detection must not drag it back: the v1 rows are gone now.
    detectLegacyMentionWatch(4);
    assert.equal(isQuarantined(job), false);
});

test('approval archives the v1 rows and removes them', () => {
    const job = 'q_archive';
    seedLegacy(job, 'C_ARCH', '901.000100');
    detectLegacyMentionWatch(1);
    assert.equal(approveLegacyFreshStart(job, 'since=1001.0', 2), 'resolved');
    // The rows are gone from v1, which is what stops them re-triggering.
    detectLegacyMentionWatch(3);
    assert.equal(isQuarantined(job), false);
    // And the resolution is recorded for the operator.
    assert.equal(quarantineState(job)?.resolution, 'since=1001.0');
});

test('a repeated approval reports the success it already has', () => {
    const job = 'q_retry';
    seedLegacy(job);
    detectLegacyMentionWatch(1);
    assert.equal(approveLegacyFreshStart(job, 'since=1002.0', 2), 'resolved');
    // A caller that lost the response and asked again.
    assert.equal(approveLegacyFreshStart(job, 'since=1002.0', 3), 'already-resolved');
    assert.equal(quarantineState(job)?.resolution, 'since=1002.0');
});

test('a conflicting approval is refused rather than overwriting', () => {
    const job = 'q_conflict';
    seedLegacy(job);
    detectLegacyMentionWatch(1);
    approveLegacyFreshStart(job, 'since=1003.0', 2);
    assert.equal(approveLegacyFreshStart(job, 'since=9999.0', 3), 'conflict');
    assert.equal(quarantineState(job)?.resolution, 'since=1003.0', 'a second decision overwrote the first');
});

test('approving a job that was never held is not a silent success', () => {
    assert.equal(approveLegacyFreshStart('q_never_held', 'since=1.0', 1), 'not-pending');
});

test('v1 rows reappearing after a downgrade re-hold the job', () => {
    // The rollback path: an older build still writes v1, and those receipts exist
    // nowhere in v2, so resuming on v2 would answer them again.
    const job = 'q_rollback';
    seedLegacy(job, 'C_RB', '902.000100');
    detectLegacyMentionWatch(1);
    approveLegacyFreshStart(job, 'since=1004.0', 2);
    assert.equal(isQuarantined(job), false);

    seedLegacy(job, 'C_RB', '903.000100');
    const held = detectLegacyMentionWatch(5);
    assert.ok(held.includes(job), 'a downgrade that rewrote v1 rows did not re-hold the job');
    assert.equal(isQuarantined(job), true);
    // The stale resolution must not survive: it described a decision made before
    // these new rows existed.
    const row = getLegacyQuarantine.get(job) as { resolution?: string | null } | undefined;
    assert.equal(row?.resolution ?? null, null);
});

test('a job with no v1 rows is never held', () => {
    detectLegacyMentionWatch(1);
    assert.equal(isQuarantined('q_clean_job'), false);
    assert.equal(quarantineState('q_clean_job'), null);
});
