// CLI Switch Session Refresh — Issue #126
// Mostly source-pattern assertions following existing test style (phase31-runtime, employee-session-reuse).
// One real-DB behavioral test exercises setPendingBootstrapPromptStrict end-to-end.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const COMPACT = path.join(ROOT, 'src/core/compact.ts');
const RUNTIME = path.join(ROOT, 'src/core/runtime-settings.ts');
const MAIN_SESSION = path.join(ROOT, 'src/core/main-session.ts');

const compactSrc = fs.readFileSync(COMPACT, 'utf8');
const runtimeSrc = fs.readFileSync(RUNTIME, 'utf8');
const mainSessionSrc = fs.readFileSync(MAIN_SESSION, 'utf8');

test('CSR-001: cliSwitchRefresh returns refreshed:false when slots are all empty', () => {
    // Source: hasAnyContent guard short-circuits with refreshed:false
    assert.match(compactSrc, /const\s+hasAnyContent\s*=\s*Boolean\([\s\S]*?slots\.recent_turns[\s\S]*?slots\.memory_hits[\s\S]*?slots\.grep_hits[\s\S]*?slots\.task_snapshot[\s\S]*?\)/);
    assert.match(compactSrc, /if\s*\(\s*!hasAnyContent\s*\)\s*return\s*\{\s*refreshed:\s*false\s*\}/);
});

test('CSR-002: marker row is tagged with toCli + toModel and written to targetWorkDir', () => {
    assert.match(compactSrc, /insertMessageWithTrace\.run\(\s*'assistant',\s*COMPACT_MARKER_CONTENT,\s*opts\.toCli,\s*opts\.toModel,\s*trace,\s*null,\s*opts\.targetWorkDir/);
});

test('CSR-003: target bucket clear is inside transaction', () => {
    // resolveSessionBucket is called with both toCli AND toModel (codex-spark disambiguation)
    assert.match(compactSrc, /resolveSessionBucket\(opts\.toCli,\s*opts\.toModel\)/);
    // Inside tx: if (targetBucket) clearSessionBucket.run(targetBucket)
    assert.match(compactSrc, /db\.transaction\(\(\)\s*=>\s*\{[\s\S]*?if\s*\(\s*targetBucket\s*\)\s*clearSessionBucket\.run\(targetBucket\)[\s\S]*?\}\)/);
});

test('CSR-004: cli_switch_refresh notice broadcast includes both fromCli and toCli', () => {
    assert.match(compactSrc, /broadcast\(\s*'system_notice',\s*\{\s*code:\s*'cli_switch_refresh'/);
    assert.match(compactSrc, /CLI switched\s*\$\{opts\.fromCli\}\s*→\s*\$\{opts\.toCli\}/);
});

test('CSR-005: applyRuntimeSettingsPatch invokes cliSwitchRefresh on cli change', () => {
    assert.match(runtimeSrc, /const\s+cliChanged\s*=\s*!!\(\s*prevCli\s*&&\s*settings\.cli\s*&&\s*prevCli\s*!==\s*settings\.cli\s*\)/);
    assert.match(runtimeSrc, /if\s*\(\s*cliChanged\s*\)\s*\{[\s\S]*?cliSwitchRefresh[\s\S]*?\}/);
    assert.match(runtimeSrc, /await\s+cliSwitchRefresh\(\{[\s\S]*?sourceWorkDir:\s*prevWorkingDir[\s\S]*?targetWorkDir:\s*settings\.workingDir[\s\S]*?fromCli:\s*prevCli[\s\S]*?toCli,[\s\S]*?toModel,[\s\S]*?\}\)/);
});

test('CSR-006: cli unchanged branch keeps original syncMainSessionToSettings(prevCli)', () => {
    assert.match(runtimeSrc, /\}\s*else\s*\{\s*syncMainSessionToSettings\(prevCli\)/);
});

test('CSR-007: codex-spark bucket targeted via toModel (not null)', () => {
    // The bucket lookup uses opts.toModel — when toCli='codex' + spark model, resolveSessionBucket returns 'codex-spark'.
    // Source already verified in CSR-003. This test re-asserts toModel is threaded through runtime-settings.
    assert.match(runtimeSrc, /const\s+toModel\s*=\s*settings\.activeOverrides\?\.\[toCli\]\?\.model[\s\S]*?settings\.perCli\?\.\[toCli\]\?\.model[\s\S]*?'default'/);
});

test('CSR-008: harvest reads from prev workingDir (sourceWorkDir), marker writes to new (targetWorkDir)', () => {
    assert.match(compactSrc, /harvestBootstrapSlots\(\s*\{\s*workingDir:\s*opts\.sourceWorkDir/);
    // already covered in CSR-002 for targetWorkDir
});

test('CSR-009: refresh failure rolls back settings + propagates throw', () => {
    assert.match(runtimeSrc, /catch\s*\(\s*e[\s\S]*?\)\s*\{[\s\S]*?replaceSettings\(prevSnapshot\);\s*saveSettings\(prevSnapshot\);[\s\S]*?throw\s+e/);
});

test('CSR-010: setPendingBootstrapPromptStrict exists and does NOT swallow errors', () => {
    // exported symbol
    assert.match(mainSessionSrc, /export\s+function\s+setPendingBootstrapPromptStrict\s*\(/);
    // body has NO try/catch (unlike its non-strict sibling)
    const strictBody = mainSessionSrc.match(/export\s+function\s+setPendingBootstrapPromptStrict\([\s\S]*?\n\}/);
    assert.ok(strictBody, 'strict variant must be present');
    assert.ok(!/try\s*\{/.test(strictBody![0]), 'strict variant must not wrap in try/catch');
});

test('CSR-011: all four DB ops are inside a single db.transaction for atomicity', () => {
    // Match the transaction body and assert all four ops appear
    const txMatch = compactSrc.match(/const\s+tx\s*=\s*db\.transaction\(\(\)\s*=>\s*\{([\s\S]*?)\}\);\s*tx\(\);/);
    assert.ok(txMatch, 'tx wrapper must exist');
    const body = txMatch![1];
    assert.match(body, /insertMessageWithTrace\.run/);
    assert.match(body, /setPendingBootstrapPromptStrict\(bootstrap\)/);
    assert.match(body, /writeMainSessionRow\(clearedRow\)/);
    assert.match(body, /clearSessionBucket\.run\(targetBucket\)/);
});

test('CSR-012: cli-changed branch does NOT call syncMainSessionToSettings', () => {
    // Capture the if(cliChanged){...} block and verify no syncMainSessionToSettings inside
    const ifBlock = runtimeSrc.match(/if\s*\(\s*cliChanged\s*\)\s*\{([\s\S]*?)\}\s*else\s*\{/);
    assert.ok(ifBlock, 'cliChanged branch must exist');
    assert.ok(
        !/syncMainSessionToSettings/.test(ifBlock![1]),
        'cli-changed branch must delegate main-session clearing to cliSwitchRefresh',
    );
});

// ─── Behavioral test: real DB round-trip for the strict setter ───
test('CSR-010b: setPendingBootstrapPromptStrict persists and clears via real DB', async () => {
    const { setPendingBootstrapPromptStrict, consumePendingBootstrapPrompt } =
        await import('../../src/core/main-session.ts');

    const sentinel = `__cli-switch-test-${Date.now()}`;
    setPendingBootstrapPromptStrict(sentinel);
    const consumed = consumePendingBootstrapPrompt();
    assert.equal(consumed, sentinel, 'strict setter must persist text retrievable via consume');

    // After consume, slot should be empty
    setPendingBootstrapPromptStrict(null);
    const afterClear = consumePendingBootstrapPrompt();
    assert.equal(afterClear, null, 'null arg must clear the slot');
});
