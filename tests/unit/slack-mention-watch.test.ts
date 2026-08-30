import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanSlackMentions, type MentionScanState } from '../../src/slack/mention-watch.ts';

const SUJI = 'U08PYEQACDN';
const SELF = 'U0BR8UB1AAX';
const CHANNEL = 'C0BDW33068P';

type RawMessage = {
    ts: string;
    text: string;
    user?: string;
    thread_ts?: string;
    subtype?: string;
};

/** A fetch that answers conversations.history the way Slack actually does:
 *  both bounds EXCLUSIVE, the window filled with the NEWEST messages in range,
 *  and `has_more` set when the range held more than `limit`.
 *
 *  The newest-first fill is the detail that matters here: it is why a scan
 *  cannot just advance a cursor after one window. */
function historyFetch(byChannel: Record<string, RawMessage[]>, forceHasMore = false) {
    const calls: Array<{ channel: string; oldest?: string; latest?: string; limit: number }> = [];
    const impl = (async (_url: string, init?: { body?: unknown }) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        const channel = params.get('channel') || '';
        const oldest = params.get('oldest') || undefined;
        const latest = params.get('latest') || undefined;
        const limit = Number(params.get('limit') || '50');
        calls.push({
            channel, limit,
            ...(oldest === undefined ? {} : { oldest }),
            ...(latest === undefined ? {} : { latest }),
        });
        const all = byChannel[channel] ?? [];
        const inRange = all.filter(m =>
            (oldest ? Number(m.ts) > Number(oldest) : true)
            && (latest ? Number(m.ts) < Number(latest) : true));
        const newestFirst = [...inRange].sort((a, b) => Number(b.ts) - Number(a.ts));
        const messages = newestFirst.slice(0, limit);
        const hasMore = forceHasMore || newestFirst.length > limit;
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify({ ok: true, messages, has_more: hasMore }),
        };
    }) as unknown as typeof fetch;
    return { impl, calls };
}

function state(overrides: Partial<MentionScanState> = {}): MentionScanState {
    return { cursor: () => undefined, seen: () => false, ...overrides };
}

const noSleep = async () => {};
const MENTION = '<@' + SUJI + '>';

function scan(opts: Record<string, unknown>) {
    return scanSlackMentions('xoxb-test', {
        userId: SUJI, selfUserId: SELF, state: state(), sleep: noSleep, pacingMs: 0,
        ...opts,
    } as Parameters<typeof scanSlackMentions>[1]);
}

test('finds a mention of the watched user and points the reply at the thread', async () => {
    const { impl } = historyFetch({
        [CHANNEL]: [
            { ts: '100.000100', text: MENTION + ' 이거 봐주세요', user: 'U0BME0C36SV' },
            { ts: '100.000200', text: '관계 없는 잡담', user: 'U0BME0C36SV' },
        ],
    });
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]?.ts, '100.000100');
    assert.equal(result.hits[0]?.threadTs, '100.000100');
    assert.equal(result.failed.length, 0);
});

test('a mention inside a thread replies to the thread parent, not the reply', async () => {
    const { impl } = historyFetch({
        [CHANNEL]: [
            { ts: '200.000500', text: MENTION + ' 여기요', user: 'U0BME0C36SV', thread_ts: '200.000100' },
        ],
    });
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl });
    assert.equal(result.hits[0]?.threadTs, '200.000100');
});

test('skips the bot own posts, subtypes, and messages seen before', async () => {
    const { impl } = historyFetch({
        [CHANNEL]: [
            { ts: '300.000100', text: MENTION + ' 봇이 쓴 것', user: SELF },
            { ts: '300.000200', text: MENTION + ' 채널 참여', user: 'U0BME0C36SV', subtype: 'channel_join' },
            { ts: '300.000300', text: MENTION + ' 이미 처리함', user: 'U0BME0C36SV' },
            { ts: '300.000400', text: MENTION + ' 새 것', user: 'U0BME0C36SV' },
        ],
    });
    const result = await scan({
        channelIds: [CHANNEL], fetchImpl: impl,
        state: state({ seen: (_c, ts) => ts === '300.000300' }),
    });
    assert.deepEqual(result.hits.map(h => h.ts), ['300.000400']);
});

test('a different user mention is not a hit', async () => {
    const { impl } = historyFetch({
        [CHANNEL]: [{ ts: '400.000100', text: '<@U0BME0C36SV> 님', user: 'U0B2D6SFQ6B' }],
    });
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl });
    assert.equal(result.hits.length, 0);
});

test('the cursor stops before a carried hit, so a failed tick retries it', async () => {
    const { impl } = historyFetch({
        [CHANNEL]: [
            { ts: '500.000100', text: '평범한 글', user: 'U0BME0C36SV' },
            { ts: '500.000200', text: MENTION + ' 첫째', user: 'U0BME0C36SV' },
            { ts: '500.000300', text: MENTION + ' 둘째', user: 'U0BME0C36SV' },
        ],
    });
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl, maxHits: 1 });
    assert.deepEqual(result.hits.map(h => h.ts), ['500.000200']);
    assert.equal(result.cursors.get(CHANNEL), '500.000100');
});

test('walks backward past has_more to reach an older mention in the same tick', async () => {
    // The mention is the OLDEST message and the window holds one. A scan that
    // read a single newest-first window would never see it.
    const { impl, calls } = historyFetch({
        [CHANNEL]: [
            { ts: '600.000100', text: MENTION + ' 오래된 부탁', user: 'U0BME0C36SV' },
            { ts: '600.000200', text: '잡담', user: 'U0BME0C36SV' },
            { ts: '600.000300', text: '잡담 2', user: 'U0BME0C36SV' },
        ],
    });
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl, limit: 1 });
    assert.deepEqual(result.hits.map(h => h.ts), ['600.000100']);
    // Three windows, each bounded by the previous window's oldest ts.
    assert.equal(calls.length, 3);
    assert.equal(calls[1]?.latest, '600.000300');
    assert.equal(calls[2]?.latest, '600.000200');
});

test('a backlog deeper than the window budget leaves the cursor alone', async () => {
    // Reading stopped with history still unread below the span. Advancing the
    // cursor over that gap would skip whatever it holds, permanently.
    const messages = Array.from({ length: 10 }, (_, i) => ({
        ts: '700.0001' + String(i).padStart(2, '0'),
        text: '잡담 ' + i,
        user: 'U0BME0C36SV',
    }));
    const { impl, calls } = historyFetch({ [CHANNEL]: messages });
    const result = await scan({
        channelIds: [CHANNEL], fetchImpl: impl, limit: 1, maxWindowsPerChannel: 2,
    });
    assert.equal(calls.length, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.cursors.has(CHANNEL), false);
});

test('a fully read channel advances the cursor to its newest message', async () => {
    const { impl } = historyFetch({
        [CHANNEL]: [
            { ts: '750.000100', text: '잡담', user: 'U0BME0C36SV' },
            { ts: '750.000200', text: '잡담 2', user: 'U0BME0C36SV' },
            { ts: '750.000300', text: '잡담 3', user: 'U0BME0C36SV' },
        ],
    });
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl, limit: 1 });
    assert.equal(result.truncated, false);
    assert.equal(result.cursors.get(CHANNEL), '750.000300');
});

test('an all-quiet window advances the cursor to the newest message', async () => {
    const { impl } = historyFetch({
        [CHANNEL]: [
            { ts: '700.000100', text: '잡담', user: 'U0BME0C36SV' },
            { ts: '700.000200', text: '잡담 2', user: 'U0BME0C36SV' },
        ],
    });
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl });
    assert.equal(result.hits.length, 0);
    assert.equal(result.cursors.get(CHANNEL), '700.000200');
});

test('the stored cursor is passed to Slack as an exclusive oldest bound', async () => {
    const { impl, calls } = historyFetch({
        [CHANNEL]: [
            { ts: '800.000100', text: MENTION + ' 옛 것', user: 'U0BME0C36SV' },
            { ts: '800.000200', text: MENTION + ' 새 것', user: 'U0BME0C36SV' },
        ],
    });
    const result = await scan({
        channelIds: [CHANNEL], fetchImpl: impl,
        state: state({ cursor: () => '800.000100' }),
    });
    assert.equal(calls[0]?.oldest, '800.000100');
    assert.deepEqual(result.hits.map(h => h.ts), ['800.000200']);
});

test('a channel that cannot be read is reported without abandoning the others', async () => {
    const impl = (async (_url: string, init?: { body?: unknown }) => {
        const channel = new URLSearchParams(String(init?.body ?? '')).get('channel');
        if (channel === 'C_DENIED') {
            return {
                ok: true, status: 200, headers: { get: () => null },
                text: async () => JSON.stringify({ ok: false, error: 'not_in_channel' }),
            };
        }
        return {
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({
                ok: true, has_more: false,
                messages: [{ ts: '900.000100', text: MENTION + ' 여기', user: 'U0BME0C36SV' }],
            }),
        };
    }) as unknown as typeof fetch;
    const result = await scan({ channelIds: ['C_DENIED', CHANNEL], fetchImpl: impl });
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.channelId, 'C_DENIED');
    assert.deepEqual(result.hits.map(h => h.channelId), [CHANNEL]);
});

test('duplicate channel ids are read once', async () => {
    const { impl, calls } = historyFetch({ [CHANNEL]: [] });
    await scan({ channelIds: [CHANNEL, CHANNEL, CHANNEL], fetchImpl: impl });
    assert.equal(calls.length, 1);
});

// ─── Blocker paths from the 3rd audit round ──────────

test('two consecutive ticks walk DEEPER into a backlog, not the same window', async () => {
    // The failure this covers: without a persisted resume bound, tick 2 starts
    // from the newest message again and re-reads tick 1's windows forever, so a
    // mention below them is never reached.
    const messages = Array.from({ length: 8 }, (_, i) => ({
        ts: '900.0001' + String(i).padStart(2, '0'),
        text: i === 0 ? MENTION + ' 맨 아래 부탁' : '잡담 ' + i,
        user: 'U0BME0C36SV',
    }));
    let resume: string | null | undefined;
    const observed: Array<string | undefined> = [];
    let found: string[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
        const { impl, calls } = historyFetch({ [CHANNEL]: messages });
        const result = await scan({
            channelIds: [CHANNEL], fetchImpl: impl, limit: 1, maxWindowsPerChannel: 2,
            state: state({ resumeBefore: () => resume ?? undefined }),
        });
        observed.push(calls[0]?.latest);
        const next = result.resumeBounds.get(CHANNEL);
        if (next !== undefined) resume = next;
        if (result.hits.length) found = result.hits.map(h => h.ts);
    }
    // Each tick begins strictly lower than the last.
    assert.deepEqual(observed, [undefined, '900.000106', '900.000104', '900.000102']);
    assert.deepEqual(found, ['900.000100']);
});

test('a finished walk clears the stored resume bound', async () => {
    const { impl } = historyFetch({
        [CHANNEL]: [{ ts: '910.000100', text: '잡담', user: 'U0BME0C36SV' }],
    });
    const result = await scan({
        channelIds: [CHANNEL], fetchImpl: impl,
        state: state({ resumeBefore: () => '910.000900' }),
    });
    // Explicit null, not absent: the caller must erase the old bound rather than
    // keep reading an already-finished span.
    assert.equal(result.resumeBounds.get(CHANNEL), null);
});

test('a hot first channel does not starve the ones behind it', async () => {
    // Channel A always has a fresh mention and the hit cap is 1. Without
    // rotation, channel B would never be read at all.
    const byChannel = {
        C_HOT: [{ ts: '920.000100', text: MENTION + ' 급한 것', user: 'U0BME0C36SV' }],
        C_QUIET: [{ ts: '920.000200', text: MENTION + ' 조용한 것', user: 'U0BME0C36SV' }],
    };
    const firstRead: string[] = [];
    let startAfter: string | undefined;
    for (let tick = 0; tick < 2; tick += 1) {
        const { impl, calls } = historyFetch(byChannel);
        const result = await scan({
            channelIds: ['C_HOT', 'C_QUIET'], fetchImpl: impl, maxHits: 1,
            ...(startAfter ? { startAfterChannelId: startAfter } : {}),
        });
        firstRead.push(calls[0]!.channel);
        startAfter = result.lastChannelId ?? undefined;
    }
    assert.deepEqual(firstRead, ['C_HOT', 'C_QUIET']);
});

test('an unknown rotation anchor falls back to the configured order', async () => {
    const { impl, calls } = historyFetch({ [CHANNEL]: [] });
    await scan({
        channelIds: [CHANNEL, 'C_OTHER'], fetchImpl: impl,
        startAfterChannelId: 'C_GONE',
    });
    assert.equal(calls[0]?.channel, CHANNEL);
});

test('a rate limit stops the tick instead of spending the budget again', async () => {
    let reads = 0;
    const impl = (async () => {
        reads += 1;
        return {
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({ ok: false, error: 'ratelimited' }),
        };
    }) as unknown as typeof fetch;
    const result = await scan({
        channelIds: ['C_ONE', 'C_TWO', 'C_THREE'], fetchImpl: impl,
    });
    assert.equal(result.rateLimited, true);
    assert.deepEqual(result.failed.map(f => f.channelId), ['C_ONE']);
    // Exactly one read. The wrapper's bounded retry is opted out of, because a
    // 429 already ends the tick — retrying spends the budget the stop protects.
    assert.equal(reads, 1);
    assert.equal(result.cursors.size, 0);
});

test('an empty window with has_more stops rather than looping', async () => {
    const impl = (async () => ({
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ ok: true, messages: [], has_more: true }),
    })) as unknown as typeof fetch;
    const result = await scan({ channelIds: [CHANNEL], fetchImpl: impl });
    assert.equal(result.hits.length, 0);
    assert.equal(result.cursors.size, 0);
});
