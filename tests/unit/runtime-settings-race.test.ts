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
    const sessionIdx = spawnSrc.indexOf('const session: any = getSession()');
    const bucketIdx = spawnSrc.indexOf('getSessionBucket.get(currentBucket)');
    assert.ok(waitIdx > -1, 'spawn must wait on runtime settings gate');
    assert.ok(sessionIdx > waitIdx, 'session read must happen after wait path');
    assert.ok(bucketIdx > waitIdx, 'bucket read must happen after wait path');
});

test('RSR-004: gated main spawn contributes to busy state and queue gating', () => {
    assert.match(spawnSrc, /let\s+mainSpawnStarting\s*=\s*false/);
    assert.match(spawnSrc, /return\s+!!activeProcess\s*\|\|\s*!!retryPendingTimer\s*\|\|\s*mainSpawnStarting/);
    assert.match(spawnSrc, /activeProcess\s*\|\|\s*retryPendingTimer\s*\|\|\s*mainSpawnStarting\s*\|\|\s*hasBlockingWorkers\(\)/);
});

test('RSR-005: stop cancels a pending gated main spawn', () => {
    assert.match(spawnSrc, /let\s+cancelPendingMainSpawn/);
    assert.match(spawnSrc, /cancelPendingMainSpawn\s*\?\s*\(\s*cancelPendingMainSpawn\(reason\),\s*true\s*\)/);
    assert.match(spawnSrc, /if\s*\(\s*cancelled\s*\)\s*\{[\s\S]*code:\s*-1[\s\S]*\}/);
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
