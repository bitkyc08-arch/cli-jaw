import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileActiveProfileFilter } from '../../public/manager/src/profile-filter';
import type { DashboardProfile } from '../../public/manager/src/types';

function profile(profileId: string): DashboardProfile {
    return {
        profileId,
        label: profileId,
        homePath: `/tmp/${profileId}`,
        preferredPort: null,
        serviceMode: 'unknown',
        defaultCli: null,
        notes: null,
        lastSeenAt: null,
        pinned: false,
        color: null,
    };
}

test('reconcileActiveProfileFilter drops stale profile ids before they can reactivate', () => {
    assert.deepEqual(
        reconcileActiveProfileFilter(['stale', 'known'], [profile('known')]),
        ['known'],
    );
});

test('reconcileActiveProfileFilter preserves the same array when no pruning is needed', () => {
    const active = ['known'];
    assert.equal(reconcileActiveProfileFilter(active, [profile('known')]), active);
});
