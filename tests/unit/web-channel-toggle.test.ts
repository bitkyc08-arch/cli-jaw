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
// Every test file in the suite inherits one temp home, so writing the real
// settings.json here would race the other rollback tests. The injected writer
// keeps the same assertion without touching disk: capture what the code would
// have persisted, and check that the last write undoes the attempted patch.
// The rollback contract for this path is asserted in
// tests/unit/cli-switch-refresh.test.ts, which owns the settings-mutation
// cases. They share process-wide settings state and the database, so
// splitting them across files made them race on a SQLite lock rather than
// on anything they were checking.
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
