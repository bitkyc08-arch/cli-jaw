// The acceptance criteria of #418, driven end to end against the store.
//
// These are the failure shapes the issue named: a restart that must still close
// the notice, a durable write that itself fails, and the two crash orderings
// between reserving a record and posting the message. Each is exercised through
// the same reserve -> attach -> close sequence the three channel modules perform,
// so the test fails if that sequence is reordered.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { QueueNoticeStore } from '../../src/messaging/queue-notice-store.ts';
import { restoreQueueNotices } from '../../src/messaging/queue-notice-restore.ts';
import { createQueueNotice } from '../../src/messaging/queue-notice.ts';
import type { MessengerChannel, RemoteTarget } from '../../src/messaging/types.ts';

const EXPIRED = '대기 시간이 초과되었습니다';

const TARGETS: Record<MessengerChannel, RemoteTarget> = {
    slack: { channel: 'slack', targetKind: 'channel', peerKind: 'group', targetId: 'C1', threadId: '1.1' },
    telegram: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100999' },
    discord: { channel: 'discord', targetKind: 'channel', peerKind: 'group', targetId: '555' },
};

/** The durable half of what a channel does when a turn is queued. */
function postNotice(store: QueueNoticeStore, channel: MessengerChannel, requestId: string, messageId: string) {
    store.reserve({ requestId, channel, target: TARGETS[channel] });
    store.attachMessageId(requestId, messageId);
}

function freshStore(): QueueNoticeStore {
    return new QueueNoticeStore(new Database(':memory:'), { now: () => 1_000 });
}

for (const channel of ['slack', 'telegram', 'discord'] as const) {
    test(`[${channel}] a restart rewrites the notice the dead process could not reach`, async () => {
        const database = new Database(':memory:');
        // Previous run: the notice is posted, then the process dies. Nothing
        // closes it, because the handle that could lived in that process.
        postNotice(new QueueNoticeStore(database, { now: () => 1_000 }), channel, 'req-1', 'mid-1');

        // New run: a new store over the same database is all the restore has.
        const rebooted = new QueueNoticeStore(database, { now: () => 2_000 });
        const edits: Array<{ targetId: string; messageId: string; text: string }> = [];
        await restoreQueueNotices({
            store: rebooted,
            channel,
            expiredText: EXPIRED,
            transport: (record) => ({
                delete: async () => { throw new Error('a restart must never delete the only trace of the turn'); },
                edit: async (text) => {
                    edits.push({ targetId: record.target.targetId, messageId: record.messageId, text });
                },
            }),
        });

        assert.deepEqual(edits, [{
            targetId: TARGETS[channel].targetId,
            messageId: 'mid-1',
            text: EXPIRED,
        }]);
        assert.equal(rebooted.findByRequestId('req-1'), null, 'a restored notice must not be restored twice');
    });
}

test('a turn that closed its own notice leaves nothing for the next boot', async () => {
    const store = freshStore();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    const calls: string[] = [];
    notice.bind({
        delete: async () => { calls.push('delete'); },
        edit: async () => { calls.push('edit'); },
    });

    postNotice(store, 'slack', 'req-1', 'ts-1');
    // The live path: the answer went out, so the notice is deleted and the record
    // is dropped alongside it.
    await notice.close('answered');
    store.close('req-1');

    assert.deepEqual(calls, ['delete']);
    let restoreEdits = 0;
    await restoreQueueNotices({
        store, channel: 'slack', expiredText: EXPIRED,
        transport: () => ({ delete: async () => {}, edit: async () => { restoreEdits++; } }),
    });
    assert.equal(restoreEdits, 0, 'rewriting an answered turn would contradict the answer above it');
});

test('a store that throws does not break the turn the user is waiting on', async () => {
    // Residual risk 1 in the issue: the durable write itself can fail. The three
    // channel modules wrap every store call for this reason, and this pins the
    // contract that makes that wrapping correct — the notice still works.
    const exploding = {
        reserve() { throw new Error('database is locked'); },
        attachMessageId() { throw new Error('database is locked'); },
        close() { throw new Error('database is locked'); },
    };
    const notice = createQueueNotice({ expiredText: EXPIRED });
    const calls: string[] = [];
    notice.bind({
        delete: async () => { calls.push('delete'); },
        edit: async () => { calls.push('edit'); },
    });

    const guarded = (fn: () => void) => { try { fn(); } catch { /* best-effort, as the channels do */ } };
    guarded(() => exploding.reserve());
    guarded(() => exploding.attachMessageId());
    await notice.close('answered');
    guarded(() => exploding.close());

    assert.deepEqual(calls, ['delete'], 'the live notice lifecycle is independent of the durable record');
});

test('a crash between reserving and posting leaves nothing to restore', async () => {
    // Residual risk 2, first ordering: the record exists, the message does not.
    const store = freshStore();
    store.reserve({ requestId: 'req-1', channel: 'slack', target: TARGETS.slack });
    // Process dies here — attachMessageId never ran.

    let attempted = 0;
    await restoreQueueNotices({
        store, channel: 'slack', expiredText: EXPIRED,
        transport: () => { attempted++; return { delete: async () => {}, edit: async () => {} }; },
    });

    assert.equal(attempted, 0, 'there is no posted message behind this record to rewrite');
});

test('a message posted before its record was attached stays unreachable, and says so', async () => {
    // Residual risk 2, other ordering. This one is NOT recoverable, and the test
    // exists to keep that honest rather than imply a guarantee the design does
    // not make: attach reports false, and nothing is invented to cover it.
    const store = freshStore();
    assert.equal(store.attachMessageId('req-never-reserved', 'ts-1'), false);
    assert.equal(store.listRestorable('slack').length, 0);
});

test('one channel restoring does not touch another channel\'s records', async () => {
    const store = freshStore();
    postNotice(store, 'slack', 'slack-1', 'ts-1');
    postNotice(store, 'telegram', 'tg-1', '42');
    postNotice(store, 'discord', 'dc-1', '999');

    await restoreQueueNotices({
        store, channel: 'slack', expiredText: EXPIRED,
        transport: () => ({ delete: async () => {}, edit: async () => {} }),
    });

    assert.equal(store.findByRequestId('slack-1'), null);
    assert.ok(store.findByRequestId('tg-1'), 'telegram closes its own notices when its transport is up');
    assert.ok(store.findByRequestId('dc-1'), 'and so does discord');
});

