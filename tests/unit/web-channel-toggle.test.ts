// Web channel toggle tests — Phase 7 Bundle D
// Ensures PUT /api/settings channel switch is async and uses transactional settings
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const settingsRouteSrc = readFileSync(join(projectRoot, 'src/routes/settings.ts'), 'utf8');
const serverSrc = readFileSync(join(projectRoot, 'server.ts'), 'utf8');
// applySettingsPatch lives in core/session-ops.ts since the Phase 2 extraction (devlog 260609, 20).
const sessionOpsSrc = readFileSync(join(projectRoot, 'src/core/session-ops.ts'), 'utf8');
const runtimeSettingsSrc = readFileSync(join(projectRoot, 'src/core/runtime-settings.ts'), 'utf8');

// ─── PUT /api/settings is async ─────────────────────

test('PUT /api/settings handler is async', () => {
    assert.match(settingsRouteSrc, /app\.put\('\/api\/settings',\s*requireAuth,\s*async/,
        'PUT /api/settings should be async to await restart');
});

// ─── applySettingsPatch uses transactional runtime patch ─

test('applySettingsPatch calls applyRuntimeSettingsPatch', () => {
    assert.match(sessionOpsSrc, /applyRuntimeSettingsPatch/,
        'applySettingsPatch should use transactional runtime patch');
});

// ─── Failed save does not leave optimistic state ─────

// This used to grep for replaceSettings(prevSnapshot) and saveSettings(prevSnapshot),
// neither of which exists now that persistence writes a candidate before it
// commits. The behaviour being protected has not changed, so assert that
// instead: a post-write failure must leave neither memory nor disk carrying the
// attempted patch.
test('applyRuntimeSettingsPatch rolls back on failure', async (t) => {
    const config = await import('../../src/core/config.ts');
    const runtime = await import('../../src/core/runtime-settings.ts');
    const original = config.snapshotSettingsState();
    t.after(() => config.commitCandidate(original));

    const baseline = structuredClone(config.settings);
    baseline.cli = 'claude';
    config.persistAndCommit({ value: baseline, shape: 'absent' });
    const expectedRaw = readFileSync(config.SETTINGS_PATH, 'utf8');

    await assert.rejects(runtime.applyRuntimeSettingsPatch({ cli: 'codex-app' }, {
        cliSwitchRefresh: async () => { throw new Error('rollback probe'); },
    }), /rollback probe/);
    assert.equal(config.settings["cli"], 'claude', 'the failed patch must not survive in memory');
    assert.equal(readFileSync(config.SETTINGS_PATH, 'utf8'), expectedRaw, 'the file must be byte-identical');
});

test('applyRuntimeSettingsPatch propagates error to caller', () => {
    assert.match(runtimeSettingsSrc, /throw e/,
        'should throw error so HTTP handler can report failure');
});

// ─── Web command context uses applySettingsPatch ─────

test('web command context routes through applySettingsPatch', () => {
    // server.ts passes applySettingsPatch to registerSettingsRoutes
    assert.match(serverSrc, /registerSettingsRoutes.*applySettingsPatch/,
        'web command context should use applySettingsPatch');
});
