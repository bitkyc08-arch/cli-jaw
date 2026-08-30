// The guarantee that one forgotten SQL predicate cannot merge two people's
// ledgers. Every case builds namespaces A and B over the SAME job id, channel and
// message ts, differing only in workspace or user, then asserts that a write
// through one is invisible to the other. A source-level check could not do this:
// a method can accept a namespace and still leave it out of its WHERE clause.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    watchNamespace,
    hasSeenMention,
    recordSeenMention,
    pruneSeenMentions,
    readCursor,
    advanceCursor,
    setResumeBefore,
    readRotation,
    recordRotation,
} from '../../src/memory/mention-watch-ledger.ts';

const JOB = 'hb_shared_id';
const CHANNEL = 'C0BDW33068P';
const TS = '100.000100';

function ns(workspace: string, user: string) {
    const value = watchNamespace(JOB, workspace, user);
    assert.ok(value, 'namespace should be valid');
    return value;
}

// Same job, same channel, same ts. Only identity differs.
const A = ns('T_AAA', 'U_SUJI');
const B_USER = ns('T_AAA', 'U_OTHER');
const B_TEAM = ns('T_BBB', 'U_SUJI');

test('a namespace needs all three parts', () => {
    assert.equal(watchNamespace('', 'T', 'U'), null);
    assert.equal(watchNamespace('j', '', 'U'), null);
    assert.equal(watchNamespace('j', 'T', ''), null);
    assert.equal(watchNamespace('j', 'T', null), null);
});

test('ids are trimmed, so padding cannot mint a second identity', () => {
    const padded = watchNamespace('  j  ', ' T ', ' U ');
    assert.deepEqual(padded, { jobId: 'j', workspaceId: 'T', userId: 'U' });
});

test('a seen receipt is invisible to another user under the same job', () => {
    recordSeenMention(A, CHANNEL, '201.000100', 1);
    assert.equal(hasSeenMention(A, CHANNEL, '201.000100'), true);
    assert.equal(hasSeenMention(B_USER, CHANNEL, '201.000100'), false);
});

test('a seen receipt is invisible to the same user in another workspace', () => {
    // The case that keying on user id alone would get wrong: the runtime can
    // re-authenticate against a different workspace without restarting.
    recordSeenMention(A, CHANNEL, '202.000100', 1);
    assert.equal(hasSeenMention(B_TEAM, CHANNEL, '202.000100'), false);
});

test('pruning one namespace leaves the other receipts alone', () => {
    recordSeenMention(A, CHANNEL, '203.000100', 1);
    recordSeenMention(B_USER, CHANNEL, '203.000100', 1);
    pruneSeenMentions(A, CHANNEL, '203.000100');
    assert.equal(hasSeenMention(A, CHANNEL, '203.000100'), false);
    assert.equal(hasSeenMention(B_USER, CHANNEL, '203.000100'), true, 'prune crossed into another ledger');
});

test('a cursor is not shared across users', () => {
    advanceCursor(A, CHANNEL, '301.000100', 1);
    assert.equal(readCursor(A, CHANNEL).lastTs, '301.000100');
    assert.equal(readCursor(B_USER, CHANNEL).lastTs, undefined);
});

test('a cursor is not shared across workspaces', () => {
    advanceCursor(A, 'C_TEAMTEST', '302.000100', 1);
    assert.equal(readCursor(B_TEAM, 'C_TEAMTEST').lastTs, undefined);
});

test('advancing one cursor does not move another', () => {
    advanceCursor(A, 'C_BOTH', '400.000100', 1);
    advanceCursor(B_USER, 'C_BOTH', '400.000200', 1);
    advanceCursor(A, 'C_BOTH', '400.000300', 2);
    assert.equal(readCursor(A, 'C_BOTH').lastTs, '400.000300');
    assert.equal(readCursor(B_USER, 'C_BOTH').lastTs, '400.000200', 'cursor write crossed namespaces');
});

test('a resume write does not borrow another namespace last_ts', () => {
    // The subquery inside setResumeBefore is the subtle one: it reads last_ts to
    // preserve it, and reading it from the wrong row would import a cursor.
    advanceCursor(B_USER, 'C_RESUME', '500.000900', 1);
    setResumeBefore(A, 'C_RESUME', '500.000100', 2);
    const a = readCursor(A, 'C_RESUME');
    assert.equal(a.resumeBefore, '500.000100');
    assert.equal(a.lastTs, undefined, 'resume write imported another namespace cursor');
    // And B is untouched.
    const b = readCursor(B_USER, 'C_RESUME');
    assert.equal(b.lastTs, '500.000900');
    assert.equal(b.resumeBefore, undefined);
});

test('a resume write preserves its OWN last_ts', () => {
    advanceCursor(A, 'C_KEEP', '600.000100', 1);
    setResumeBefore(A, 'C_KEEP', '600.000050', 2);
    const row = readCursor(A, 'C_KEEP');
    assert.equal(row.lastTs, '600.000100', 'resume write clobbered its own cursor');
    assert.equal(row.resumeBefore, '600.000050');
});

test('clearing a resume bound leaves the cursor in place', () => {
    advanceCursor(A, 'C_CLEAR', '700.000100', 1);
    setResumeBefore(A, 'C_CLEAR', '700.000050', 2);
    setResumeBefore(A, 'C_CLEAR', null, 3);
    const row = readCursor(A, 'C_CLEAR');
    assert.equal(row.resumeBefore, undefined);
    assert.equal(row.lastTs, '700.000100');
});

test('rotation is per namespace', () => {
    recordRotation(A, 'C_ONE', 1);
    recordRotation(B_USER, 'C_TWO', 1);
    assert.equal(readRotation(A), 'C_ONE');
    assert.equal(readRotation(B_USER), 'C_TWO');
    assert.equal(readRotation(B_TEAM), undefined);
});

test('the empty last_ts placeholder never reads as a cursor', () => {
    // A resume-only write creates the row with last_ts '', which must not be
    // mistaken for a cursor at ts 0 — that would skip the entire channel.
    setResumeBefore(A, 'C_PLACEHOLDER', '800.000100', 1);
    assert.equal(readCursor(A, 'C_PLACEHOLDER').lastTs, undefined);
});
