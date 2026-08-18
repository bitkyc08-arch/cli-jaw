/**
 * #383 regression: terminal-capabilities read $env.PI_NOTIFICATIONS as a
 * property of the exported *function* $env, so the env vars were inert on
 * every platform. src/lib/tui is excluded from the root tsconfig, so only a
 * runtime test can hold this.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// terminal-capabilities reads Bun.env at module scope; the runtime loads the
// shim first (atomic-build copies bun-shim.mjs into dist for exactly this).
await import('../../src/lib/tui/bun-shim.mjs');
const { isNotificationSuppressed } = await import('../../src/lib/tui/terminal-capabilities.ts');

test('TEF-001: PI_NOTIFICATIONS=off suppresses notifications', () => {
    const prev = process.env['PI_NOTIFICATIONS'];
    try {
        process.env['PI_NOTIFICATIONS'] = 'off';
        assert.equal(isNotificationSuppressed(), true);
        process.env['PI_NOTIFICATIONS'] = '0';
        assert.equal(isNotificationSuppressed(), true);
        delete process.env['PI_NOTIFICATIONS'];
        assert.equal(isNotificationSuppressed(), false);
    } finally {
        if (prev === undefined) delete process.env['PI_NOTIFICATIONS'];
        else process.env['PI_NOTIFICATIONS'] = prev;
    }
});
