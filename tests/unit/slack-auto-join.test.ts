// Slack public-channel auto-join.
//
// The evidence these tests exist to produce is the CALL PAYLOAD: which cursor
// went out on the second page, which channel id reached conversations.join, and
// which channels never got a join at all. A green assertion that the function
// returned without throwing would prove nothing about a loop whose job is to
// mutate a live workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    runSlackAutoJoin,
    mergeSlackAutoJoin,
    SLACK_AUTO_JOIN_DEFAULTS,
    type SlackAutoJoinConfig,
} from '../../src/slack/auto-join.ts';
import { MALFORMED_SLACK_ALLOWLIST, readSlackAllowlist } from '../../src/slack/events.ts';

type Captured = { method: string; body: Record<string, string> };

/** Records every Slack call as (method, form fields) and replays scripted answers. */
function scriptedFetch(script: Array<Record<string, unknown>>) {
    const calls: Captured[] = [];
    let i = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
        const method = String(url).split('/').pop() ?? '';
        const body: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(String(init.body ?? ''))) body[k] = v;
        calls.push({ method, body });
        const payload = script[Math.min(i, script.length - 1)] ?? { ok: true };
        i += 1;
        const text = JSON.stringify(payload);
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            async text() { return text; },
        } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

const noSleep = async () => {};

function config(over: Partial<SlackAutoJoinConfig> = {}): SlackAutoJoinConfig {
    return { ...SLACK_AUTO_JOIN_DEFAULTS, exclude: [], ...over };
}

function page(channels: unknown[], cursor = '') {
    return { ok: true, channels, response_metadata: { next_cursor: cursor } };
}

test('walks the cursor across pages and sends the cursor Slack handed back', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C1', is_member: true }], 'CURSOR_P2'),
        page([{ id: 'C2', is_member: true }], ''),
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep,
    });
    const lists = calls.filter(c => c.method === 'conversations.list');
    assert.equal(lists.length, 2, 'both pages should be fetched');
    assert.equal(lists[0]!.body['cursor'], undefined, 'first page must not send a cursor');
    assert.equal(lists[1]!.body['cursor'], 'CURSOR_P2', 'second page must carry the returned cursor');
    assert.equal(lists[0]!.body['types'], 'public_channel');
    assert.equal(result.scanned, 2);
});

test('joins a channel it is not in, with the channel id in the payload', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_NEW', name: 'general', is_member: false }], ''),
        { ok: true, channel: { id: 'C_NEW' } },
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep,
    });
    const joins = calls.filter(c => c.method === 'conversations.join');
    assert.equal(joins.length, 1);
    assert.equal(joins[0]!.body['channel'], 'C_NEW');
    assert.deepEqual(result.joined, ['C_NEW']);
});

test('never joins a channel it already belongs to', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_IN', is_member: true }], ''),
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep,
    });
    assert.equal(calls.filter(c => c.method === 'conversations.join').length, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.joined, []);
});

test('a private channel is skipped: conversations.join cannot enter one', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_PRIV', is_member: false, is_private: true }], ''),
    ]);
    await runSlackAutoJoin({ token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep });
    assert.equal(calls.filter(c => c.method === 'conversations.join').length, 0);
});

test('abort stops the run before the next join and reports cancelled', async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_A', is_member: false }, { id: 'C_B', is_member: false }], ''),
        { ok: true },
        { ok: true },
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, signal: controller.signal,
        // Abort during the pacing sleep, which is where a real shutdown lands.
        sleep: async () => { controller.abort(); },
    });
    assert.equal(result.cancelled, true);
    assert.equal(calls.filter(c => c.method === 'conversations.join').length, 1,
        'the second join must not fire after abort');
});

test('a stale generation cancels the run even without an abort signal', async () => {
    let current = true;
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_A', is_member: false }, { id: 'C_B', is_member: false }], ''),
        { ok: true },
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl,
        // The generation must go stale DURING the run. Flipping it after
        // runSlackAutoJoin resolves leaves isCurrent() true for the whole scan,
        // which is how the previous version of this test passed while proving
        // nothing. The join pacing sleep is the seam that gets us mid-run.
        sleep: async () => { current = false; },
        isCurrent: () => current,
    });
    assert.equal(result.cancelled, true, 'a superseded generation must cancel the run');
    assert.equal(calls.filter(c => c.method === 'conversations.join').length, 1,
        'the second join must not fire once the generation is stale');
});

// A malformed slack.channelIds is not "one channel that matches nothing". It is
// the operator's boundary being unreadable, and joining is a visible mutation.
test('a malformed inbound allowlist stops the run instead of joining everything', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_A', name: 'general', is_member: false }], ''),
        { ok: true },
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep,
        allowlist: readSlackAllowlist('not-an-array'),
    });
    assert.equal(result.abortedReason, 'malformed_allowlist');
    assert.deepEqual(result.joined, []);
    assert.equal(calls.length, 0,
        'a malformed boundary must stop before conversations.list, not merely skip rows');
});

test('the malformed sentinel is refused even if it arrives directly', async () => {
    const { fetchImpl, calls } = scriptedFetch([page([], '')]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep,
        allowlist: [MALFORMED_SLACK_ALLOWLIST],
    });
    assert.equal(result.abortedReason, 'malformed_allowlist');
    assert.equal(calls.length, 0);
});

test('one channel refusing does not end the scan', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_BAD', is_member: false }, { id: 'C_OK', is_member: false }], ''),
        { ok: false, error: 'is_archived' },
        { ok: true },
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep,
    });
    const joins = calls.filter(c => c.method === 'conversations.join');
    assert.equal(joins.length, 2, 'the second channel must still be attempted');
    assert.deepEqual(result.joined, ['C_OK']);
    assert.deepEqual(result.failed, [{ id: 'C_BAD', error: 'is_archived' }]);
});

test('a token-level failure stops everything instead of hammering the workspace', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_A', is_member: false }, { id: 'C_B', is_member: false }], ''),
        { ok: false, error: 'missing_scope' },
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep,
    });
    assert.equal(result.abortedReason, 'missing_scope');
    assert.equal(calls.filter(c => c.method === 'conversations.join').length, 1,
        'no further joins after a token-level refusal');
});

test('rate limiting is retried, not recorded as a channel failure', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_A', is_member: false }], ''),
        { ok: false, error: 'ratelimited' },
        { ok: true },
    ]);
    const waited: number[] = [];
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl,
        sleep: async (ms) => { waited.push(ms); },
    });
    assert.equal(calls.filter(c => c.method === 'conversations.join').length, 2,
        'the same join must be retried after a 429');
    assert.deepEqual(result.joined, ['C_A']);
    assert.deepEqual(result.failed, []);
});

test('the join budget is spent after filtering, not on rows merely scanned', async () => {
    // Three channels the bot already belongs to, then the one that matters.
    const { fetchImpl, calls } = scriptedFetch([
        page([
            { id: 'C_IN1', is_member: true },
            { id: 'C_IN2', is_member: true },
            { id: 'C_IN3', is_member: true },
            { id: 'C_WANTED', is_member: false },
        ], ''),
        { ok: true },
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config({ maxJoinsPerRun: 1 }), fetchImpl, sleep: noSleep,
    });
    const joins = calls.filter(c => c.method === 'conversations.join');
    assert.equal(joins.length, 1);
    assert.equal(joins[0]!.body['channel'], 'C_WANTED',
        'members must not consume the budget before the channel that needs joining');
    assert.equal(result.budgetExhausted, false);
});

test('budget exhaustion stops the run and says so', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_A', is_member: false }, { id: 'C_B', is_member: false }], ''),
        { ok: true },
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config({ maxJoinsPerRun: 1 }), fetchImpl, sleep: noSleep,
    });
    assert.equal(result.budgetExhausted, true);
    assert.equal(calls.filter(c => c.method === 'conversations.join').length, 1);
});

test('a page filtered down to nothing still follows its cursor', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_IN', is_member: true }], 'CURSOR_P2'),
        page([{ id: 'C_NEW', is_member: false }], ''),
        { ok: true },
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep,
    });
    assert.equal(calls.filter(c => c.method === 'conversations.list').length, 2);
    assert.deepEqual(result.joined, ['C_NEW']);
});

test('the exclude list keeps a channel out, by id or by name', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([
            { id: 'C_BYID', is_member: false },
            { id: 'C_BYNAME', name: 'random', is_member: false },
            { id: 'C_OK', is_member: false },
        ], ''),
        { ok: true },
    ]);
    await runSlackAutoJoin({
        token: 'xoxb-t',
        // '#random' is how an operator types it; Slack stores it without the hash.
        config: config({ exclude: ['C_BYID', '#random'] }),
        fetchImpl, sleep: noSleep,
    });
    const joins = calls.filter(c => c.method === 'conversations.join');
    assert.deepEqual(joins.map(j => j.body['channel']), ['C_OK']);
});

test('a configured inbound allowlist bounds auto-join to that list', async () => {
    // The operator narrowed slack.channelIds; joining outside it would hand the
    // agent history access to conversations they deliberately silenced.
    const { fetchImpl, calls } = scriptedFetch([
        page([
            { id: 'C_ALLOWED', is_member: false },
            { id: 'C_OUTSIDE', is_member: false },
        ], ''),
        { ok: true },
    ]);
    await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep,
        allowlist: ['C_ALLOWED'],
    });
    const joins = calls.filter(c => c.method === 'conversations.join');
    assert.deepEqual(joins.map(j => j.body['channel']), ['C_ALLOWED']);
});

test('an empty allowlist means every conversation, which is the default', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_ANY', is_member: false }], ''),
        { ok: true },
    ]);
    await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep, allowlist: [],
    });
    assert.equal(calls.filter(c => c.method === 'conversations.join').length, 1);
});

test('disabled means not a single API call', async () => {
    const { fetchImpl, calls } = scriptedFetch([page([], '')]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config({ enabled: false }), fetchImpl, sleep: noSleep,
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(result.joined, []);
});

test('a second run joins nothing: is_member makes it idempotent', async () => {
    const { fetchImpl, calls } = scriptedFetch([
        page([{ id: 'C_A', is_member: true }], ''),
    ]);
    const result = await runSlackAutoJoin({
        token: 'xoxb-t', config: config(), fetchImpl, sleep: noSleep,
    });
    assert.equal(calls.filter(c => c.method === 'conversations.join').length, 0);
    assert.deepEqual(result.joined, []);
});

// ─── config normalization ───────────────────────────
// maxJoinsPerRun reaches a loop that joins real channels, so a malformed
// stored value must be repaired at the boundary rather than trusted.

test('an absent stored block yields the shipped defaults', () => {
    assert.deepEqual(mergeSlackAutoJoin(undefined, undefined), SLACK_AUTO_JOIN_DEFAULTS);
});

test('a partial patch keeps its siblings instead of erasing them', () => {
    const merged = mergeSlackAutoJoin(
        { enabled: true, excludeArchived: true, maxJoinsPerRun: 42, exclude: ['C_KEEP'] },
        { enabled: false },
    );
    assert.equal(merged.enabled, false);
    assert.equal(merged.maxJoinsPerRun, 42, 'a partial patch must not drop the budget');
    assert.deepEqual(merged.exclude, ['C_KEEP']);
});

test('malformed budgets are repaired, never passed through', () => {
    assert.equal(mergeSlackAutoJoin(undefined, { maxJoinsPerRun: -1 }).maxJoinsPerRun, 1);
    assert.equal(mergeSlackAutoJoin(undefined, { maxJoinsPerRun: 0 }).maxJoinsPerRun, 1);
    assert.equal(mergeSlackAutoJoin(undefined, { maxJoinsPerRun: 99999 }).maxJoinsPerRun, 1000);
    assert.equal(mergeSlackAutoJoin(undefined, { maxJoinsPerRun: Number.NaN }).maxJoinsPerRun,
        SLACK_AUTO_JOIN_DEFAULTS.maxJoinsPerRun);
    assert.equal(mergeSlackAutoJoin(undefined, { maxJoinsPerRun: 'lots' }).maxJoinsPerRun,
        SLACK_AUTO_JOIN_DEFAULTS.maxJoinsPerRun);
    assert.equal(mergeSlackAutoJoin(undefined, { maxJoinsPerRun: 7.9 }).maxJoinsPerRun, 7);
});

test('non-boolean flags fall back rather than becoming truthy', () => {
    assert.equal(mergeSlackAutoJoin(undefined, { enabled: 'no' }).enabled, true);
    assert.equal(mergeSlackAutoJoin(undefined, { enabled: 0 }).enabled, true);
    assert.equal(mergeSlackAutoJoin(undefined, { enabled: false }).enabled, false);
});

test('the exclude list is scrubbed: non-strings, blanks and hashes', () => {
    const merged = mergeSlackAutoJoin(undefined, {
        exclude: ['  C_PAD  ', '', '#named', 42, null, 'C_OK'],
    });
    assert.deepEqual(merged.exclude, ['C_PAD', 'named', 'C_OK']);
});

test('a non-array exclude value cannot poison the run', () => {
    assert.deepEqual(mergeSlackAutoJoin(undefined, { exclude: 'C_ONE' }).exclude, []);
});
