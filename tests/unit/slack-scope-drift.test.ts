// #340: an app installed from an older manifest keeps its original grant, and
// nothing told the operator. These tests drive the DEFICIENT state for real —
// "all green" proves nothing here, because every path under test only runs
// when a scope is actually missing.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    recordSlackScopeObservation,
    getSlackScopeStatus,
    describeSlackScopeGap,
    resetSlackScopeStatus,
} from '../../src/slack/scope-status.ts';
import {
    REQUIRED_SLACK_BOT_SCOPES,
    SLACK_CAPABILITY_SCOPES,
} from '../../src/messaging/channel-validate.ts';
import { slackApi } from '../../src/slack/api.ts';

const ALL = [...REQUIRED_SLACK_BOT_SCOPES, ...SLACK_CAPABILITY_SCOPES];

const IDENTITY_SCOPES = ['users:read', 'team:read', 'channels:read', 'groups:read', 'im:read', 'mpim:read'];

/** The exact shape #340 reported: core scopes granted, identity/roster not. */
const OLD_INSTALL_GRANT = ALL.filter(s => !IDENTITY_SCOPES.includes(s)).join(',');

function headerFetch(granted: string | null): typeof fetch {
    return (async () => ({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k === 'x-oauth-scopes' ? granted : null) },
        text: async () => JSON.stringify({ ok: true, user_id: 'U1', team_id: 'T1' }),
    } as unknown as Response)) as typeof fetch;
}

test('the six scopes from the bug report are reported by name', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(OLD_INSTALL_GRANT, null);
    const status = getSlackScopeStatus();

    assert.equal(status.unknown, false);
    assert.equal(status.ok, false);
    assert.deepEqual(status.missingRequired, [], 'core messaging still works — a degradation, not an outage');
    assert.deepEqual(status.missingCapabilities, IDENTITY_SCOPES);

    // The whole point: ONE line naming ALL of them, not one per failed call.
    const line = describeSlackScopeGap(status)!;
    for (const scope of status.missingCapabilities) {
        assert.ok(line.includes(scope), scope + ' missing from the operator line');
    }
});

test('a full grant produces no warning at all', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(ALL.join(','), null);
    const status = getSlackScopeStatus();

    assert.equal(status.ok, true);
    assert.equal(status.unknown, false);
    // A warning that always fires is a warning nobody reads.
    assert.equal(describeSlackScopeGap(status), null);
});

test('an unobserved header is "cannot check", not "nothing missing"', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(undefined, null);
    const status = getSlackScopeStatus();

    assert.equal(status.unknown, true);
    assert.equal(status.checkedAt, null);
    // ok stays true so a header-stripping proxy cannot manufacture a false
    // alarm, but the unknown flag is what consumers must branch on.
    assert.equal(describeSlackScopeGap(status), null, 'no measurement means no claim');
});

test('a missing required scope is reported as a real break', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(ALL.filter(s => s !== 'chat:write').join(','), null);
    const status = getSlackScopeStatus();

    assert.deepEqual(status.missingRequired, ['chat:write']);
    assert.equal(status.ok, false);
    assert.match(describeSlackScopeGap(status)!, /the transport needs/);
});

test('the reinstall URL appears only when the app id is known', () => {
    resetSlackScopeStatus();
    recordSlackScopeObservation(OLD_INSTALL_GRANT, 'A123');
    assert.match(describeSlackScopeGap(getSlackScopeStatus())!, /apps\/A123\/install-on-team/);

    resetSlackScopeStatus();
    recordSlackScopeObservation(OLD_INSTALL_GRANT, null);
    const line = describeSlackScopeGap(getSlackScopeStatus())!;
    // Never guess an app id: a wrong one sends the operator to someone else's app.
    assert.doesNotMatch(line, /api\.slack\.com\/apps/);
    assert.match(line, /OAuth & Permissions/);
});

test('slackApi carries x-oauth-scopes through to the result', async () => {
    const result = await slackApi('xoxb-1', 'auth.test', undefined, {
        fetchImpl: headerFetch(OLD_INSTALL_GRANT),
    });
    assert.equal(result.ok, true);
    assert.equal(result.grantedScopes, OLD_INSTALL_GRANT);
});

test('a header-less response leaves grantedScopes undefined rather than empty', async () => {
    const result = await slackApi('xoxb-1', 'auth.test', undefined, {
        fetchImpl: (async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ok: true }),
        } as unknown as Response)) as typeof fetch,
    });
    // No headers object at all — the shape most existing test mocks use.
    assert.equal(result.ok, true);
    assert.equal(result.grantedScopes, undefined);

    resetSlackScopeStatus();
    recordSlackScopeObservation(result.grantedScopes, null);
    assert.equal(getSlackScopeStatus().unknown, true);
});

test('a failed call still reports the grant it observed', async () => {
    const result = await slackApi('xoxb-1', 'users.info', undefined, {
        fetchImpl: (async () => ({
            ok: true,
            status: 200,
            headers: { get: (k: string) => (k === 'x-oauth-scopes' ? OLD_INSTALL_GRANT : null) },
            text: async () => JSON.stringify({ ok: false, error: 'missing_scope', needed: 'users:read' }),
        } as unknown as Response)) as typeof fetch,
    });
    // ok:false is where a missing_scope answer lives, so dropping the header
    // here would blind the exact case this feature exists for.
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing_scope');
    assert.equal(result.grantedScopes, OLD_INSTALL_GRANT);
});

