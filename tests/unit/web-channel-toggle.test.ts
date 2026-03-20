// Web channel toggle tests — Phase 7 Bundle D
// Ensures PUT /api/settings channel switch is async and uses transactional settings
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const serverSrc = readFileSync(join(projectRoot, 'server.ts'), 'utf8');
const runtimeSettingsSrc = readFileSync(join(projectRoot, 'src/core/runtime-settings.ts'), 'utf8');

// ─── PUT /api/settings is async ─────────────────────

test('PUT /api/settings handler is async', () => {
    assert.match(serverSrc, /app\.put\('\/api\/settings',\s*async/,
        'PUT /api/settings should be async to await restart');
});

// ─── applySettingsPatch uses transactional runtime patch ─

test('applySettingsPatch calls applyRuntimeSettingsPatch', () => {
    assert.match(serverSrc, /applyRuntimeSettingsPatch/,
        'applySettingsPatch should use transactional runtime patch');
});

// ─── Failed save does not leave optimistic state ─────

test('applyRuntimeSettingsPatch rolls back on failure', () => {
    assert.match(runtimeSettingsSrc, /replaceSettings\(prevSnapshot\)/,
        'should rollback to prevSnapshot on restart failure');
    assert.match(runtimeSettingsSrc, /saveSettings\(prevSnapshot\)/,
        'should persist rollback to disk');
});

test('applyRuntimeSettingsPatch propagates error to caller', () => {
    assert.match(runtimeSettingsSrc, /throw e/,
        'should throw error so HTTP handler can report failure');
});

// ─── Web command context uses applySettingsPatch ─────

test('web command context routes through applySettingsPatch', () => {
    assert.match(serverSrc, /applySettings.*applySettingsPatch/,
        'web command context should use applySettingsPatch');
});
