// /reset confirm must invalidate resumable native sessions even when the
// best-effort autoCompactRefresh() fails before its own bucket clear
// (guarded AGY native resume reads session_buckets, not the main session row).
import test from 'node:test';
import assert from 'node:assert/strict';

const clearedBuckets: string[] = [];
let ownershipBumps = 0;
let mainStateClears = 0;

test.mock.module('../../src/core/compact.ts', {
    namedExports: {
        autoCompactRefresh: async () => { throw new Error('compact unavailable'); },
    },
});
test.mock.module('../../src/core/db.ts', {
    namedExports: {
        clearSessionBucket: { run: (bucket: string) => { clearedBuckets.push(bucket); } },
    },
});
test.mock.module('../../src/agent/args.ts', {
    namedExports: {
        resolveSessionBucket: (cli: string | null | undefined) => cli || '',
    },
});
test.mock.module('../../src/agent/session-persistence.ts', {
    namedExports: { bumpSessionOwnershipGeneration: () => { ownershipBumps += 1; } },
});
test.mock.module('../../src/core/main-session.ts', {
    namedExports: {
        clearMainSessionState: () => { mainStateClears += 1; return {}; },
        resetSessionPreservingHistory: () => ({}),
    },
});
test.mock.module('../../src/agent/spawn.ts', {
    namedExports: { resetFallbackState: () => {} },
});
test.mock.module('../../src/core/runtime-settings.ts', {
    namedExports: { applyRuntimeSettingsPatch: async () => ({}) },
});
test.mock.module('../../src/core/config.ts', {
    namedExports: { settings: { cli: 'agy', model: 'gemini-3.5-pro', workingDir: '/tmp' } },
});

test('RESET-BUCKET-01: reset clears the session bucket even when compaction fails', async () => {
    const { clearSessionState } = await import('../../src/core/session-ops.ts');
    await clearSessionState();
    assert.deepEqual(clearedBuckets, ['agy'], 'bucket must be cleared despite compact failure');
    assert.equal(ownershipBumps, 1);
    assert.equal(mainStateClears, 1);
});
