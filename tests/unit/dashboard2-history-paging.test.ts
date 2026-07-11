import * as R from 'react';
(globalThis as any).React = R;

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    MessagesPageResponse,
    SegmentedMessageItem,
    TurnLifecycleSsePayload,
} from '../../src/shared/chat-events.ts';
import {
    createHistoryController,
    type HistoryControllerOptions,
} from '../../public/dashboard2/src/turn-stream/history/history-controller.ts';
import {
    createMessagesPageClient,
    InvalidMessagesPageResponseError,
} from '../../public/dashboard2/src/turn-stream/history/messages-page-client.ts';
import {
    diagnoseHistoryPageOverlap,
    mergeHistoryPage,
} from '../../public/dashboard2/src/turn-stream/history/merge-history-page.ts';
import {
    createTurnStreamState,
    reduce,
    reduceBatch,
    serializeState,
} from '../../public/dashboard2/src/turn-stream/reducer.ts';
import type { RowKey, TurnStreamAction, TurnStreamState } from '../../public/dashboard2/src/turn-stream/types.ts';
import { generateFixture } from '../fixtures/dashboard2/turn-stream/seed.ts';

const fixture = generateFixture();
const messages201 = fixture.messages.slice(0, 201);
const lifecycle201 = fixture.lifecycle.filter(event => Number(event.turnId.slice('fixture-turn-'.length)) < 201);

function response(
    data: SegmentedMessageItem[],
    overrides: Partial<MessagesPageResponse['pageInfo']> = {},
    snapshotEventSeq = 100,
): MessagesPageResponse {
    return {
        ok: true,
        data,
        pageInfo: {
            oldestCursor: data[0]?.id ?? null,
            newestCursor: data.at(-1)?.id ?? null,
            hasMoreBefore: (data[0]?.id ?? 1) > 1,
            limit: 200,
            ...overrides,
        },
        snapshotEventSeq,
    };
}

function fixturePager(rows: SegmentedMessageItem[]) {
    const requests: Array<{ limit?: number; before?: number }> = [];
    return {
        requests,
        fetch: async (opts: { limit?: number; before?: number }): Promise<MessagesPageResponse> => {
            requests.push(opts);
            const eligible = opts.before === undefined ? rows : rows.filter(row => row.id < opts.before!);
            const limit = opts.limit ?? 200;
            const data = eligible.slice(-limit);
            return response(data, { hasMoreBefore: eligible.length > data.length, limit });
        },
    };
}

function controllerHarness(
    fetchPage: (opts: { limit?: number; before?: number }) => Promise<MessagesPageResponse>,
    overrides: Partial<HistoryControllerOptions> = {},
    initialState: TurnStreamState = createTurnStreamState('history-test'),
) {
    let state = initialState;
    const actionBatches: TurnStreamAction[][] = [];
    const client = createMessagesPageClient(fetchPage);
    const controller = createHistoryController({
        client,
        apply(actions) {
            actionBatches.push([...actions]);
            state = reduceBatch(state, actions);
        },
        getExistingRowKeys: () => state.rowOrder,
        ...overrides,
    });
    controller.setScope('3457/session-a');
    return { controller, client, actionBatches, getState: () => state };
}

function reduceLifecycle(events: TurnLifecycleSsePayload[], initial = createTurnStreamState('history-test')): TurnStreamState {
    return events.reduce((state, payload) => reduce(state, { kind: 'lifecycle', payload }), initial);
}

test('048: 201 messages page as 200+1 in ascending order without duplicates or gaps', async () => {
    const pager = fixturePager(messages201);
    const harness = controllerHarness(pager.fetch);
    assert.deepEqual(await harness.controller.loadInitial(), { status: 'merged', messageCount: 200 });
    assert.deepEqual(await harness.controller.loadOlder(), { status: 'merged', messageCount: 1 });

    const pages = harness.actionBatches.flatMap(batch => batch.flatMap(action =>
        action.kind === 'history_page' ? [action.messages.map(message => message.id)] : []));
    for (const ids of pages) assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    const ids = pages.flat();
    assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 201 }, (_, index) => index + 1));
    assert.equal(new Set(ids).size, 201);
    assert.ok(pager.requests.every(request => (request.limit ?? 200) <= 200));
    assert.deepEqual(pager.requests.map(request => request.before ?? null), [null, 2]);
});

test('048: deleted exclusive cursor is passed through and only id < before merges', async () => {
    const deletedCursor = 101;
    const requests: Array<{ limit?: number; before?: number }> = [];
    const harness = controllerHarness(async opts => {
        requests.push(opts);
        if (opts.before === undefined) {
            return response(messages201.filter(message => message.id > deletedCursor), {
                oldestCursor: deletedCursor,
                newestCursor: 201,
                hasMoreBefore: true,
            });
        }
        const data = messages201.filter(message => message.id < opts.before!);
        return response(data, { hasMoreBefore: false });
    });
    await harness.controller.loadInitial();
    await harness.controller.loadOlder();
    assert.equal(requests[1]?.before, deletedCursor);
    const olderAction = harness.actionBatches[1]?.find(action => action.kind === 'history_page');
    assert.ok(olderAction?.kind === 'history_page');
    assert.ok(olderAction.messages.every(message => message.id < deletedCursor));
});

test('048: shared response validation rejects malformed data and keeps legacy null-turn content', async () => {
    const legacy = { ...messages201[0], turn_id: null, turn_segments: [], content: 'legacy text survives' };
    const page = response([legacy], { hasMoreBefore: false });
    const client = createMessagesPageClient(async () => page);
    client.beginScope('scope');
    const accepted = await client.fetch({ limit: 200 });
    assert.equal(accepted.status, 'ok');
    if (accepted.status === 'ok') {
        const action = mergeHistoryPage(accepted.page);
        assert.equal(action.kind, 'history_page');
        assert.equal(action.messages[0].content, 'legacy text survives');
        assert.deepEqual(action.messages[0].turn_segments, []);
    }

    const invalidClient = createMessagesPageClient(async () => ({ ...page, snapshotEventSeq: 'bad' } as never));
    invalidClient.beginScope('scope');
    await assert.rejects(invalidClient.fetch(), InvalidMessagesPageResponseError);
    await assert.rejects(client.fetch({ before: 0 }), RangeError);
    await assert.rejects(client.fetch({ before: -1 }), RangeError);
    await assert.rejects(client.fetch({ before: Number.NaN }), RangeError);
});

test('048: merge action and 041 hydration preserve a null-turn legacy row', () => {
    const legacy = { ...messages201[0], turn_id: null, turn_segments: [], content: 'legacy merge body' };
    const action = mergeHistoryPage(response([legacy], { hasMoreBefore: false }));
    assert.equal(action.kind, 'history_page');
    assert.deepEqual(action.messages[0], legacy, 'history adapter preserves the complete shared DTO');

    const before = createTurnStreamState('history-test');
    const after = reduce(before, action);
    assert.deepEqual(after.legacyMessages[legacy.id], {
        role: legacy.role,
        content: 'legacy merge body',
        createdAt: legacy.created_at,
    });
    assert.deepEqual(after.rowOrder, before.rowOrder, 'legacy empty segments do not invent transcript row keys');
});

test('048: history-first, SSE-first, overlap, and duplicate pages converge to one canonical hash', () => {
    const page = response(messages201, { hasMoreBefore: false });
    const expected = reduce(reduceLifecycle(lifecycle201), mergeHistoryPage(page));

    const historyFirst = reduceLifecycle(lifecycle201, reduce(createTurnStreamState('history-test'), mergeHistoryPage(page)));
    assert.equal(serializeState(historyFirst), serializeState(expected));

    let overlapped = reduce(createTurnStreamState('history-test'), mergeHistoryPage(response(messages201.slice(0, 120))));
    overlapped = reduce(overlapped, mergeHistoryPage(response(messages201.slice(80))));
    overlapped = reduceLifecycle(lifecycle201, overlapped);
    assert.equal(serializeState(overlapped), serializeState(expected));

    const duplicated = reduce(reduce(expected, mergeHistoryPage(page)), mergeHistoryPage(page));
    assert.equal(serializeState(duplicated), serializeState(expected));
    const overlap = diagnoseHistoryPageOverlap(page, expected.rowOrder);
    assert.equal(overlap.hasOverlap, true);
    assert.ok(overlap.overlapCount > 0);
});

test('048: late scope-A response is stale and cannot change scope-B canonical state', async () => {
    let resolveA!: (page: MessagesPageResponse) => void;
    const pendingA = new Promise<MessagesPageResponse>(resolve => { resolveA = resolve; });
    let calls = 0;
    const harness = controllerHarness(async () => ++calls === 1 ? pendingA : response(messages201.slice(-1)));
    const late = harness.controller.loadInitial();
    harness.controller.setScope('3457/session-b');
    await harness.controller.loadInitial();
    const scopeBHash = serializeState(harness.getState());
    resolveA(response(messages201));
    assert.equal((await late).status, 'stale');
    assert.equal(serializeState(harness.getState()), scopeBHash);
});

test('048: abort releases a pending client request without waiting for the provider promise', async () => {
    const never = new Promise<MessagesPageResponse>(() => {});
    const client = createMessagesPageClient(async () => never);
    client.beginScope('scope-a');
    const pending = client.fetch();
    client.abortAll();
    assert.deepEqual(await pending, { status: 'aborted' });
});

test('048: same oldest cursor shares one promise and empty/hasMore=false sticks exhaustion', async () => {
    let resolveOlder!: (page: MessagesPageResponse) => void;
    let calls = 0;
    const harness = controllerHarness(async opts => {
        calls += 1;
        if (opts.before === undefined) return response(messages201.slice(-2), { hasMoreBefore: true });
        return new Promise(resolve => { resolveOlder = resolve; });
    });
    await harness.controller.loadInitial();
    const first = harness.controller.loadOlder();
    const second = harness.controller.loadOlder();
    assert.equal(first, second, 'same cursor shares the exact in-flight promise');
    resolveOlder(response([], { oldestCursor: null, newestCursor: null, hasMoreBefore: false }));
    assert.equal((await first).status, 'exhausted');
    assert.equal((await harness.controller.loadOlder()).status, 'exhausted');
    assert.equal(calls, 2, 'exhaustion prevents another request');
});

test('048: concurrent initial load and replay backfill share the latest cursor request', async () => {
    let resolveLatest!: (page: MessagesPageResponse) => void;
    let requests = 0;
    const harness = controllerHarness(async () => {
        requests += 1;
        return new Promise(resolve => { resolveLatest = resolve; });
    });
    const initial = harness.controller.loadInitial();
    const backfill = harness.controller.handleReplayGap();
    assert.equal(requests, 1, 'latest cursor has one shared network flight');
    resolveLatest(response(messages201.slice(-1), { hasMoreBefore: false }));
    assert.equal((await initial).status, 'merged');
    assert.equal((await backfill).status, 'backfill-bounded');
    assert.equal(requests, 1);
});

test('048: loading head slot insertion/removal never contaminates transcript row keys', async () => {
    const seedPage = response(messages201.slice(20, 30), { hasMoreBefore: true });
    const seeded = reduce(createTurnStreamState('history-test'), mergeHistoryPage(seedPage));
    const rowOrder = [...seeded.rowOrder];
    let resolvePage!: (page: MessagesPageResponse) => void;
    const harness = controllerHarness(async () => new Promise(resolve => { resolvePage = resolve; }), {}, seeded);

    const loading = harness.controller.loadInitial();
    assert.equal(harness.controller.getState().phase, 'loading');
    assert.deepEqual(harness.getState().rowOrder, rowOrder, 'loading boundary lives outside transcript rows');
    resolvePage(response([], { oldestCursor: null, newestCursor: null, hasMoreBefore: false }));
    assert.equal((await loading).status, 'exhausted');
    assert.deepEqual(harness.getState().rowOrder, rowOrder, 'removing loading boundary leaves anchor inputs unchanged');
});

test('048: snapshotEventSeq is diagnostic only and does not fence a new seq=99 durable row', async () => {
    const page = response(messages201.slice(0, 1), { hasMoreBefore: false }, 100);
    const harness = controllerHarness(async () => page);
    await harness.controller.loadInitial();
    const event = { ...lifecycle201[0], turnId: 'new-after-snapshot', turnSeq: 99, segmentId: 'new-after-snapshot:99' };
    const after = reduce(harness.getState(), { kind: 'lifecycle', payload: event });
    assert.ok(after.rowOrder.includes('new-after-snapshot#99'));
});

test('048: replay_gap preserves rows, exposes retry after 500, and clears needsBackfill only on overlap success', async () => {
    const seedPage = response(messages201.slice(100, 120), { hasMoreBefore: true });
    let fail = true;
    let seeded = createTurnStreamState('history-test');
    seeded = reduce(seeded, mergeHistoryPage(seedPage));
    seeded = reduce(seeded, { kind: 'invalidation', reason: 'replay_gap' });
    const seededHash = serializeState(seeded);
    const retryHarness = controllerHarness(async () => {
        if (fail) { fail = false; throw Object.assign(new Error('500'), { status: 500 }); }
        return seedPage;
    }, {}, seeded);

    const failed = await retryHarness.controller.handleReplayGap();
    assert.equal(failed.status, 'failed');
    assert.equal(retryHarness.controller.getState().needsBackfill, true);
    assert.equal(retryHarness.getState().needsBackfill, true);
    assert.equal(serializeState(retryHarness.getState()), seededHash, '500 leaves existing canonical content unchanged');
    const rowsAfterFailure = retryHarness.getState().rowOrder.length;
    const retried = await retryHarness.controller.retry();
    assert.equal(retried.status, 'backfill-complete');
    assert.equal(retryHarness.controller.getState().needsBackfill, false);
    assert.equal(retryHarness.getState().needsBackfill, false);
    assert.ok(retryHarness.getState().rowOrder.length >= rowsAfterFailure);
    assert.equal(retryHarness.actionBatches.flat().filter(action => action.kind === 'backfill_merged').length, 1);
});

test('048: replay_gap stops at the default 10 pages / 2000 messages and suggests a full snapshot', async () => {
    let calls = 0;
    const harness = controllerHarness(async opts => {
        calls += 1;
        const high = opts.before ?? 10_001;
        const low = high - 200;
        const data = fixture.messages.slice(0, 200).map((message, index) => ({
            ...message,
            id: low + index,
            turn_id: `backfill-${calls}-${index}`,
            turn_segments: message.turn_segments.map(segment => ({
                ...segment,
                turnId: `backfill-${calls}-${index}`,
                segmentId: `backfill-${calls}-${index}:${segment.turnSeq}`,
            })),
        }));
        return response(data, { oldestCursor: low, newestCursor: high - 1, hasMoreBefore: true });
    });
    const result = await harness.controller.handleReplayGap();
    assert.deepEqual(result, { status: 'backfill-bounded', pages: 10, messages: 2_000 });
    assert.equal(calls, 10);
    assert.equal(harness.controller.getState().phase, 'suggestion');
    assert.equal(harness.controller.getState().needsBackfill, true);
    assert.equal(harness.actionBatches.flat().some(action => action.kind === 'backfill_merged'), false);
});
