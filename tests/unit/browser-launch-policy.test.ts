import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEBUG_CONSOLE_ONLY_MESSAGE,
    normalizeBrowserStartMode,
    resolveLaunchPolicy,
} from '../../src/browser/launch-policy.ts';

test('BLP-001: invalid mode falls back to manual', () => {
    assert.equal(normalizeBrowserStartMode('unknown'), 'manual');
    assert.equal(normalizeBrowserStartMode(undefined), 'manual');
});

test('BLP-002: manual mode keeps visible browser by default', () => {
    const policy = resolveLaunchPolicy({ mode: 'manual', headless: false, envHeadless: false });
    assert.equal(policy.mode, 'manual');
    assert.equal(policy.allowLaunch, true);
    assert.equal(policy.headless, false);
});

test('BLP-003: manual mode respects explicit headless requests', () => {
    const policy = resolveLaunchPolicy({ mode: 'manual', headless: true, envHeadless: false });
    assert.equal(policy.allowLaunch, true);
    assert.equal(policy.headless, true);
});

test('BLP-004: agent mode always forces headless automation', () => {
    const policy = resolveLaunchPolicy({ mode: 'agent', headless: false, envHeadless: false });
    assert.equal(policy.mode, 'agent');
    assert.equal(policy.allowLaunch, true);
    assert.equal(policy.headless, true);
});

test('BLP-005: debug mode denies browser launch and points to debug console', () => {
    const policy = resolveLaunchPolicy({ mode: 'debug', headless: false, envHeadless: false });
    assert.equal(policy.mode, 'debug');
    assert.equal(policy.allowLaunch, false);
    assert.equal(policy.denyReason, DEBUG_CONSOLE_ONLY_MESSAGE);
});
