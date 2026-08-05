// /reset confirm must invalidate resumable native sessions even when the
// best-effort autoCompactRefresh() fails before its own bucket clear
// (guarded AGY native resume reads session_buckets, not the main session row).
import test from 'node:test';
import assert from 'node:assert/strict';

const clearedBucketGroups: Array<[string, string]> = [];
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
        clearSessionBucketsByPrefix: {
            run: (bucket: string, pattern: string) => { clearedBucketGroups.push([bucket, pattern]); },
        },
        clearSessionBucket: {
            run: (bucket: string) => { clearedBuckets.push(bucket); },
        },
    },
});
test.mock.module('../../src/agent/args.ts', {
    namedExports: {
        resolveScopedSessionBucket: (cli: string | null | undefined, _m: unknown, _p: unknown, scope: string) =>
            (scope === 'default' ? (cli || '') : `${cli || ''}:${scope}`),
    },
});
test.mock.module('../../src/agent/session-persistence.ts', {
    namedExports: {
        bumpSessionOwnershipGeneration: () => { ownershipBumps += 1; },
        // A session-local reset outside any session context falls back to the global
        // bump, which is the case this test exercises (073 §2.2).
        bumpGenerationForSessionLocalReset: () => { ownershipBumps += 1; },
    },
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
    assert.deepEqual(clearedBucketGroups, [['agy', 'codex-app:%']],
        'active legacy and codex-app scoped buckets must be cleared despite compact failure');
    assert.equal(ownershipBumps, 1);
    assert.equal(mainStateClears, 1);
});

// 073 §2.2a — the same reset issued from inside a session must stay inside it. Wiping the
// codex-app prefix there would cut lanes belonging to sessions that never asked for one.
test('RESET-BUCKET-02: a scoped reset clears only its own bucket', async () => {
    clearedBucketGroups.length = 0;
    clearedBuckets.length = 0;
    const { clearSessionState } = await import('../../src/core/session-ops.ts');
    const { withSessionScope } = await import('../../src/core/session-context.ts');
    await withSessionScope({ scope: 'local:b', chatSessionId: 'b' }, () => clearSessionState());
    assert.deepEqual(clearedBuckets, ['agy:local:b']);
    assert.deepEqual(clearedBucketGroups, [],
        'a scoped reset must not take the whole codex-app lane family with it');
});
