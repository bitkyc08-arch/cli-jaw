// Messaging runtime tests — Phase 6 Bundle B
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const runtimeSrc = readFileSync(join(projectRoot, 'src/messaging/runtime.ts'), 'utf8');
const configSrc = readFileSync(join(projectRoot, 'src/core/config.ts'), 'utf8');
const runtimeSettingsSrc = readFileSync(join(projectRoot, 'src/core/runtime-settings.ts'), 'utf8');
const serverSrc = readFileSync(join(projectRoot, 'server.ts'), 'utf8');

// ─── Target state management ──────────────────────

test('runtime exports clearTargetState for restart cleanup', () => {
    assert.match(runtimeSrc, /export function clearTargetState/,
        'clearTargetState must be exported');
});

test('runtime exports hydrateTargetsFromSettings for boot-time hydration', () => {
    assert.match(runtimeSrc, /export function hydrateTargetsFromSettings/,
        'hydrateTargetsFromSettings must be exported');
});

test('server.ts hydrates targets from settings on boot', () => {
    assert.ok(serverSrc.includes('hydrateTargetsFromSettings'),
        'server.ts should call hydrateTargetsFromSettings on boot');
});

// ─── Stale target cleanup on restart ───────────────

test('restartMessagingRuntime clears stale targets', () => {
    assert.match(runtimeSrc, /clearTargetState\(\)/,
        'restartMessagingRuntime must call clearTargetState()');
});

// ─── Inactive channel patch does NOT restart active ─

test('inactive channel patch does not restart active runtime', () => {
    // restartMessagingRuntime should check if the ACTIVE channel was patched,
    // not just any channel
    assert.match(runtimeSrc, /activeChannelPatched/,
        'should track whether the active channel was patched');
    assert.ok(!runtimeSrc.includes('!!patch.telegram\n        || !!patch.discord'),
        'should NOT restart on any telegram/discord patch — only active channel');
});

// ─── Env override in catch path ────────────────────

test('loadSettings catch path applies env overrides', () => {
    // The catch block (no settings.json) should still apply DISCORD_TOKEN etc.
    assert.match(configSrc, /applyEnvOverrides/,
        'config should have applyEnvOverrides function');
    // Verify it's called in the loadSettings catch path
    const loadSettingsFn = configSrc.slice(
        configSrc.indexOf('export function loadSettings'),
        configSrc.indexOf('\nexport function saveSettings'),
    );
    const outerCatchIdx = loadSettingsFn.indexOf('} catch');
    const catchBlock = loadSettingsFn.slice(outerCatchIdx);
    assert.ok(catchBlock.includes('applyEnvOverrides'),
        'loadSettings catch path must call applyEnvOverrides');
});

test('applyEnvOverrides handles DISCORD_TOKEN', () => {
    assert.match(configSrc, /process\.env\.DISCORD_TOKEN/,
        'should read DISCORD_TOKEN from env');
});

test('applyEnvOverrides handles TELEGRAM_ALLOWED_CHAT_IDS', () => {
    assert.match(configSrc, /process\.env\.TELEGRAM_ALLOWED_CHAT_IDS/,
        'should read TELEGRAM_ALLOWED_CHAT_IDS from env');
});

// ─── Transactional settings + restart ───────────────

test('applyRuntimeSettingsPatch is async and awaits restart', () => {
    assert.match(runtimeSettingsSrc, /export async function applyRuntimeSettingsPatch/,
        'must be async function');
    assert.match(runtimeSettingsSrc, /await restartMessagingRuntime/,
        'must await restartMessagingRuntime');
});

test('applyRuntimeSettingsPatch rolls back on restart failure', () => {
    assert.match(runtimeSettingsSrc, /replaceSettings\(prevSnapshot\)/,
        'must rollback to prevSnapshot on failure');
    assert.match(runtimeSettingsSrc, /saveSettings\(prevSnapshot\)/,
        'must persist rollback');
});
