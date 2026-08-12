import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { Update } from 'grammy/types';
import {
    TelegramDurablePoller,
    TelegramUpdateOffsetStore,
    type TelegramPollingApi,
    type TelegramPollingSignal,
} from '../../src/telegram/update-offset.ts';

function update(updateId: number): Update {
    return { update_id: updateId } as Update;
}

function memoryStore(now = () => '2026-08-12T00:00:00.000Z') {
    const database = new Database(':memory:');
    return { database, store: new TelegramUpdateOffsetStore(database, now) };
}

class FakePollingApi implements TelegramPollingApi {
    readonly calls: Array<{ kind: 'delete'; drop: boolean } | { kind: 'get'; offset: number; limit: number; timeout: number }> = [];
    readonly batches: Update[][];

    constructor(...batches: Update[][]) {
        this.batches = [...batches];
    }

    async deleteWebhook(args: { drop_pending_updates: false }): Promise<unknown> {
        this.calls.push({ kind: 'delete', drop: args.drop_pending_updates });
        return true;
    }

    async getUpdates(
        args: { offset: number; limit: number; timeout: number },
        _signal?: TelegramPollingSignal,
    ): Promise<Update[]> {
        this.calls.push({ kind: 'get', ...args });
        return this.batches.shift() ?? [];
    }
}

test('offset advancement is monotonic and validates the durable frontier', () => {
    const { database, store } = memoryStore();
    try {
        assert.equal(store.read('bot:1'), null);
        assert.deepEqual(store.advance('bot:1', 41), {
            previousOffset: null,
            nextOffset: 41,
            advancedBy: 41,
            updatedAt: '2026-08-12T00:00:00.000Z',
        });
        assert.equal(store.advance('bot:1', 20).nextOffset, 41);
        assert.equal(store.advance('bot:1', 42).advancedBy, 1);
        assert.equal(store.read('bot:1'), 42);

        for (const invalid of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => store.advance('bot:1', invalid), /invalid_telegram_offset/);
        }
    } finally {
        database.close();
    }
});

test('first install probes offset -1 and persists the newest server frontier without dispatch', async () => {
    const { database, store } = memoryStore();
    const api = new FakePollingApi([update(40)]);
    let dispatched = 0;
    const poller = new TelegramDurablePoller({
        api,
        key: 'bot:1',
        store,
        handleUpdateThroughFinalDelivery: async () => { dispatched++; },
    });
    try {
        const result = await poller.bootstrap();
        assert.deepEqual(result, {
            nextOffset: 41,
            bootstrapped: true,
            skippedThroughUpdateId: 40,
        });
        assert.deepEqual(api.calls, [
            { kind: 'delete', drop: false },
            { kind: 'get', offset: -1, limit: 1, timeout: 0 },
        ]);
        assert.equal(store.read('bot:1'), 41);
        assert.equal(dispatched, 0);
    } finally {
        database.close();
    }
});

test('restart resumes at the durable offset and deduplicates stale redelivery', async () => {
    const { database, store } = memoryStore();
    store.advance('bot:1', 41);
    const api = new FakePollingApi([update(40), update(41)]);
    const dispatched: number[] = [];
    const poller = new TelegramDurablePoller({
        api,
        key: 'bot:1',
        store,
        handleUpdateThroughFinalDelivery: async (item) => { dispatched.push(item.update_id); },
    });
    try {
        await poller.bootstrap();
        const result = await poller.pollOnce();
        assert.deepEqual(dispatched, [41]);
        assert.deepEqual(result, { received: 2, committed: 1, duplicates: 1, nextOffset: 42 });
        assert.equal(store.read('bot:1'), 42);
    } finally {
        database.close();
    }
});

test('crash before final-delivery commit leaves the offset replayable', async () => {
    const { database, store } = memoryStore();
    store.advance('bot:1', 50);
    const api = new FakePollingApi([update(50)]);
    const poller = new TelegramDurablePoller({
        api,
        key: 'bot:1',
        store,
        handleUpdateThroughFinalDelivery: async () => { throw new Error('simulated_crash'); },
    });
    try {
        await poller.bootstrap();
        await assert.rejects(poller.pollOnce(), /simulated_crash/);
        assert.equal(store.read('bot:1'), 50, 'failed delivery must be fetched again after restart');
    } finally {
        database.close();
    }
});

test('diagnostics expose offset growth without Telegram identity or message data', () => {
    let timestamp = '2026-08-12T01:00:00.000Z';
    const { database, store } = memoryStore(() => timestamp);
    try {
        store.advance('bot:1', 100);
        timestamp = '2026-08-12T01:05:00.000Z';
        const growth = store.advance('bot:1', 125);
        assert.equal(growth.advancedBy, 25);
        assert.deepEqual(store.diagnostics('bot:1'), {
            offset: 125,
            updatedAt: '2026-08-12T01:05:00.000Z',
        });
        assert.deepEqual(Object.keys(store.diagnostics('bot:1')!), ['offset', 'updatedAt']);
    } finally {
        database.close();
    }
});
