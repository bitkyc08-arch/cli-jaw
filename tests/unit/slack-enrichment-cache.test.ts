// The enrichment-cache primitive: TTL/eviction, classified suppression,
// capability lockout with a single re-probe, in-flight coalescing, aggregate
// cancellation, and generation invalidation.
//
// Every conditional path here is driven to fire — a branch nobody can show
// firing is unverified regardless of suite status. Contract: devlog
// 260812_slack_conversation_context/012_wp1_replan_shared_primitive.md.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EnrichmentCache, type Suppression } from '../../src/slack/enrichment-cache.ts';

type Part = 'main' | 'other';

/** Deferred promise so a test can hold a load open and control its settlement. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

function makeCache(options: {
    ttlMs?: number;
    cap?: number;
    classify?: (error: string) => Suppression;
    onEvent?: (e: unknown) => void;
} = {}) {
    const ttl = options.ttlMs ?? 60_000;
    const cap = options.cap ?? 100;
    return new EnrichmentCache<Part, string, string>({
        partitions: {
            main: { ttlMs: () => ttl, cap },
            other: { ttlMs: () => ttl, cap },
        },
        classifyFailure: options.classify
            ?? ((error: string): Suppression =>
                error === 'missing_scope'
                    ? { kind: 'capability', key: 'cap:test', ttlMs: 30_000 }
                    : { kind: 'resource', key: `res:${error}`, ttlMs: 60_000 }),
        ...(options.onEvent ? { onEvent: options.onEvent as never } : {}),
    });
}

const ok = (value: string) => ({ ok: true as const, value });
const fail = (error: string) => ({ ok: false as const, error });

// ─── caching ────────────────────────────────────────

test('a success is cached and the second call does not load', async () => {
    const cache = makeCache();
    let loads = 0;
    const load = async () => { loads += 1; return ok('v1'); };
    assert.equal(await cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'cap:test',
        load, degraded: () => 'DEGRADED',
    }), 'v1');
    assert.equal(await cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'cap:test',
        load, degraded: () => 'DEGRADED',
    }), 'v1');
    assert.equal(loads, 1);
});

test('an expired entry is reloaded', async () => {
    const cache = makeCache({ ttlMs: 1 });
    let loads = 0;
    const load = async () => { loads += 1; return ok(`v${loads}`); };
    await cache.resolve({ partition: 'main', resourceKey: 'k', capabilityKey: 'c', load, degraded: () => 'D' });
    await new Promise(r => setTimeout(r, 5));
    const second = await cache.resolve({ partition: 'main', resourceKey: 'k', capabilityKey: 'c', load, degraded: () => 'D' });
    assert.equal(loads, 2);
    assert.equal(second, 'v2');
});

test('partitions are independent keyspaces with independent caps', async () => {
    const cache = makeCache();
    await cache.resolve({ partition: 'main', resourceKey: 'k', capabilityKey: 'c', load: async () => ok('a'), degraded: () => 'D' });
    await cache.resolve({ partition: 'other', resourceKey: 'k', capabilityKey: 'c', load: async () => ok('b'), degraded: () => 'D' });
    assert.equal(cache.get('main', 'k'), 'a');
    assert.equal(cache.get('other', 'k'), 'b');
    assert.equal(cache.entryCount('main'), 1);
    assert.equal(cache.entryCount('other'), 1);
});

test('exceeding the cap evicts the half closest to expiry', async () => {
    const cache = makeCache({ cap: 4 });
    for (let i = 0; i < 6; i += 1) {
        await cache.resolve({
            partition: 'main', resourceKey: `k${i}`, capabilityKey: 'c',
            load: async () => ok(`v${i}`), degraded: () => 'D',
        });
    }
    assert.ok(cache.entryCount('main') <= 4, 'cap must bound the partition');
    assert.equal(cache.get('main', 'k5'), 'v5', 'the newest entry survives');
});

test('prime inserts without loading', async () => {
    const cache = makeCache();
    cache.prime('main', 'k', 'primed');
    let loads = 0;
    const value = await cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'c',
        load: async () => { loads += 1; return ok('loaded'); }, degraded: () => 'D',
    });
    assert.equal(value, 'primed');
    assert.equal(loads, 0);
});

// ─── suppression ────────────────────────────────────

test('a resource failure suppresses only that resource', async () => {
    const cache = makeCache();
    let loads = 0;
    const load = async () => { loads += 1; return fail('boom'); };
    await cache.resolve({ partition: 'main', resourceKey: 'res:boom', capabilityKey: 'c', load, degraded: () => 'D' });
    await cache.resolve({ partition: 'main', resourceKey: 'res:boom', capabilityKey: 'c', load, degraded: () => 'D' });
    assert.equal(loads, 1, 'the second attempt is suppressed');

    const other = await cache.resolve({
        partition: 'main', resourceKey: 'res:elsewhere', capabilityKey: 'c',
        load: async () => ok('fine'), degraded: () => 'D',
    });
    assert.equal(other, 'fine', 'a different resource is unaffected');
});

test('a capability failure blocks every resource under that capability', async () => {
    const cache = makeCache();
    let loads = 0;
    await cache.resolve({
        partition: 'main', resourceKey: 'k1', capabilityKey: 'cap:test',
        load: async () => { loads += 1; return fail('missing_scope'); }, degraded: () => 'D',
    });
    const second = await cache.resolve({
        partition: 'main', resourceKey: 'k2', capabilityKey: 'cap:test',
        load: async () => { loads += 1; return ok('never'); }, degraded: () => 'D',
    });
    assert.equal(loads, 1, 'the capability lock stops the unrelated resource too');
    assert.equal(second, 'D');
});

test('after a capability lock lapses exactly one caller re-probes', async () => {
    const cache = makeCache({
        classify: () => ({ kind: 'capability', key: 'cap:test', ttlMs: 1 }),
    });
    await cache.resolve({
        partition: 'main', resourceKey: 'k0', capabilityKey: 'cap:test',
        load: async () => fail('missing_scope'), degraded: () => 'D',
    });
    await new Promise(r => setTimeout(r, 5)); // let the lock lapse

    const gate = deferred<void>();
    let starts = 0;
    const load = async () => { starts += 1; await gate.promise; return ok('back'); };
    const a = cache.resolve({ partition: 'main', resourceKey: 'kA', capabilityKey: 'cap:test', load, degraded: () => 'D' });
    const b = cache.resolve({ partition: 'main', resourceKey: 'kB', capabilityKey: 'cap:test', load, degraded: () => 'D' });
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(starts, 1, 'only the single admitted probe may start');
    assert.equal([ra, rb].filter(v => v === 'back').length, 1);
});

test('a successful probe clears the capability lock for later callers', async () => {
    const cache = makeCache({
        classify: () => ({ kind: 'capability', key: 'cap:test', ttlMs: 1 }),
    });
    await cache.resolve({
        partition: 'main', resourceKey: 'k0', capabilityKey: 'cap:test',
        load: async () => fail('missing_scope'), degraded: () => 'D',
    });
    await new Promise(r => setTimeout(r, 5));
    await cache.resolve({
        partition: 'main', resourceKey: 'k1', capabilityKey: 'cap:test',
        load: async () => ok('probe'), degraded: () => 'D',
    });
    const after = await cache.resolve({
        partition: 'main', resourceKey: 'k2', capabilityKey: 'cap:test',
        load: async () => ok('free'), degraded: () => 'D',
    });
    assert.equal(after, 'free', 'the lock must be released by a successful probe');
});

test('a failed probe releases its reservation so the capability can be probed again', async () => {
    const cache = makeCache({
        classify: (e) => e === 'other'
            ? { kind: 'resource', key: 'res:other', ttlMs: 1 }
            : { kind: 'capability', key: 'cap:test', ttlMs: 1 },
    });
    await cache.resolve({
        partition: 'main', resourceKey: 'k0', capabilityKey: 'cap:test',
        load: async () => fail('missing_scope'), degraded: () => 'D',
    });
    await new Promise(r => setTimeout(r, 5));
    // The probe fails for an UNRELATED reason: the reservation must still return.
    await cache.resolve({
        partition: 'main', resourceKey: 'k1', capabilityKey: 'cap:test',
        load: async () => fail('other'), degraded: () => 'D',
    });
    await new Promise(r => setTimeout(r, 5));
    const later = await cache.resolve({
        partition: 'main', resourceKey: 'k2', capabilityKey: 'cap:test',
        load: async () => ok('recovered'), degraded: () => 'D',
    });
    assert.equal(later, 'recovered', 'a stuck probe reservation would deadlock the capability');
});

// ─── coalescing and cancellation ────────────────────

test('concurrent callers of one key share a single load and both get the value', async () => {
    const cache = makeCache();
    const gate = deferred<void>();
    let loads = 0;
    const load = async () => { loads += 1; await gate.promise; return ok('shared'); };
    const a = cache.resolve({ partition: 'main', resourceKey: 'k', capabilityKey: 'c', load, degraded: () => 'D' });
    const b = cache.resolve({ partition: 'main', resourceKey: 'k', capabilityKey: 'c', load, degraded: () => 'D' });
    gate.resolve();
    assert.deepEqual(await Promise.all([a, b]), ['shared', 'shared']);
    assert.equal(loads, 1);
});

test('one caller aborting does not cancel the peer, and the success still caches', async () => {
    const cache = makeCache();
    const gate = deferred<void>();
    let loads = 0;
    let sawAbort = false;
    const load = async (ctx: { signal: AbortSignal }) => {
        loads += 1;
        ctx.signal.addEventListener('abort', () => { sawAbort = true; });
        await gate.promise;
        return ok('shared');
    };
    const controller = new AbortController();
    const aborted = cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'c',
        load, degraded: () => 'D', signal: controller.signal,
    });
    const healthy = cache.resolve({ partition: 'main', resourceKey: 'k', capabilityKey: 'c', load, degraded: () => 'D' });
    controller.abort();
    assert.equal(await aborted, 'D', 'the cancelled caller degrades promptly');
    gate.resolve();
    assert.equal(await healthy, 'shared', 'the peer is unaffected');
    assert.equal(loads, 1);
    assert.equal(sawAbort, false, 'shared work must not carry a caller signal');
    assert.equal(cache.get('main', 'k'), 'shared', 'the success may still cache');
});

test('when the last waiter aborts the shared work is aborted too', async () => {
    const cache = makeCache();
    const gate = deferred<void>();
    let aborts = 0;
    const load = async (ctx: { signal: AbortSignal }) => {
        ctx.signal.addEventListener('abort', () => { aborts += 1; });
        await gate.promise;
        return ok('late');
    };
    const controller = new AbortController();
    const only = cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'c',
        load, degraded: () => 'D', signal: controller.signal,
    });
    controller.abort();
    assert.equal(await only, 'D');
    assert.equal(aborts, 1, 'the sole waiter leaving must abort the internal controller');
    gate.resolve();
});

test('a caller arriving after the record retires starts fresh work', async () => {
    const cache = makeCache();
    const first = deferred<void>();
    let loads = 0;
    const slow = async () => { loads += 1; await first.promise; return ok('first'); };
    const controller = new AbortController();
    const abandoned = cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'c',
        load: slow, degraded: () => 'D', signal: controller.signal,
    });
    controller.abort();
    assert.equal(await abandoned, 'D');

    // The retired record must not be joinable, and its later cleanup must not
    // delete the replacement's slot.
    const fresh = await cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'c',
        load: async () => { loads += 1; return ok('second'); }, degraded: () => 'D',
    });
    assert.equal(fresh, 'second');
    assert.equal(loads, 2, 'the late caller starts its own request');
    first.resolve();
});

test('an already-aborted caller costs zero loads', async () => {
    const cache = makeCache();
    let loads = 0;
    const controller = new AbortController();
    controller.abort();
    const value = await cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'c',
        load: async () => { loads += 1; return ok('v'); },
        degraded: () => 'D', signal: controller.signal,
    });
    assert.equal(value, 'D');
    assert.equal(loads, 0);
});

// ─── generation ─────────────────────────────────────

test('a reset between load and settlement discards the value for cache AND waiters', async () => {
    const cache = makeCache();
    const gate = deferred<void>();
    const pending = cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'c',
        load: async () => { await gate.promise; return ok('stale'); },
        degraded: () => 'DEGRADED',
    });
    cache.reset();
    gate.resolve();
    // Not merely "the cache stays empty": the waiter must not receive the
    // superseded workspace's value either.
    assert.equal(await pending, 'DEGRADED');
    assert.equal(cache.get('main', 'k'), undefined);
});

test('reset clears caches, suppression, and lets a later lookup proceed', async () => {
    const cache = makeCache();
    await cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'cap:test',
        load: async () => fail('missing_scope'), degraded: () => 'D',
    });
    cache.reset();
    const after = await cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'cap:test',
        load: async () => ok('fresh'), degraded: () => 'D',
    });
    assert.equal(after, 'fresh', 'reset must lift the capability lock');
    assert.equal(cache.stats().suppressed, 0);
});

// ─── admission ──────────────────────────────────────

test('a declined start degrades immediately without waiting or loading', async () => {
    const events: string[] = [];
    const cache = makeCache({ onEvent: (e) => events.push((e as { type: string }).type) });
    let loads = 0;
    const value = await cache.resolve({
        partition: 'main', resourceKey: 'k', capabilityKey: 'c',
        load: async () => { loads += 1; return ok('v'); },
        degraded: () => 'D',
        admitStart: () => false,
    });
    assert.equal(value, 'D');
    assert.equal(loads, 0);
    assert.ok(events.includes('admission_declined'), 'the degrade must be observable');
});

test('a coalesced waiter does not consume the start budget', async () => {
    const cache = makeCache();
    const gate = deferred<void>();
    let admissions = 0;
    let loads = 0;
    const load = async () => { loads += 1; await gate.promise; return ok('shared'); };
    const admitStart = () => { admissions += 1; return true; };
    const a = cache.resolve({ partition: 'main', resourceKey: 'k', capabilityKey: 'c', load, degraded: () => 'D', admitStart });
    const b = cache.resolve({ partition: 'main', resourceKey: 'k', capabilityKey: 'c', load, degraded: () => 'D', admitStart });
    gate.resolve();
    await Promise.all([a, b]);
    assert.equal(loads, 1);
    assert.equal(admissions, 1, 'joining is not starting');
});
