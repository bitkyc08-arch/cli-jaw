// Settings failure surface tests — Phase 9
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const serverSrc = readFileSync(join(projectRoot, 'server.ts'), 'utf8');
const runtimeSettingsSrc = readFileSync(join(projectRoot, 'src/core/runtime-settings.ts'), 'utf8');

// ─── PUT /api/settings uses asyncHandler ─────────────

test('PUT /api/settings uses asyncHandler for error surface', () => {
    assert.ok(serverSrc.includes("app.put('/api/settings', asyncHandler("),
        'PUT /api/settings must use asyncHandler wrapper');
});

test('server imports and wires asyncHandler', () => {
    assert.ok(serverSrc.includes("import { asyncHandler }"),
        'server must import asyncHandler');
});

test('server wires errorHandler middleware', () => {
    assert.ok(serverSrc.includes('app.use(errorHandler'),
        'server must wire errorHandler as last middleware');
    assert.ok(serverSrc.includes("import { errorHandler }"),
        'server must import errorHandler');
});

// ─── applyRuntimeSettingsPatch throws on restart failure ─

test('applyRuntimeSettingsPatch re-throws after rollback', () => {
    assert.match(runtimeSettingsSrc, /throw e/,
        'must re-throw to surface error to caller');
});

// ─── rollback attempts re-init ──────────────────────

test('rollback attempts to re-init previous runtime', () => {
    assert.ok(runtimeSettingsSrc.includes('await initActiveMessagingRuntime()'),
        'rollback should attempt to re-init the previous runtime');
});

// ─── error is logged before re-throw ─────────────────

test('restart failure is logged before re-throw', () => {
    assert.match(runtimeSettingsSrc, /console\.error.*restart failed/,
        'should log the restart failure');
});
