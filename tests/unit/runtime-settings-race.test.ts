import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GATE = path.join(ROOT, 'src/core/runtime-settings-gate.ts');
const RUNTIME = path.join(ROOT, 'src/core/runtime-settings.ts');
const SPAWN = path.join(ROOT, 'src/agent/spawn.ts');

const gateSrc = fs.readFileSync(GATE, 'utf8');
const runtimeSrc = fs.readFileSync(RUNTIME, 'utf8');
const spawnSrc = fs.readFileSync(SPAWN, 'utf8');

test('RSR-001: runtime settings gate is a leaf module', () => {
    assert.doesNotMatch(gateSrc, /from ['"]\.\/runtime-settings/);
    assert.doesNotMatch(gateSrc, /from ['"].*spawn/);
    assert.doesNotMatch(gateSrc, /from ['"].*builder/);
    assert.doesNotMatch(gateSrc, /from ['"].*compact/);
    assert.doesNotMatch(gateSrc, /from ['"].*config/);
    assert.doesNotMatch(gateSrc, /from ['"].*db/);
});

test('RSR-002: applyRuntimeSettingsPatch wraps mutations in a finally-cleared gate', () => {
    assert.match(runtimeSrc, /import\s+\{\s*beginRuntimeSettingsMutation\s*\}\s+from\s+['"]\.\/runtime-settings-gate\.js['"]/);
    assert.match(runtimeSrc, /const\s+finishSettingsMutation\s*=\s*beginRuntimeSettingsMutation\(\)/);
    assert.match(runtimeSrc, /finally\s*\{\s*finishSettingsMutation\(\);\s*\}/);
});

test('RSR-003: spawn waits before reading session bucket state', () => {
    const waitIdx = spawnSrc.indexOf('waitForRuntimeSettingsIdle()');
    const sessionIdx = spawnSrc.indexOf('const session = (getSession() as SessionRow | undefined) ?? {}');
    const bucketIdx = spawnSrc.indexOf('getSessionBucket.get(currentBucket)');
    assert.ok(waitIdx > -1, 'spawn must wait on runtime settings gate');
    assert.ok(sessionIdx > waitIdx, 'session read must happen after wait path');
    assert.ok(bucketIdx > waitIdx, 'bucket read must happen after wait path');
});

test('RSR-004: gated main spawn contributes to busy state and queue gating', () => {
    // 211531d6 moved the module-global `mainSpawnStarting` into per-scope
    // MainRunState.starting, and isAgentBusy now reads that scoped map. The
    // contract under test is unchanged: a gated spawn marks itself starting,
    // and busy state derives from the scoped run plus the retry timer.
    assert.match(spawnSrc, /starting:\s*boolean/);
    assert.match(spawnSrc, /mainRun!\.starting\s*=\s*true/);
    assert.match(spawnSrc, /return\s+activeMainProcesses\.has\(scopeKey\)\s*\|\|\s*runtimeForScope\(scopeKey\)\.busy\s*\|\|\s*queueCtrl\.isRetryPending\(scopeKey\)/);
    assert.match(spawnSrc, /queueCtrl\.isRetryPending\(scopeKey\)/,
        'isAgentBusy must delegate the retry check to the queue controller');
});

test('RSR-005: stop cancels a pending gated main spawn', async t => {
    const config = await import('../../src/core/config.ts');
    test.mock.module('../../src/core/config.js', { namedExports: { ...config,
        detectCli: () => { assert.fail('cancelled gated spawn reached provider detection'); },
    } });
    const { beginRuntimeSettingsMutation } = await import('../../src/core/runtime-settings-gate.ts');
    const { spawnAgent, killActiveAgent, activeMainProcesses, isAgentBusy } = await import('../../src/agent/spawn.ts');
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('unexpected network'); });
    const scope = 'settings-gated-cancellation';
    const finish = beginRuntimeSettingsMutation();
    try {
        const run = spawnAgent('must never execute', { scopeKey: scope, chatSessionId: 'gated-chat', cli: 'claude' });
        assert.equal(run.child, null);
        assert.equal(activeMainProcesses.get(scope)?.starting, true);
        assert.equal(isAgentBusy(scope), true);
        assert.equal(killActiveAgent(scope, 'user'), true);
        finish();
        assert.deepEqual(await run.promise, { text: '⏹️ [user]', code: -1 });
        assert.equal(activeMainProcesses.has(scope), false);
        assert.equal(isAgentBusy(scope), false);
    } finally { finish(); activeMainProcesses.delete(scope); }
});

test('RSR-006: settings gate only delays direct main user spawns', () => {
    assert.match(
        spawnSrc,
        /const\s+gateEligibleMain\s*=\s*mainManaged\s*&&\s*!opts\.agentId\s*&&\s*!opts\.internal\s*&&\s*!opts\._isFallback\s*&&\s*!opts\._isSmokeContinuation/,
        'gate must exclude internal, agentId, fallback, and smoke-continuation spawns',
    );
    assert.match(
        spawnSrc,
        /if\s*\(\s*gateEligibleMain\s*&&\s*!opts\._settingsGateWaited\s*&&\s*isRuntimeSettingsMutationInFlight\(\)\s*\)/,
        'wait branch should use gateEligibleMain, not broad mainManaged',
    );
});
