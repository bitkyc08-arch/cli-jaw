import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCliStatusLine } from '../../src/cli/cli-status.ts';
import {
    describeCliProbe,
    shouldHydrateRuntimeMigrationResponse,
    type CliStatusInfo,
} from '../../public/js/features/settings-types.ts';

function status(overrides: Partial<CliStatusInfo>): CliStatusInfo {
    return {
        available: null,
        binaryInstalled: null,
        capabilityReady: null,
        authenticated: null,
        path: null,
        source: 'pending-probe',
        checkedCapability: 'spawn-probe',
        probeState: 'checking',
        ...overrides,
    };
}

test('web status classification keeps checking neutral and capability failure distinct', () => {
    assert.equal(describeCliProbe(status({})), 'checking');
    assert.equal(describeCliProbe(status({
        available: false,
        binaryInstalled: true,
        capabilityReady: false,
        authenticated: true,
        probeState: 'fresh',
    })), 'capability-failed');
    assert.equal(describeCliProbe(status({
        available: true,
        binaryInstalled: true,
        capabilityReady: true,
        authenticated: true,
        probeState: 'stale',
    })), 'stale');
});

test('in-process /version formatter prints checking without a success or failure icon', () => {
    const checking = formatCliStatusLine('codex-app', status({}));
    assert.equal(checking, 'codex-app: checking');
    assert.doesNotMatch(checking, /[✅❌]/);
    assert.equal(formatCliStatusLine('codex', status({
        available: true,
        binaryInstalled: true,
        capabilityReady: false,
        authenticated: true,
        path: '/bin/codex',
        probeState: 'fresh',
    })), 'codex: ❌ /bin/codex');
});

test('Web migration hydrates authoritative success/409 only', () => {
    assert.equal(shouldHydrateRuntimeMigrationResponse(200), true);
    assert.equal(shouldHydrateRuntimeMigrationResponse(409), true);
    for (const statusCode of [0, 400, 401, 500, 503]) {
        assert.equal(shouldHydrateRuntimeMigrationResponse(statusCode), false);
    }
});
