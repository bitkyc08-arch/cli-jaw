// Restoring a queue notice across a restart (#418).
//
// The store keeps the id; this is the half that turns that id back into a closed
// notice. What matters here is what a boot drain does with records it finds, and
// what it does when the transport it needs is not there.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
    QueueNoticeStore,
    __resetQueueNoticeStoreForTests,
} from '../../src/messaging/queue-notice-store.ts';
import { restoreQueueNotices } from '../../src/messaging/queue-notice-restore.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

const TARGET: RemoteTarget = {
    channel: 'slack', targetKind: 'channel', peerKind: 'group', targetId: 'C123',
};

function seeded(requestIds: string[]): QueueNoticeStore {
    const s = new QueueNoticeStore(new Database(':memory:'), { now: () => 1_000 });
    for (const id of requestIds) {
        s.reserve({ requestId: id, channel: 'slack', target: TARGET });
        s.attachMessageId(id, `ts-${id}`);
    }
    return s;
}

test.beforeEach(() => { __resetQueueNoticeStoreForTests(); });

test('a restored record is rewritten as expired and then dropped', async () => {
    const store = seeded(['req-1']);
    const edited: Array<{ messageId: string; text: string }> = [];

    await restoreQueueNotices({
        store,
        channel: 'slack',
        expiredText: 'This turn did not finish.',
        transport: (record) => ({
            delete: async () => { throw new Error('restore must not delete'); },
            edit: async (text) => { edited.push({ messageId: record.messageId, text }); },
        }),
    });

    assert.deepEqual(edited, [{ messageId: 'ts-req-1', text: 'This turn did not finish.' }]);
    assert.equal(store.findByRequestId('req-1'), null, 'a closed notice must not be restored again');
});

test('a transport failure still drops the record so the next boot does not retry forever', async () => {
    const store = seeded(['req-1']);
    const errors: unknown[] = [];

    await restoreQueueNotices({
        store,
        channel: 'slack',
        expiredText: 'expired',
        transport: () => ({
            delete: async () => {},
            edit: async () => { throw new Error('channel_not_found'); },
        }),
        onError: (e) => errors.push(e),
    });

    assert.equal(errors.length, 1, 'the failure is reported, not swallowed silently');
    assert.equal(
        store.findByRequestId('req-1'), null,
        'a message we cannot rewrite is not one we can rewrite next boot either',
    );
});

test('a record whose transport cannot be built is left for a later boot', async () => {
    const store = seeded(['req-1']);

    await restoreQueueNotices({
        store,
        channel: 'slack',
        expiredText: 'expired',
        // No credentials yet, or the client is not connected: this is a temporary
        // condition, unlike a vendor rejection.
        transport: () => null,
    });

    assert.ok(store.findByRequestId('req-1'), 'the id is still the only way to close this notice');
});

test('every record is attempted even when one of them throws', async () => {
    const store = seeded(['req-1', 'req-2', 'req-3']);
    const attempted: string[] = [];

    await restoreQueueNotices({
        store,
        channel: 'slack',
        expiredText: 'expired',
        transport: (record) => ({
            delete: async () => {},
            edit: async () => {
                attempted.push(record.requestId);
                if (record.requestId === 'req-2') throw new Error('boom');
            },
        }),
        onError: () => {},
    });

    assert.deepEqual(attempted, ['req-1', 'req-2', 'req-3']);
});

test('records belonging to another channel are left alone', async () => {
    const store = new QueueNoticeStore(new Database(':memory:'), { now: () => 1_000 });
    store.reserve({ requestId: 'tg-1', channel: 'telegram', target: TARGET });
    store.attachMessageId('tg-1', '42');
    let edits = 0;

    await restoreQueueNotices({
        store,
        channel: 'slack',
        expiredText: 'expired',
        transport: () => ({ delete: async () => {}, edit: async () => { edits++; } }),
    });

    assert.equal(edits, 0);
    assert.ok(store.findByRequestId('tg-1'), 'the telegram transport still owns this one');
});

