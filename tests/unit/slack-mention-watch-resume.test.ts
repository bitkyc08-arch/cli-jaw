import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanSlackMentions, type MentionScanState } from '../../src/slack/mention-watch.ts';

const SUJI = 'U08PYEQACDN';
const SELF = 'U0BR8UB1AAX';
const CHANNEL = 'C0BDW33068P';
const MENTION = '<@' + SUJI + '>';

function state(overrides: Partial<MentionScanState> = {}): MentionScanState {
    return { cursor: () => undefined, seen: () => false, ...overrides };
}

function scan(opts: Record<string, unknown>) {
    return scanSlackMentions('xoxb-test', {
        userId: SUJI, selfUserId: SELF, state: state(), sleep: async () => {}, pacingMs: 0,
        ...opts,
    } as Parameters<typeof scanSlackMentions>[1]);
}

/** A window that always reports more history below it, so the walk descends,
 *  then fails from `failFromCall` onward.
 *
 *  Failing PERSISTENTLY matters: `internal_error` is retryable, so a one-shot
 *  failure is absorbed by the wrapper's bounded retry and the walk simply
 *  continues — which would test nothing. */
function descendingFetch(failFromCall: number, failure: Record<string, unknown>) {
    const bounds: Array<string | undefined> = [];
    let call = 0;
    const impl = (async (_url: string, init?: { body?: unknown }) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        call += 1;
        bounds.push(params.get('latest') || undefined);
        const body = call >= failFromCall
            ? failure
            : { ok: true, messages: [{ ts: String(1000 - call) + '.000100', text: 'noise', user: 'U0BME0C36SV' }], has_more: true };
        return {
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify(body),
        };
    }) as unknown as typeof fetch;
    return { impl, bounds, calls: () => call };
}

test('a failed second window still records where the descent stopped', async () => {
    // Without this the next tick restarts at the newest message and re-reads the
    // span it already paid for, so an intermittently failing channel never
    // reaches its backlog.
    const { impl } = descendingFetch(2, { ok: false, error: 'internal_error' });
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl, maxWindowsPerChannel: 4 });
    assert.equal(result.resumeBounds.get(CHANNEL), '999.000100');
    assert.equal(result.truncated, true);
    assert.equal(result.cursors.size, 0);
});

test('a rate limit on the second window records the descent too', async () => {
    const { impl } = descendingFetch(2, { ok: false, error: 'ratelimited' });
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl, maxWindowsPerChannel: 4 });
    assert.equal(result.rateLimited, true);
    assert.equal(result.resumeBounds.get(CHANNEL), '999.000100');
});

test('an aborted walk records the descent rather than losing it', async () => {
    const controller = new AbortController();
    let call = 0;
    const impl = (async () => {
        call += 1;
        if (call === 2) controller.abort();
        return {
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({ ok: true, messages: [{ ts: '500.000' + call, text: 'noise', user: 'U0BME0C36SV' }], has_more: true }),
        };
    }) as unknown as typeof fetch;
    const result = await scan({
        channelIds: [CHANNEL], fetchImpl: impl, maxWindowsPerChannel: 6, signal: controller.signal,
    });
    assert.equal(result.resumeBounds.get(CHANNEL), '500.0002');
    assert.equal(result.truncated, true);
});

test('the first window failing preserves the stored bound', async () => {
    // No descent happened, so the bound this channel already had is still where
    // it belongs. It must not be cleared, and it must not jump to the head.
    const impl = (async () => ({
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ ok: false, error: 'internal_error' }),
    })) as unknown as typeof fetch;
    const result = await scan({
        channelIds: [CHANNEL], fetchImpl: impl,
        state: state({ resumeBefore: () => '400.000100' }),
    });
    assert.equal(result.resumeBounds.get(CHANNEL), '400.000100');
});

test('a first-window failure with no stored bound records nothing', async () => {
    const impl = (async () => ({
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ ok: false, error: 'internal_error' }),
    })) as unknown as typeof fetch;
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl });
    assert.equal(result.resumeBounds.has(CHANNEL), false);
});

test('a channel that cannot advance is reported, not spun on forever', async () => {
    // `has_more` with nothing to descend past would make every tick ask for the
    // exact same window. Silence there is the worst outcome: the channel starves
    // and nothing says why.
    const impl = (async () => ({
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ ok: true, messages: [], has_more: true }),
    })) as unknown as typeof fetch;
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl });
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0]?.error ?? '', /did not advance/);
    assert.equal(result.cursors.size, 0);
});

test('channels past the ceiling are reported, never silently dropped', async () => {
    const many = Array.from({ length: 65 }, (_, i) => 'C' + String(i).padStart(3, '0'));
    const read: string[] = [];
    const impl = (async (_url: string, init?: { body?: unknown }) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        read.push(params.get('channel') || '');
        return {
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({ ok: true, messages: [], has_more: false }),
        };
    }) as unknown as typeof fetch;
    const result = await scan({ channelIds: many, fetchImpl: impl, maxHits: 99 });
    assert.equal(read.length, 60);
    assert.deepEqual(result.overflowChannels, ['C060', 'C061', 'C062', 'C063', 'C064']);
});

test('a mention found alongside a read channel is still answerable', async () => {
    // The ceiling bounds reads; it must not change what a read channel reports.
    const impl = (async (_url: string, init?: { body?: unknown }) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        const channel = params.get('channel');
        const messages = channel === CHANNEL
            ? [{ ts: '700.000100', text: MENTION + ' 확인 부탁', user: 'U0BME0C36SV' }]
            : [];
        return {
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({ ok: true, messages, has_more: false }),
        };
    }) as unknown as typeof fetch;
    const result = await scan({ channelIds: ['C_OTHER', CHANNEL], fetchImpl: impl });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]?.channelId, CHANNEL);
    assert.deepEqual(result.overflowChannels, []);
});
