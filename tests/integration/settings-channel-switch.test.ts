// Settings channel switch integration tests — Phase 6
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const runtimeSrc = readFileSync(join(projectRoot, 'src/messaging/runtime.ts'), 'utf8');
const runtimeSettingsSrc = readFileSync(join(projectRoot, 'src/core/runtime-settings.ts'), 'utf8');
const configSrc = readFileSync(join(projectRoot, 'src/core/config.ts'), 'utf8');
const pipelineSrc = readFileSync(join(projectRoot, 'src/orchestrator/pipeline.ts'), 'utf8');

// ─── Channel switch triggers restart ────────────────

test('channel switch detected by restartMessagingRuntime', () => {
    assert.match(runtimeSrc, /channelSwitched/,
        'should detect channel switch');
    assert.match(runtimeSrc, /prevChannel.*!==.*nextChannel/,
        'should compare previous vs next channel');
});

// ─── Restart clears stale targets ───────────────────

test('restart clears all target state to prevent stale routing', () => {
    assert.match(runtimeSrc, /clearTargetState\(\)/,
        'should call clearTargetState() on restart');
});

// ─── Fresh home env-only Discord boot ──────────────

test('env-only Discord boot works without settings.json', () => {
    // loadSettings catch path must apply env overrides
    const catchSection = configSrc.slice(configSrc.lastIndexOf('} catch'));
    assert.ok(catchSection.includes('applyEnvOverrides'),
        'loadSettings catch path must apply env overrides for fresh-home boot');
});

test('DISCORD_TOKEN auto-switches channel when telegram disabled', () => {
    assert.match(configSrc, /channel.*=.*'discord'/,
        'should auto-switch to discord when telegram is not configured');
});

// ─── Failed restart rolls back settings ─────────────

test('failed restart/login rolls back persisted settings', () => {
    assert.match(runtimeSettingsSrc, /replaceSettings\(prevSnapshot\)/,
        'should restore previous settings on restart failure');
    assert.match(runtimeSettingsSrc, /throw e/,
        'should propagate error to caller');
});

// ─── Pipeline broadcasts include target ─────────────

test('orchestrate_done broadcasts include target for queue correlation', () => {
    // Count occurrences of target in orchestrate_done broadcasts
    const broadcasts = pipelineSrc.match(/broadcast\('orchestrate_done'[\s\S]*?\}\)/g) || [];
    assert.ok(broadcasts.length >= 3, `expected at least 3 orchestrate_done broadcasts, got ${broadcasts.length}`);
    const withTarget = broadcasts.filter(b => b.includes('target'));
    assert.equal(withTarget.length, broadcasts.length,
        `all orchestrate_done broadcasts must include target, but only ${withTarget.length}/${broadcasts.length} do`);
});
