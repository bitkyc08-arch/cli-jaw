// Characterization tests: behaviors the existing slack-identity suite does NOT pin.
//
// These exist to make a refactor safe, not to describe intent. They lock in what
// identity.ts does TODAY so that extracting its cache/suppression/coalescing
// machinery into a shared primitive (devlog 260812_slack_conversation_context/012)
// cannot silently change behavior. An independent audit enumerated the gaps that
// the 43 tests in slack-identity.test.ts leave open; each test below closes one.
//
// If one of these fails after the extraction, the extraction lost something.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveSlackIdentity,
    resolveSlackIdentities,
    getCachedSlackIdentities,
    primeSlackIdentityCache,
    slackIdentityCacheStats,
    resetSlackIdentityCache,
    setCapabilityLockForTest,
} from '../../src/slack/identity.ts';
import { settings } from '../../src/core/config.ts';

const TOKEN = 'xoxb-not-a-real-token-000';
const TEAM = 'T0TEST';

/** Fetch harness: records calls, replays a queued response per call. */
function makeFetch(responses: Array<Record<string, unknown>>) {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    let i = 0;
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        const body: Record<string, unknown> = {};
        for (const [k, v] of params) body[k] = v;
        calls.push({ body });
        const spec = responses[Math.min(i, responses.length - 1)];
        i++;
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(spec ?? { ok: true }),
        } as unknown as Response;
    // justified: the harness implements only the Response surface slackApi reads
    }) as unknown as typeof fetch;
    return { impl, calls };
}

const userOk = (id: string, name: string) => ({
    ok: true, user: { id, profile: { display_name: name } },
});

function withTtl(ms: unknown, run: () => Promise<void>): Promise<void> {
    const slack = settings['slack'] as Record<string, unknown> | undefined;
    const previous = slack?.['identityCacheTtlMs'];
    if (slack) slack['identityCacheTtlMs'] = ms;
    return run().finally(() => {
        if (!slack) return;
        if (previous === undefined) delete slack['identityCacheTtlMs'];
        else slack['identityCacheTtlMs'] = previous;
    });
}

test.beforeEach(() => resetSlackIdentityCache());

// ─── TTL configuration ──────────────────────────────

test('a non-numeric identityCacheTtlMs falls back to the default rather than expiring instantly', async () => {
    await withTtl('nonsense', async () => {
        const { impl, calls } = makeFetch([userOk('U1', 'Jun')]);
        await resolveSlackIdentity(TOKEN, { userId: 'U1' }, { teamId: TEAM, fetchImpl: impl });
        // A bad TTL must not be read as 0: that would disable the cache entirely.
        await resolveSlackIdentity(TOKEN, { userId: 'U1' }, { teamId: TEAM, fetchImpl: impl });
        assert.equal(calls.length, 1, 'second lookup should hit the cache');
    });
});

test('identityCacheTtlMs is clamped to the floor, so a tiny value still caches', async () => {
    await withTtl(1, async () => {
        const { impl, calls } = makeFetch([userOk('U1', 'Jun')]);
        await resolveSlackIdentity(TOKEN, { userId: 'U1' }, { teamId: TEAM, fetchImpl: impl });
        await resolveSlackIdentity(TOKEN, { userId: 'U1' }, { teamId: TEAM, fetchImpl: impl });
        // 1ms would have expired between the two calls if it were honoured raw.
        assert.equal(calls.length, 1, 'sub-floor TTL must clamp, not expire');
    });
});

// ─── Negative-cache classes ─────────────────────────

test('user_not_found and a transport failure are both negatively cached', async () => {
    const notFound = makeFetch([{ ok: false, error: 'user_not_found' }]);
    await resolveSlackIdentity(TOKEN, { userId: 'U404' }, { teamId: TEAM, fetchImpl: notFound.impl });
    await resolveSlackIdentity(TOKEN, { userId: 'U404' }, { teamId: TEAM, fetchImpl: notFound.impl });
    assert.equal(notFound.calls.length, 1, 'user_not_found must suppress the retry');

    const transient = makeFetch([{ ok: false, error: 'internal_error' }]);
    await resolveSlackIdentity(TOKEN, { userId: 'U500' }, { teamId: TEAM, fetchImpl: transient.impl });
    await resolveSlackIdentity(TOKEN, { userId: 'U500' }, { teamId: TEAM, fetchImpl: transient.impl });
    assert.equal(transient.calls.length, 1, 'a transient failure must suppress the retry');

    assert.ok(slackIdentityCacheStats().negative >= 2, 'both keys occupy the negative cache');
});

test('a negative entry is keyed per id, so one failure does not suppress another user', async () => {
    const { impl, calls } = makeFetch([
        { ok: false, error: 'user_not_found' },
        userOk('U2', 'Sujin'),
    ]);
    await resolveSlackIdentity(TOKEN, { userId: 'U1' }, { teamId: TEAM, fetchImpl: impl });
    const second = await resolveSlackIdentity(TOKEN, { userId: 'U2' }, { teamId: TEAM, fetchImpl: impl });
    assert.equal(calls.length, 2, 'a different id must still be looked up');
    assert.equal(second.name, 'Sujin');
});

// ─── Capability lock ────────────────────────────────

test('the capability lock is shared across users.info and bots.info', async () => {
    const scope = makeFetch([{ ok: false, error: 'missing_scope', needed: 'users:read' }]);
    await resolveSlackIdentity(TOKEN, { userId: 'U1' }, { teamId: TEAM, fetchImpl: scope.impl });
    assert.equal(scope.calls.length, 1);

    // A bot lookup goes through bots.info, but the latch is global today.
    const bot = makeFetch([{ ok: true, bot: { id: 'B1', name: 'Ledger' } }]);
    const identity = await resolveSlackIdentity(TOKEN, { botId: 'B1' }, { teamId: TEAM, fetchImpl: bot.impl });
    assert.equal(bot.calls.length, 0, 'the shared latch must suppress the bot lookup too');
    assert.equal(identity.resolved, false);
});

test('a successful lookup after the lock lapses clears it for everyone', async () => {
    const scope = makeFetch([{ ok: false, error: 'missing_scope' }]);
    await resolveSlackIdentity(TOKEN, { userId: 'U1' }, { teamId: TEAM, fetchImpl: scope.impl });

    // Lapse the lock: exactly one caller is admitted to re-probe.
    setCapabilityLockForTest(Date.now() - 1);
    const probe = makeFetch([userOk('U2', 'Jun')]);
    const probed = await resolveSlackIdentity(TOKEN, { userId: 'U2' }, { teamId: TEAM, fetchImpl: probe.impl });
    assert.equal(probed.resolved, true, 'the probe should be admitted');

    // The success unlocked it, so an unrelated id is looked up normally.
    const after = makeFetch([userOk('U3', 'Sujin')]);
    const later = await resolveSlackIdentity(TOKEN, { userId: 'U3' }, { teamId: TEAM, fetchImpl: after.impl });
    assert.equal(after.calls.length, 1, 'the lock must be fully released by a success');
    assert.equal(later.name, 'Sujin');
});

test('only one caller probes when the lock lapses; the rest degrade without calling', async () => {
    const scope = makeFetch([{ ok: false, error: 'missing_scope' }]);
    await resolveSlackIdentity(TOKEN, { userId: 'U1' }, { teamId: TEAM, fetchImpl: scope.impl });
    setCapabilityLockForTest(Date.now() - 1);

    const probe = makeFetch([userOk('UA', 'A')]);
    const [a, b] = await Promise.all([
        resolveSlackIdentity(TOKEN, { userId: 'UA' }, { teamId: TEAM, fetchImpl: probe.impl }),
        resolveSlackIdentity(TOKEN, { userId: 'UB' }, { teamId: TEAM, fetchImpl: probe.impl }),
    ]);
    assert.equal(probe.calls.length, 1, 'exactly one probe may pass the lapsed lock');
    // One resolves, the other degrades — which one is scheduling-dependent.
    assert.equal([a!.resolved, b!.resolved].filter(Boolean).length, 1);
});

// ─── In-flight slot lifecycle ───────────────────────

test('a failed lookup releases its in-flight slot so a later call can retry', async () => {
    const fail = makeFetch([{ ok: false, error: 'internal_error' }]);
    await resolveSlackIdentity(TOKEN, { userId: 'U1' }, { teamId: TEAM, fetchImpl: fail.impl });
    // Clear the negative suppression but keep the process alive.
    resetSlackIdentityCache();
    const ok = makeFetch([userOk('U1', 'Jun')]);
    const identity = await resolveSlackIdentity(TOKEN, { userId: 'U1' }, { teamId: TEAM, fetchImpl: ok.impl });
    assert.equal(ok.calls.length, 1, 'the slot must not stay occupied after a failure');
    assert.equal(identity.name, 'Jun');
});

// ─── Cache partitions and priming ───────────────────

test('user and bot identities occupy separate cache partitions', async () => {
    primeSlackIdentityCache(TEAM, [{ id: 'U1', profile: { display_name: 'Jun' } }]);
    const bot = makeFetch([{ ok: true, bot: { id: 'B1', name: 'Ledger' } }]);
    await resolveSlackIdentity(TOKEN, { botId: 'B1' }, { teamId: TEAM, fetchImpl: bot.impl });
    const stats = slackIdentityCacheStats();
    assert.equal(stats.users, 1, 'the user partition holds the primed user');
    assert.equal(stats.bots, 1, 'the bot partition is counted independently');
});

test('priming is workspace-scoped: another team does not read the cached name', async () => {
    primeSlackIdentityCache(TEAM, [{ id: 'U1', profile: { display_name: 'Jun' } }]);
    assert.equal(getCachedSlackIdentities(TEAM, ['U1']).size, 1);
    assert.equal(getCachedSlackIdentities('T0OTHER', ['U1']).size, 0);
});

// ─── Batch resolution ───────────────────────────────

test('batch resolution reports partial when the top-up cap is reached', async () => {
    const { impl } = makeFetch([userOk('U1', 'Jun')]);
    const batch = await resolveSlackIdentities(
        TOKEN,
        Array.from({ length: 4 }, (_, i) => ({ userId: `U${i}` })),
        { teamId: TEAM, fetchImpl: impl, topUpLimit: 2, minIntervalMs: 0 },
    );
    assert.equal(batch.partial, true, 'exceeding the cap must be reported, not hidden');
    assert.ok(batch.identities.size <= 4);
});

test('batch resolution serves cached entries without any API call', async () => {
    primeSlackIdentityCache(TEAM, [
        { id: 'U1', profile: { display_name: 'Jun' } },
        { id: 'U2', profile: { display_name: 'Sujin' } },
    ]);
    const { impl, calls } = makeFetch([userOk('U9', 'nobody')]);
    const batch = await resolveSlackIdentities(
        TOKEN, [{ userId: 'U1' }, { userId: 'U2' }],
        { teamId: TEAM, fetchImpl: impl, minIntervalMs: 0 },
    );
    assert.equal(calls.length, 0, 'fully cached batches must cost nothing');
    assert.equal(batch.identities.get('U1')?.name, 'Jun');
    assert.equal(batch.identities.get('U2')?.name, 'Sujin');
});

// ─── Reset ──────────────────────────────────────────

test('reset clears the negative cache as well as the positive partitions', async () => {
    const fail = makeFetch([{ ok: false, error: 'user_not_found' }]);
    await resolveSlackIdentity(TOKEN, { userId: 'U404' }, { teamId: TEAM, fetchImpl: fail.impl });
    assert.ok(slackIdentityCacheStats().negative >= 1);
    resetSlackIdentityCache();
    const stats = slackIdentityCacheStats();
    assert.deepEqual([stats.users, stats.bots, stats.negative], [0, 0, 0]);
});
