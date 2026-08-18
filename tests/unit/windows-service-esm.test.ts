/**
 * #379 regression: src/manager/windows-service.ts compiles to true ESM
 * ("type": "module" + NodeNext), where require/require.resolve are undefined.
 * The original defect had five require() call sites; three were swallowed by
 * try/catch (silent log-rotation/schtasks degradation) and the registration
 * path hard-threw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as winService from '../../src/manager/windows-service.ts';

test('WSE-001: module loads as ESM and exposes the lifecycle surface', () => {
    assert.equal(typeof winService.permWindowsInstance, 'function');
    assert.equal(typeof winService.stopWindowsInstance, 'function');
    assert.equal(typeof winService.windowsServiceName, 'function');
});

test('WSE-002: unperm path (receipt read + cleanup) completes without ReferenceError', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-wse-'));
    try {
        const result = await winService.unpermWindowsInstance(3457, home);
        assert.equal(result.ok, true);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('WSE-003: no bare require() remains in the module source', () => {
    // The behavioral tests cannot reach every branch (permWindowsInstance
    // writes into the real Startup folder), so pin the remaining ESM hazard.
    // This names the defect class, not the fix shape: createRequire would be
    // an acceptable future escape hatch and does not match this pattern.
    const src = readFileSync(new URL('../../src/manager/windows-service.ts', import.meta.url), 'utf8');
    const bare = src.match(/(?<!create)(?<![\w.])require(\.resolve)?\s*\(/g) ?? [];
    assert.deepEqual(bare, [], 'bare require() in an ESM module regresses #379');
});
