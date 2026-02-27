// ─── ENOENT Guard + Settled Guard Tests ──────────────
// P3: Validates that DIFF-A~D patterns exist in spawn.ts and quota-copilot.ts,
// and that error→close/exit double execution is prevented by settled flags.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
const quotaSrc = fs.readFileSync(join(__dirname, '../../lib/quota-copilot.ts'), 'utf8');

// ─── EG-001: preflight detectCli check exists before spawn ───

test('EG-001: spawnAgent calls detectCli() before any spawn', () => {
    // Verify detectCli(cli) exists in spawnAgent and comes before spawn() calls
    const spawnAgentIdx = spawnSrc.indexOf('export function spawnAgent');
    assert.ok(spawnAgentIdx > 0, 'spawnAgent should exist');

    const detectIdx = spawnSrc.indexOf('detectCli(cli)', spawnAgentIdx);
    assert.ok(detectIdx > spawnAgentIdx, 'should call detectCli(cli) within spawnAgent');

    // Verify user-facing error message exists after detectCli
    const notFoundIdx = spawnSrc.indexOf('not found in PATH', detectIdx);
    assert.ok(notFoundIdx > detectIdx, 'should have user-facing message when CLI not found');

    // Verify exit code 127
    const code127Idx = spawnSrc.indexOf('code: 127', detectIdx);
    assert.ok(code127Idx > detectIdx, 'should resolve with exit code 127 for missing CLI');

    // Verify preflight comes before the standard CLI spawn
    const stdSpawnIdx = spawnSrc.indexOf("spawn(cli, args", spawnAgentIdx);
    assert.ok(detectIdx < stdSpawnIdx, 'detectCli check must come before spawn(cli, args)');
});

// ─── EG-002: standard CLI child.on('error') listener exists ───

test('EG-002: standard CLI branch has child.on(\'error\') listener', () => {
    const stdBranchIdx = spawnSrc.indexOf('// ─── Standard CLI branch');
    assert.ok(stdBranchIdx > 0, 'Standard CLI branch comment should exist');
    const block = spawnSrc.slice(stdBranchIdx, stdBranchIdx + 800);

    assert.ok(
        block.includes("child.on('error'"),
        'should have error event listener on child process',
    );
    assert.ok(
        block.includes("ENOENT"),
        'error handler should specifically detect ENOENT',
    );
});

// ─── EG-003: ACP error listener exists ───

test('EG-003: ACP branch has acp.on(\'error\') listener', () => {
    const acpBranchIdx = spawnSrc.indexOf('// ─── Copilot ACP branch');
    assert.ok(acpBranchIdx > 0, 'ACP branch should exist');
    const block = spawnSrc.slice(acpBranchIdx, acpBranchIdx + 1800);

    assert.ok(
        block.includes("acp.on('error'"),
        'should have error event listener on ACP client',
    );
    assert.ok(
        block.includes("ACP spawn failed"),
        'ACP error handler should have descriptive message',
    );
});

// ─── EG-004: Windows shell:true for .cmd shim resolution ───

test('EG-004: standard CLI spawn uses shell:true on win32', () => {
    const stdBranchIdx = spawnSrc.indexOf('// ─── Standard CLI branch');
    const block = spawnSrc.slice(stdBranchIdx, stdBranchIdx + 500);

    assert.ok(
        block.includes("process.platform === 'win32'"),
        'should conditionally check for win32',
    );
    assert.ok(
        block.includes('shell: true'),
        'should set shell: true on Windows',
    );
});

// ─── EG-005: stdSettled guard prevents error→close double execution ───

test('EG-005: stdSettled guard exists in both error and close handlers', () => {
    // Verify stdSettled flag is declared
    assert.ok(
        spawnSrc.includes('let stdSettled = false;'),
        'stdSettled flag should be declared',
    );

    // Verify it's checked in the error handler
    const errorIdx = spawnSrc.indexOf("child.on('error'");
    assert.ok(errorIdx > 0, 'error handler should exist');
    const errorBlock = spawnSrc.slice(errorIdx, errorIdx + 300);
    assert.ok(
        errorBlock.includes('if (stdSettled) return;'),
        'error handler should check stdSettled',
    );
    assert.ok(
        errorBlock.includes('stdSettled = true;'),
        'error handler should set stdSettled = true',
    );

    // Verify it's checked in the close handler
    const closeIdx = spawnSrc.indexOf("child.on('close'");
    assert.ok(closeIdx > 0, 'close handler should exist');
    const closeBlock = spawnSrc.slice(closeIdx, closeIdx + 200);
    assert.ok(
        closeBlock.includes('if (stdSettled) return;'),
        'close handler should check stdSettled',
    );
});

// ─── EG-006: acpSettled guard prevents error→exit double execution ───

test('EG-006: acpSettled guard exists in both error and exit handlers', () => {
    // Verify acpSettled flag is declared
    assert.ok(
        spawnSrc.includes('let acpSettled = false;'),
        'acpSettled flag should be declared',
    );

    // Verify it's checked in the ACP error handler
    const acpErrorIdx = spawnSrc.indexOf("acp.on('error'");
    assert.ok(acpErrorIdx > 0, 'ACP error handler should exist');
    const acpErrorBlock = spawnSrc.slice(acpErrorIdx, acpErrorIdx + 300);
    assert.ok(
        acpErrorBlock.includes('if (acpSettled) return;'),
        'ACP error handler should check acpSettled',
    );
    assert.ok(
        acpErrorBlock.includes('acpSettled = true;'),
        'ACP error handler should set acpSettled = true',
    );

    // Verify it's checked in the ACP exit handler
    const acpExitIdx = spawnSrc.indexOf("acp.on('exit'");
    assert.ok(acpExitIdx > 0, 'ACP exit handler should exist');
    const acpExitBlock = spawnSrc.slice(acpExitIdx, acpExitIdx + 200);
    assert.ok(
        acpExitBlock.includes('if (acpSettled) return;'),
        'ACP exit handler should check acpSettled',
    );
});

// ─── EG-007: settled flags are set before resolve/broadcast ───

test('EG-007: settled flag is set before resolve() in error handlers', () => {
    // Standard CLI error handler: stdSettled = true must come before resolve
    const errorIdx = spawnSrc.indexOf("child.on('error'");
    const errorBlock = spawnSrc.slice(errorIdx, errorIdx + 700);
    const settledIdx = errorBlock.indexOf('stdSettled = true;');
    const resolveIdx = errorBlock.indexOf('resolve!(');
    assert.ok(settledIdx > 0, 'stdSettled assignment should exist in error handler');
    assert.ok(resolveIdx > 0, 'resolve should exist in error handler');
    assert.ok(settledIdx < resolveIdx, 'stdSettled = true must come before resolve');

    // ACP error handler: acpSettled = true must come before resolve
    const acpErrorIdx = spawnSrc.indexOf("acp.on('error'");
    const acpErrorBlock = spawnSrc.slice(acpErrorIdx, acpErrorIdx + 600);
    const acpSettledIdx = acpErrorBlock.indexOf('acpSettled = true;');
    const acpResolveIdx = acpErrorBlock.indexOf('resolve!(');
    assert.ok(acpSettledIdx > 0, 'acpSettled assignment should exist in ACP error handler');
    assert.ok(acpResolveIdx > 0, 'resolve should exist in ACP error handler');
    assert.ok(acpSettledIdx < acpResolveIdx, 'acpSettled = true must come before resolve');
});

// ─── EG-008: quota-copilot.ts uses env-first token lookup ───

test('EG-008: quota-copilot checks env vars before keychain', () => {
    const envIdx = quotaSrc.indexOf('COPILOT_GITHUB_TOKEN');
    const keychainIdx = quotaSrc.indexOf("'find-generic-password'");

    assert.ok(envIdx > 0, 'should check COPILOT_GITHUB_TOKEN env var');
    assert.ok(keychainIdx > envIdx, 'keychain lookup should come AFTER env check');

    // Verify all 3 env vars
    assert.ok(quotaSrc.includes('GH_TOKEN'), 'should check GH_TOKEN');
    assert.ok(quotaSrc.includes('GITHUB_TOKEN'), 'should check GITHUB_TOKEN');
});

// ─── EG-009: quota-copilot keychain restricted to darwin ───

test('EG-009: quota-copilot keychain lookup is darwin-only', () => {
    const darwinIdx = quotaSrc.indexOf("process.platform === 'darwin'");
    const keychainIdx = quotaSrc.indexOf("'find-generic-password'");

    assert.ok(darwinIdx > 0, 'should have darwin platform check');
    assert.ok(keychainIdx > darwinIdx, 'keychain lookup must be inside darwin guard');
});

// ─── EG-010: preflight resolves with child: null ───

test('EG-010: preflight failure returns child: null', () => {
    const preflightIdx = spawnSrc.indexOf('not found in PATH');
    assert.ok(preflightIdx > 0, 'preflight block should exist');
    const pfBlock = spawnSrc.slice(preflightIdx, preflightIdx + 300);
    assert.ok(
        pfBlock.includes('child: null'),
        'preflight should return { child: null } to avoid caller crashes',
    );
});

// ─── EG-011: quota-copilot uses file cache path ───

test('EG-011: quota-copilot uses ~/.cli-jaw/auth/copilot-token cache path', () => {
    assert.ok(quotaSrc.includes('copilot-token'), 'should reference copilot-token filename');
    assert.ok(quotaSrc.includes('auth'), 'should reference auth directory');
    assert.ok(quotaSrc.includes('0o600') || quotaSrc.includes('0600'), 'should set restrictive file permissions');
});

// ─── EG-012: quota-copilot has gh auth token fallback ───

test('EG-012: quota-copilot has gh auth token fallback', () => {
    const ghIdx = quotaSrc.indexOf("'gh'");
    const authIdx = quotaSrc.indexOf("'auth'", ghIdx);
    const tokenIdx = quotaSrc.indexOf("'token'", authIdx);

    assert.ok(ghIdx > 0, 'should reference gh CLI');
    assert.ok(authIdx > ghIdx, 'should have auth argument after gh');
    assert.ok(tokenIdx > authIdx, 'should have token argument after auth');

    // gh auth token should come after file cache but before keychain
    const cacheIdx = quotaSrc.indexOf('readTokenCache');
    const keychainIdx = quotaSrc.indexOf('find-generic-password');
    assert.ok(ghIdx > cacheIdx, 'gh auth token should come after file cache');
    assert.ok(ghIdx < keychainIdx, 'gh auth token should come before keychain');
});

// ─── EG-013: quota-copilot uses execFileSync (no shell injection) ───

test('EG-013: quota-copilot uses execFileSync instead of execSync', () => {
    assert.ok(quotaSrc.includes('execFileSync'), 'should use execFileSync');

    // Verify import is execFileSync, not execSync
    const importLine = quotaSrc.split('\n').find(l => l.includes('child_process'));
    assert.ok(importLine, 'should import from child_process');
    assert.ok(importLine!.includes('execFileSync'), 'import should include execFileSync');

    // execFileSync should be used with array args, not execSync with string
    assert.ok(
        !quotaSrc.includes('execSync('),
        'should not use execSync (shell injection risk)',
    );
});

// ─── EG-014: quota-copilot has cache account binding ───

test('EG-014: quota-copilot cache includes account binding', () => {
    // Should read last_logged_in_user from copilot config
    assert.ok(quotaSrc.includes('last_logged_in_user'), 'should read last_logged_in_user');

    // Should compare cached login with expected login
    assert.ok(quotaSrc.includes('cachedLogin'), 'should track cached login');
    assert.ok(
        quotaSrc.includes('mismatch') || quotaSrc.includes('invalidat'),
        'should invalidate on login mismatch',
    );
});

// ─── EG-015: clearCopilotTokenCache resets keychainFailed flag ───

test('EG-015: clearCopilotTokenCache resets _keychainFailed flag', () => {
    const clearFn = quotaSrc.slice(quotaSrc.indexOf('clearCopilotTokenCache'));
    assert.ok(clearFn.includes('_keychainFailed = false'), 'should reset _keychainFailed flag');
    assert.ok(clearFn.includes('_cachedToken = null'), 'should clear in-memory token');
    assert.ok(clearFn.includes('unlink'), 'should delete cache file');
});

