// Where the ledger's workspace id comes from. Keying durable state on a stale
// team id files one person's cursor under another, so the source has to be Slack
// itself rather than a setting nobody re-checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifiedSlackWorkspace, resetVerifiedSlackWorkspace } from '../../src/slack/verified-workspace.ts';

function authFetch(body: Record<string, unknown>) {
    let calls = 0;
    const impl = (async () => {
        calls += 1;
        return {
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify(body),
        };
    }) as unknown as typeof fetch;
    return { impl, calls: () => calls };
}

test('the team id comes from auth.test, not from settings', async () => {
    resetVerifiedSlackWorkspace();
    const { impl } = authFetch({ ok: true, team_id: 'T_REAL', user_id: 'U_BOT' });
    const result = await verifiedSlackWorkspace('xoxb-a', { fetchImpl: impl });
    assert.deepEqual(result, { teamId: 'T_REAL', userId: 'U_BOT' });
});

test('the answer is cached per token, so one lookup serves many ticks', async () => {
    resetVerifiedSlackWorkspace();
    const { impl, calls } = authFetch({ ok: true, team_id: 'T_CACHE', user_id: 'U_BOT' });
    await verifiedSlackWorkspace('xoxb-cache', { fetchImpl: impl });
    await verifiedSlackWorkspace('xoxb-cache', { fetchImpl: impl });
    assert.equal(calls(), 1);
});

test('a different token is looked up again, never served from the old cache', async () => {
    // The whole point: a token change is a possible workspace change, and reusing
    // the cached team id would file rows under the previous workspace.
    resetVerifiedSlackWorkspace();
    const first = authFetch({ ok: true, team_id: 'T_AAA', user_id: 'U_ONE' });
    await verifiedSlackWorkspace('xoxb-one', { fetchImpl: first.impl });
    const second = authFetch({ ok: true, team_id: 'T_BBB', user_id: 'U_TWO' });
    const result = await verifiedSlackWorkspace('xoxb-two', { fetchImpl: second.impl });
    assert.deepEqual(result, { teamId: 'T_BBB', userId: 'U_TWO' });
    assert.equal(second.calls(), 1);
});

test('a failed auth.test returns null rather than a guess', async () => {
    resetVerifiedSlackWorkspace();
    const { impl } = authFetch({ ok: false, error: 'invalid_auth' });
    assert.equal(await verifiedSlackWorkspace('xoxb-bad', { fetchImpl: impl }), null);
});

test('a success with no team id is still a refusal', async () => {
    resetVerifiedSlackWorkspace();
    const { impl } = authFetch({ ok: true, user_id: 'U_BOT' });
    assert.equal(await verifiedSlackWorkspace('xoxb-noteam', { fetchImpl: impl }), null);
});

test('an empty token asks Slack nothing', async () => {
    resetVerifiedSlackWorkspace();
    const { impl, calls } = authFetch({ ok: true, team_id: 'T', user_id: 'U' });
    assert.equal(await verifiedSlackWorkspace('   ', { fetchImpl: impl }), null);
    assert.equal(calls(), 0);
});
