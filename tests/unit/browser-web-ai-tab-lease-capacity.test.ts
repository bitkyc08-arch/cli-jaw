import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assertActiveCapacity,
    isDeadOwnerActiveLease,
    ProviderActiveCapacityError,
    type TabLease,
} from '../../src/browser/web-ai/tab-lease-store.ts';

function lease(over: Partial<TabLease> = {}): TabLease {
    return {
        owner: 'cli-jaw',
        vendor: 'chatgpt',
        sessionType: 'jaw',
        origin: 'https://chatgpt.com',
        browserProfileKey: 'cdp:9222',
        targetId: `T${Math.floor(over.ownerPid ?? 0)}-${over.leaseKey ?? 'k'}`,
        state: 'active-session',
        leasedAt: '2026-06-25T00:00:00Z',
        updatedAt: '2026-06-25T00:00:00Z',
        leaseKey: 'cli-jaw:chatgpt:jaw:https://chatgpt.com:cdp:9222',
        ...over,
    };
}

// 8.11 (catalog 106): active-session capacity caps + dead-owner reclaim.
test('BWAI-LEASECAP-001: under both caps → no throw', () => {
    const retained = [lease(), lease()];
    assert.doesNotThrow(() => assertActiveCapacity(retained, lease(), { maxPerKey: 5, globalMax: 14 }));
});

test('BWAI-LEASECAP-002: per-key cap throws ProviderActiveCapacityError', () => {
    const retained = [lease(), lease(), lease()];
    try {
        assertActiveCapacity(retained, lease(), { maxPerKey: 3, globalMax: 14 });
        assert.fail('expected throw');
    } catch (err) {
        assert.ok(err instanceof ProviderActiveCapacityError);
        assert.equal((err as ProviderActiveCapacityError).errorCode, 'provider.active-capacity');
        assert.equal((err as ProviderActiveCapacityError).stage, 'provider-capacity');
        assert.equal((err as ProviderActiveCapacityError).evidence.reason, 'active-max-per-key');
        assert.equal((err as ProviderActiveCapacityError).evidence.current, 3);
    }
});

test('BWAI-LEASECAP-003: global cap throws when many keys but same owner+profile', () => {
    const retained = Array.from({ length: 4 }, (_, i) => lease({ leaseKey: `k${i}` }));
    try {
        assertActiveCapacity(retained, lease({ leaseKey: 'kNew' }), { maxPerKey: 99, globalMax: 4 });
        assert.fail('expected throw');
    } catch (err) {
        assert.ok(err instanceof ProviderActiveCapacityError);
        assert.equal((err as ProviderActiveCapacityError).evidence.reason, 'active-global-max');
    }
});

test('BWAI-LEASECAP-004: caps only count same owner+profile active-session leases', () => {
    const retained = [
        lease({ owner: 'other' }),
        lease({ browserProfileKey: 'cdp:9999' }),
        lease({ state: 'pooled' }),
    ];
    // none of the retained match the next lease's owner+profile+active → under cap
    assert.doesNotThrow(() => assertActiveCapacity(retained, lease(), { maxPerKey: 1, globalMax: 1 }));
});

test('BWAI-LEASECAP-005: negative cap disables that check', () => {
    const retained = Array.from({ length: 20 }, () => lease());
    assert.doesNotThrow(() => assertActiveCapacity(retained, lease(), { maxPerKey: -1, globalMax: -1 }));
});

test('BWAI-LEASECAP-006: isDeadOwnerActiveLease only reclaims active leases with a dead positive pid', () => {
    const dead = () => false;
    const alive = () => true;
    assert.equal(isDeadOwnerActiveLease(lease({ ownerPid: 12345 }), dead), true);
    assert.equal(isDeadOwnerActiveLease(lease({ ownerPid: 12345 }), alive), false);
    // legacy / missing pid → never reclaimed
    assert.equal(isDeadOwnerActiveLease(lease({ ownerPid: null }), dead), false);
    assert.equal(isDeadOwnerActiveLease(lease({ ownerPid: 0 }), dead), false);
    assert.equal(isDeadOwnerActiveLease({ state: 'active-session' }, dead), false);
    // pooled leases are never reclaimed by pid
    assert.equal(isDeadOwnerActiveLease(lease({ state: 'pooled', ownerPid: 12345 }), dead), false);
});
