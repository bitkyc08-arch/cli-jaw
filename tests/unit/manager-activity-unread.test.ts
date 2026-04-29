import assert from 'node:assert/strict';
import test from 'node:test';
import {
    activityEventDedupeKey,
    countUnreadActivityEvents,
    countUnreadActivityEventsByPort,
    isUnreadActivityEvent,
    latestManagerEventAt,
    latestManagerEventAtForPort,
} from '../../public/manager/src/activity-unread.ts';
import type { ManagerEvent } from '../../public/manager/src/types.ts';

const baseAt = '2026-04-29T04:40:00.000Z';

test('manager activity unread helper counts only assistant response events', () => {
    const events: ManagerEvent[] = [
        { kind: 'scan-completed', from: 3457, to: 3506, reachable: 2, at: baseAt },
        { kind: 'version-mismatch', port: 3457, expected: '1.0.0', seen: '2.0.0', at: baseAt },
        { kind: 'instance-message', port: 3457, messageId: 10, role: 'user', at: baseAt },
        { kind: 'instance-message', port: 3457, messageId: 11, role: 'assistant', at: '2026-04-29T04:40:30.000Z' },
        { kind: 'health-changed', port: 3457, from: 'online', to: 'online', reason: null, at: baseAt },
        { kind: 'health-changed', port: 3457, from: 'online', to: 'offline', reason: 'lost', at: '2026-04-29T04:41:00.000Z' },
        { kind: 'lifecycle-result', port: 3458, action: 'restart', status: 'restarted', message: 'ok', at: '2026-04-29T04:42:00.000Z' },
    ];

    assert.equal(isUnreadActivityEvent(events[0]), false);
    assert.equal(isUnreadActivityEvent(events[1]), false);
    assert.equal(isUnreadActivityEvent(events[2]), false);
    assert.equal(isUnreadActivityEvent(events[3]), true);
    assert.equal(isUnreadActivityEvent(events[4]), false);
    assert.equal(isUnreadActivityEvent(events[5]), false);
    assert.equal(isUnreadActivityEvent(events[6]), false);
    assert.equal(countUnreadActivityEvents(events, null), 1);
    assert.equal(countUnreadActivityEvents(events, '2026-04-29T04:40:45.000Z'), 0);
});

test('manager activity unread helper dedupes repeated assistant response events', () => {
    const first: ManagerEvent = {
        kind: 'instance-message',
        port: 3462,
        messageId: 100,
        role: 'assistant',
        at: baseAt,
    };
    const duplicate: ManagerEvent = { ...first };
    const second: ManagerEvent = { ...first, messageId: 101, at: '2026-04-29T04:41:00.000Z' };

    assert.equal(activityEventDedupeKey(first), activityEventDedupeKey(duplicate));
    assert.notEqual(activityEventDedupeKey(first), activityEventDedupeKey(second));
    assert.equal(countUnreadActivityEvents([first, duplicate, second], null), 2);
    assert.deepEqual(countUnreadActivityEventsByPort([first, duplicate, second], null), { 3462: 2 });
    assert.deepEqual(countUnreadActivityEventsByPort([first, duplicate, second], null, { 3462: baseAt }), { 3462: 1 });
});

test('manager activity unread helper returns latest event timestamp', () => {
    const events: ManagerEvent[] = [
        { kind: 'scan-failed', reason: 'timeout', at: '2026-04-29T04:41:00.000Z' },
        { kind: 'port-collision', port: 3462, pids: [100, 101], at: '2026-04-29T04:43:00.000Z' },
        { kind: 'scan-completed', from: 3457, to: 3506, reachable: 3, at: baseAt },
    ];

    assert.equal(latestManagerEventAt([]), null);
    assert.equal(latestManagerEventAt(events), '2026-04-29T04:43:00.000Z');
    assert.equal(latestManagerEventAtForPort(events, 3462), '2026-04-29T04:43:00.000Z');
    assert.equal(latestManagerEventAtForPort(events, 3463), null);
});
