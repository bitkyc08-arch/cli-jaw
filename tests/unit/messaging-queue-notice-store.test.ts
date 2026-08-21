// Durable queue-notice records (#418).
//
// The notice handle is process-local, so a restart loses the only thing that can
// close it out. These tests pin the store that survives that: what is written
// before the notice is posted, what a boot drain can find, and what happens when
// the two halves of that write land out of order.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
    QueueNoticeStore,
    initQueueNoticeStore,
    getQueueNoticeStore,
    __resetQueueNoticeStoreForTests,
} from '../../src/messaging/queue-notice-store.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

const TARGET: RemoteTarget = {
    channel: 'slack',
    targetKind: 'channel',
    peerKind: 'group',
    targetId: 'C123',
    threadId: '1700000000.000100',
};

function store(now = () => 1_000): QueueNoticeStore {
    return new QueueNoticeStore(new Database(':memory:'), { now });
}

test.beforeEach(() => { __resetQueueNoticeStoreForTests(); });
test.afterEach(() => { __resetQueueNoticeStoreForTests(); });

test('a reserved record is findable by request id before any message id exists', () => {
    const s = store();
    s.reserve({ requestId: 'req-1', channel: 'slack', target: TARGET });

    const found = s.findByRequestId('req-1');
    assert.equal(found?.requestId, 'req-1');
    assert.equal(found?.channel, 'slack');
    assert.equal(found?.messageId, null, 'the notice has not been posted yet');
    assert.deepEqual(found?.target, TARGET);
});

test('attaching the platform message id makes the record closeable', () => {
    const s = store();
    s.reserve({ requestId: 'req-1', channel: 'slack', target: TARGET });

    assert.equal(s.attachMessageId('req-1', '1700000000.000200'), true);
    assert.equal(s.findByRequestId('req-1')?.messageId, '1700000000.000200');
});

test('a second reserve for the same request keeps the first record', () => {
    const s = store();
    s.reserve({ requestId: 'req-1', channel: 'slack', target: TARGET });
    s.attachMessageId('req-1', 'ts-1');
    s.reserve({ requestId: 'req-1', channel: 'slack', target: TARGET });

    assert.equal(
        s.findByRequestId('req-1')?.messageId, 'ts-1',
        'a duplicate reserve must not erase an id that was already attached',
    );
});

test('attaching to a request that was never reserved reports failure instead of inventing a row', () => {
    const s = store();
    assert.equal(s.attachMessageId('req-missing', 'ts-1'), false);
    assert.equal(s.findByRequestId('req-missing'), null);
});

test('closing a record removes it so a later drain cannot close it twice', () => {
    const s = store();
    s.reserve({ requestId: 'req-1', channel: 'slack', target: TARGET });
    s.attachMessageId('req-1', 'ts-1');

    assert.equal(s.close('req-1'), true);
    assert.equal(s.findByRequestId('req-1'), null);
    assert.equal(s.close('req-1'), false, 'closing twice is not an error, but it is not a second close');
});

test('listRestorable returns only records that carry a message id', () => {
    const s = store();
    s.reserve({ requestId: 'posted', channel: 'slack', target: TARGET });
    s.attachMessageId('posted', 'ts-1');
    // Reserved, then the process died before the notice was posted: there is no
    // message to rewrite, so a restore would have nothing to act on.
    s.reserve({ requestId: 'never-posted', channel: 'slack', target: TARGET });

    const restorable = s.listRestorable();
    assert.deepEqual(restorable.map(r => r.requestId), ['posted']);
});

test('listRestorable is scoped per channel so one transport cannot close another\'s notice', () => {
    const s = store();
    s.reserve({ requestId: 'slack-1', channel: 'slack', target: TARGET });
    s.attachMessageId('slack-1', 'ts-1');
    s.reserve({
        requestId: 'tg-1',
        channel: 'telegram',
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100999' },
    });
    s.attachMessageId('tg-1', '42');

    assert.deepEqual(s.listRestorable('telegram').map(r => r.requestId), ['tg-1']);
    assert.deepEqual(s.listRestorable('slack').map(r => r.requestId), ['slack-1']);
});

test('a record survives a new store opened on the same database', () => {
    const database = new Database(':memory:');
    const first = new QueueNoticeStore(database, { now: () => 1_000 });
    first.reserve({ requestId: 'req-1', channel: 'slack', target: TARGET });
    first.attachMessageId('req-1', 'ts-1');

    // What a restart actually looks like: same file, new process, new instance.
    const second = new QueueNoticeStore(database, { now: () => 2_000 });
    const restored = second.listRestorable('slack');
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.messageId, 'ts-1');
    assert.deepEqual(restored[0]?.target, TARGET, 'the target must round-trip through JSON intact');
});

test('the module-level accessor is null until init and returns the store after', () => {
    assert.equal(getQueueNoticeStore(), null);
    const created = initQueueNoticeStore(new Database(':memory:'));
    assert.equal(getQueueNoticeStore(), created);
});

