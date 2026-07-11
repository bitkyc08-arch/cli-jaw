import assert from 'node:assert/strict';
import test from 'node:test';
import type { PendingItem, QueueUpdateSsePayload } from '../../src/shared/chat-events.ts';
import { createPendingQueueApi } from '../../public/dashboard2/src/chat/pending/pending-queue-api.ts';
import {
    PendingQueueMachine,
    type PendingQueueMutationApi,
    type PendingQueueTimer,
} from '../../public/dashboard2/src/chat/pending/pending-queue-machine.ts';
import { dispatchSelectedSyncPayload } from '../../public/dashboard2/src/providers/sync-provider.tsx';

const ITEM: PendingItem = { id: 'q-1', prompt: 'first', source: 'web', ts: 1 };

class FakeClock implements PendingQueueTimer {
    now = 0;
    nextId = 0;
    tasks = new Map<number, { at: number; callback: () => void }>();

    setTimeout(callback: () => void, delayMs: number): number {
        const id = ++this.nextId;
        this.tasks.set(id, { at: this.now + delayMs, callback });
        return id;
    }

    clearTimeout(handle: unknown): void {
        this.tasks.delete(handle as number);
    }

    advance(ms: number): void {
        const end = this.now + ms;
        while (true) {
            const due = [...this.tasks.entries()]
                .filter(([, task]) => task.at <= end)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!due) break;
            this.tasks.delete(due[0]);
            this.now = due[1].at;
            due[1].callback();
        }
        this.now = end;
    }
}

function createFixture(overrides: Partial<PendingQueueMutationApi> = {}) {
    const calls = { hold: 0, release: 0, steer: 0, delete: 0, refetch: 0 };
    const requestOrder: string[] = [];
    let items: readonly PendingItem[] = [ITEM];
    const api: PendingQueueMutationApi = {
        hold: async id => { calls.hold += 1; requestOrder.push(`hold:${id}`); },
        releaseHold: async id => { calls.release += 1; requestOrder.push(`release:${id}`); },
        steer: async id => { calls.steer += 1; requestOrder.push(`steer:${id}`); },
        delete: async id => { calls.delete += 1; requestOrder.push(`delete:${id}`); },
        refetch: async () => { calls.refetch += 1; return items; },
        ...overrides,
    };
    const clock = new FakeClock();
    const machine = new PendingQueueMachine(api, { timer: clock });
    machine.setScope('A');
    machine.reconcile('A', items);
    return { api, calls, clock, machine, requestOrder, setItems: (next: readonly PendingItem[]) => { items = next; } };
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

test('047 sync baseline drops queue_update, selected extension fans out queue once and turn zero times', () => {
    const payload: QueueUpdateSsePayload = {
        topic: 'queue', event: 'queue_update', pending: 1, queued: [ITEM],
    };
    const legacyAccepts = payload.topic === 'agent'
        && ['turn_start', 'turn_segment', 'turn_end'].includes(payload.event);
    assert.equal(legacyAccepts, false, 'pre-047 turn-only filter drops queue_update');

    let queue = 0;
    let turn = 0;
    const selected = dispatchSelectedSyncPayload(payload, {
        queue: value => { queue += 1; assert.deepEqual(value.queued, [ITEM]); },
        turn: () => { turn += 1; },
        system: () => undefined,
    });
    assert.equal(selected, 'queue');
    assert.equal(queue, 1);
    assert.equal(turn, 0);
});

test('047 steer arms with hold and submits exactly once at 3000ms', async () => {
    const { calls, clock, machine } = createFixture();
    machine.activate(ITEM.id, 'steer');
    assert.equal(calls.hold, 1);
    assert.equal(calls.steer, 0);
    assert.equal(machine.getSnapshot().rows[0]?.overlay?.phase, 'armed');
    clock.advance(2_999);
    assert.equal(calls.steer, 0);
    clock.advance(1);
    assert.equal(calls.steer, 1);
    clock.advance(10_000);
    await flush();
    assert.equal(calls.steer, 1);
});

test('047 delete arms without hold and submits once at 3000ms', () => {
    const { calls, clock, machine } = createFixture();
    machine.activate(ITEM.id, 'delete');
    assert.equal(calls.hold, 0);
    clock.advance(2_999);
    assert.equal(calls.delete, 0);
    clock.advance(1);
    assert.equal(calls.delete, 1);
});

test('047 second activation cancels steer/delete and ten rapid cycles leave no late mutation', () => {
    const steer = createFixture();
    for (let index = 0; index < 10; index += 1) {
        steer.machine.activate(ITEM.id, 'steer');
        steer.machine.activate(ITEM.id, 'steer');
    }
    steer.clock.advance(30_000);
    assert.equal(steer.calls.hold, 10);
    assert.equal(steer.calls.release, 10);
    assert.equal(steer.calls.steer, 0);

    const deletion = createFixture();
    deletion.machine.activate(ITEM.id, 'delete');
    deletion.machine.activate(ITEM.id, 'delete');
    deletion.clock.advance(30_000);
    assert.equal(deletion.calls.hold, 0);
    assert.equal(deletion.calls.release, 0);
    assert.equal(deletion.calls.delete, 0);
});

test('047 steering has one global armed row: B cancels A hold and timer before arming', () => {
    const fixture = createFixture();
    const itemB: PendingItem = { ...ITEM, id: 'q-2', prompt: 'second' };
    fixture.machine.reconcile('A', [ITEM, itemB]);

    fixture.machine.activate(ITEM.id, 'steer');
    fixture.machine.activate(itemB.id, 'steer');

    const rows = fixture.machine.getSnapshot().rows;
    assert.equal(rows.find(row => row.item.id === ITEM.id)?.overlay, null);
    assert.equal(rows.find(row => row.item.id === itemB.id)?.overlay?.phase, 'armed');
    assert.equal(fixture.calls.release, 1);
    assert.deepEqual(fixture.requestOrder, ['hold:q-1', 'release:q-1', 'hold:q-2']);

    fixture.clock.advance(3_000);
    assert.equal(fixture.calls.steer, 1);
    assert.equal(fixture.requestOrder.includes('steer:q-1'), false,
        'the cancelled A timer must never mutate');
    assert.equal(fixture.requestOrder.includes('steer:q-2'), true);
});

test('047 authoritative removal clears armed timer and success never removes a retained row', async () => {
    const fixture = createFixture();
    fixture.machine.activate(ITEM.id, 'delete');
    fixture.machine.reconcile('A', []);
    fixture.clock.advance(3_000);
    assert.equal(fixture.calls.delete, 0);
    assert.equal(fixture.machine.getSnapshot().rows.length, 0);

    const retained = createFixture();
    retained.machine.activate(ITEM.id, 'delete');
    retained.clock.advance(3_000);
    await flush();
    assert.equal(retained.machine.getSnapshot().rows.length, 1,
        'mutation success alone must not remove the authoritative row');
});

test('047 authoritative removal during submit ignores a late failure and cannot restore the row', async () => {
    let rejectMutation: ((reason: Error) => void) | undefined;
    const mutation = new Promise<void>((_resolve, reject) => { rejectMutation = reject; });
    const fixture = createFixture({ delete: () => mutation });
    fixture.machine.activate(ITEM.id, 'delete');
    fixture.clock.advance(3_000);
    assert.equal(fixture.machine.getSnapshot().rows[0]?.overlay?.phase, 'submitting');
    fixture.machine.reconcile('A', []);
    rejectMutation?.(new Error('late 500'));
    await flush();
    assert.equal(fixture.machine.getSnapshot().rows.length, 0);
    assert.equal(fixture.calls.refetch, 0, 'stale completion must not start a restoring refetch');
});

test('047 mutation 500 reports error then refetch converges to synced; timeout keeps the row', async () => {
    const phases: Array<string | undefined> = [];
    const failed = createFixture({ delete: async () => { throw new Error('Queue request failed (500)'); } });
    failed.machine.subscribe(() => phases.push(failed.machine.getSnapshot().rows[0]?.overlay?.phase));
    failed.machine.activate(ITEM.id, 'delete');
    failed.clock.advance(3_000);
    await flush();
    assert.ok(phases.includes('error'));
    assert.equal(failed.calls.refetch, 1);
    assert.equal(failed.machine.getSnapshot().rows[0]?.overlay, null);

    const timedOut = createFixture({ steer: async () => { throw new Error('Queue request timed out'); } });
    timedOut.machine.activate(ITEM.id, 'steer');
    timedOut.clock.advance(3_000);
    await flush();
    assert.equal(timedOut.machine.getSnapshot().rows.length, 1);
    assert.equal(timedOut.machine.getSnapshot().rows[0]?.overlay, null);
});

test('047 scope transition cancels A timer without changing B', () => {
    const { calls, clock, machine } = createFixture();
    machine.activate(ITEM.id, 'steer');
    machine.setScope('B');
    machine.reconcile('B', [{ ...ITEM, id: 'q-b' }]);
    const before = machine.getSnapshot();
    clock.advance(30_000);
    assert.equal(calls.release, 1);
    assert.equal(calls.steer, 0);
    assert.deepEqual(machine.getSnapshot().rows.map(row => row.item.id), ['q-b']);
    assert.equal(machine.getSnapshot().version, before.version);
});

test('047 dispose releases an armed steer hold and cleans state even when release fails', async () => {
    let releaseAttempts = 0;
    const fixture = createFixture({
        releaseHold: async () => {
            releaseAttempts += 1;
            throw new Error('release unavailable');
        },
    });
    fixture.machine.activate(ITEM.id, 'steer');

    fixture.machine.dispose();
    fixture.clock.advance(30_000);
    await flush();

    assert.equal(releaseAttempts, 1);
    assert.equal(fixture.calls.steer, 0);
    assert.equal(fixture.machine.getSnapshot().rows[0]?.overlay, null);
});

test('047 reconnect duplicate snapshot preserves FIFO and causes no duplicate notification', () => {
    const { machine } = createFixture();
    const ordered = [ITEM, { ...ITEM, id: 'q-2', prompt: 'second' }, { ...ITEM, id: 'q-3', prompt: 'third' }];
    let notifications = 0;
    machine.subscribe(() => { notifications += 1; });
    machine.reconcile('A', ordered);
    const afterFirst = notifications;
    machine.reconcile('A', ordered.map(item => ({ ...item })));
    assert.equal(notifications, afterFirst);
    assert.deepEqual(machine.getSnapshot().rows.map(row => row.item.id), ['q-1', 'q-2', 'q-3']);
});

test('047 API adapter matches current hold/steer/delete/snapshot route shapes', async () => {
    const calls: string[] = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return new Response(JSON.stringify({ queued: [ITEM] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        });
    };
    const api = createPendingQueueApi(3458, { fetch: fetchMock });
    await api.hold('q /1');
    await api.releaseHold('q /1');
    await api.steer('q /1');
    await api.delete('q /1');
    assert.deepEqual(await api.refetch(), [ITEM]);
    assert.deepEqual(calls, [
        'POST /i/3458/api/orchestrate/queue/q%20%2F1/hold',
        'DELETE /i/3458/api/orchestrate/queue/q%20%2F1/hold',
        'POST /i/3458/api/orchestrate/queue/q%20%2F1/steer',
        'DELETE /i/3458/api/orchestrate/queue/q%20%2F1',
        'GET /i/3458/api/orchestrate/snapshot',
    ]);
});
