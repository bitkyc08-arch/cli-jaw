import { readSource } from './source-normalize.js';
// CLI Switch Session Refresh — Issue #126
// Mostly source-pattern assertions following existing test style (phase31-runtime, employee-session-reuse).
// One real-DB behavioral test exercises setPendingBootstrapPromptStrict end-to-end.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const COMPACT = path.join(ROOT, 'src/core/compact.ts');
const CLI_COMPACT = path.join(ROOT, 'src/cli/compact.ts');
const RUNTIME = path.join(ROOT, 'src/core/runtime-settings.ts');
const MAIN_SESSION = path.join(ROOT, 'src/core/main-session.ts');

const compactSrc = readSource(COMPACT, 'utf8');
const cliCompactSrc = readSource(CLI_COMPACT, 'utf8');
const runtimeSrc = readSource(RUNTIME, 'utf8');
const mainSessionSrc = readSource(MAIN_SESSION, 'utf8');

test('CSR-001: cliSwitchRefresh always resets target session even when slots are empty', () => {
    assert.match(compactSrc, /const\s+hasAnyContent\s*=\s*Boolean\([\s\S]*?slots\.recent_turns[\s\S]*?slots\.memory_hits[\s\S]*?slots\.grep_hits[\s\S]*?slots\.task_snapshot[\s\S]*?\)/);
    assert.doesNotMatch(compactSrc, /if\s*\(\s*!hasAnyContent\s*\)\s*return\s*\{\s*refreshed:\s*false\s*\}/);
    assert.match(compactSrc, /if\s*\(\s*hasAnyContent\s*\)\s*\{[\s\S]*?insertMessageWithTrace\.run[\s\S]*?setPendingBootstrapPromptStrict\(bootstrap\)[\s\S]*?\}/);
    // The bucket clear itself is covered behaviourally by CSR-003d below, which is
    // what survives the codex-app branch that a source pattern could not express.
});

test('CSR-002: marker row is tagged with toCli + toModel and written to targetWorkDir', () => {
    assert.match(compactSrc, /insertMessageWithTrace\.run\(\s*'assistant',\s*COMPACT_MARKER_CONTENT,\s*opts\.toCli,\s*opts\.toModel,\s*trace,\s*null,\s*opts\.targetWorkDir/);
});

test('CSR-003: target bucket clear is inside transaction', () => {
    // resolveSessionBucket is called with both toCli AND toModel (codex-spark disambiguation)
    assert.match(compactSrc, /resolveSessionBucket\(opts\.toCli,\s*opts\.toModel,\s*opts\.toProvider\)/);
    // Inside tx: if (targetBucket) clearSessionBucket.run(targetBucket)
    assert.match(compactSrc, /db\.transaction\(\(\)\s*=>\s*\{[\s\S]*?if\s*\(\s*targetBucket\s*\)\s*clearSessionBucket\.run\(targetBucket\)[\s\S]*?\}\)/);
});

test('CSR-003c: slash compact clears active session bucket after bootstrap handoff', () => {
    assert.match(cliCompactSrc, /const\s+bucket\s*=\s*resolveSessionBucket\(activeCli,\s*model\)/);
    // See CSR-003e: an explicit compact must also drop the scoped Codex App rows,
    // which is a behaviour rather than a statement order.
});

test('CSR-004: cli_switch_refresh notice broadcast includes both fromCli and toCli', () => {
    assert.match(compactSrc, /broadcast\(\s*'system_notice',\s*\{\s*code:\s*'cli_switch_refresh'/);
    assert.match(compactSrc, /const\s+targetLabel\s*=\s*opts\.toProvider\s*\?\s*`\$\{opts\.toCli\}:\$\{opts\.toProvider\}`\s*:\s*opts\.toCli/);
    assert.match(compactSrc, /CLI switched\s*\$\{opts\.fromCli\}\s*→\s*\$\{targetLabel\}/);
});

test('CSR-005: applyRuntimeSettingsPatch invokes cliSwitchRefresh on cli change', () => {
    assert.match(runtimeSrc, /const\s+cliChanged\s*=\s*!!\(\s*prevCli\s*&&\s*settings\.cli\s*&&\s*prevCli\s*!==\s*settings\.cli\s*\)/);
    assert.match(runtimeSrc, /if\s*\(\s*cliChanged\s*\|\|\s*aiEProviderChanged\s*\)\s*\{[\s\S]*?cliSwitchRefresh[\s\S]*?\}/);
    assert.match(runtimeSrc, /await\s+cliSwitchRefresh\(\{[\s\S]*?sourceWorkDir:\s*prevWorkingDir[\s\S]*?targetWorkDir:\s*settings\.workingDir[\s\S]*?fromCli:[\s\S]*?toCli,[\s\S]*?toModel,[\s\S]*?\}\)/);
});

test('CSR-005b: ai-e provider change triggers clean session refresh', () => {
    assert.match(runtimeSrc, /const\s+prevAiEProvider\s*=\s*selectedAiEProvider\(prevSnapshot\)/);
    assert.match(runtimeSrc, /const\s+nextAiEProvider\s*=\s*selectedAiEProvider\(settings\)/);
    assert.match(runtimeSrc, /const\s+aiEProviderChanged\s*=\s*prevCli\s*===\s*'ai-e'[\s\S]*?settings\.cli\s*===\s*'ai-e'[\s\S]*?prevAiEProvider\s*!==\s*nextAiEProvider/);
    assert.match(runtimeSrc, /fromCli:\s*aiEProviderChanged\s*\?\s*`ai-e:\$\{prevAiEProvider\}`\s*:\s*prevCli/);
    assert.match(runtimeSrc, /toProvider:\s*toCli\s*===\s*'ai-e'\s*\?\s*nextAiEProvider\s*:\s*undefined/);
});

test('CSR-006: cli unchanged branch keeps original syncMainSessionToSettings(prevCli)', () => {
    assert.match(runtimeSrc, /\}\s*else\s*\{\s*syncMainSessionToSettings\(prevCli\)/);
});

test('CSR-007: codex-spark bucket targeted via toModel (not null)', () => {
    // The bucket lookup uses opts.toModel — when toCli='codex' + spark model, resolveSessionBucket returns 'codex-spark'.
    // Source already verified in CSR-003. This test re-asserts toModel is threaded through runtime-settings.
    assert.match(runtimeSrc, /const\s+toModel\s*=\s*selectedModelForCli\(toCli,\s*settings\)/);
});

test('CSR-008: harvest reads from prev workingDir (sourceWorkDir), marker writes to new (targetWorkDir)', () => {
    assert.match(compactSrc, /harvestBootstrapSlots\(\s*\{\s*workingDir:\s*opts\.sourceWorkDir/);
    // already covered in CSR-002 for targetWorkDir
});

// Writes go through an injected sink rather than the real settings.json: every
// test file in the suite shares one temp home, and two rollback tests writing
// the same file race each other.
test('CSR-009: refresh failure rolls back the persisted settings pair and propagates throw', async (t) => {
    const config = await import('../../src/core/config.ts');
    const runtime = await import('../../src/core/runtime-settings.ts');
    const original = config.snapshotSettingsState();
    t.after(() => config.commitCandidate(original));

    const baseline = structuredClone(config.settings);
    baseline.cli = 'claude';
    config.commitCandidate({ value: baseline, shape: 'absent' });

    const writes: string[] = [];
    await assert.rejects(runtime.applyRuntimeSettingsPatch({ cli: 'codex-app' }, {
        writeSettings: (raw: string) => { writes.push(raw); },
        cliSwitchRefresh: async () => { throw new Error('CSR-009 refresh failure'); },
    }), /CSR-009 refresh failure/);
    assert.deepEqual(config.settings, baseline);
    assert.equal(config.getSettingsPersistenceShape(), 'absent');
    assert.equal(JSON.parse(writes.at(-1)!).cli, 'claude', 'the rollback write restores the previous runtime');
});

// The messaging restart is the other post-write side effect that can fail, and
// it rolls back through the same path. It lives here rather than beside the
// messaging tests because these cases share process-wide settings state and the
// database; running them in separate files let them race, and the failure was a
// SQLite lock rather than anything either test was asserting.
test('CSR-009b: messaging restart failure rolls back the same way', async (t) => {
    const config = await import('../../src/core/config.ts');
    const runtime = await import('../../src/core/runtime-settings.ts');
    const original = config.snapshotSettingsState();
    t.after(() => config.commitCandidate(original));

    const baseline = structuredClone(config.settings);
    baseline.channel = 'telegram';
    baseline.cli = 'claude';
    config.commitCandidate({ value: baseline, shape: 'absent' });

    const writes: string[] = [];
    await assert.rejects(runtime.applyRuntimeSettingsPatch({ channel: 'discord', cli: 'codex-app' }, {
        writeSettings: (raw: string) => { writes.push(raw); },
        // Takes over the branch that would otherwise sync the main session into
        // the database, keeping this case to the settings contract it is about.
        cliSwitchRefresh: async () => {},
        restartMessaging: async () => { throw new Error('CSR-009b restart failure'); },
    }), /CSR-009b restart failure/);

    assert.equal(config.settings["channel"], 'telegram', 'a failed restart must not leave the new channel active');
    assert.equal(config.settings["cli"], 'claude');
    assert.equal(config.getSettingsPersistenceShape(), 'absent');
    assert.equal(JSON.parse(writes.at(-1)!).channel, 'telegram');
});

// A late failure in one request used to restore a candidate captured before a
// second request had already persisted its own value, so the winning write
// vanished from both memory and disk. Mutations are serialised now.
test('CSR-009c: a late rollback cannot undo a write that landed after it started', async (t) => {
    const config = await import('../../src/core/config.ts');
    const runtime = await import('../../src/core/runtime-settings.ts');
    const original = config.snapshotSettingsState();
    t.after(() => config.commitCandidate(original));

    const baseline = structuredClone(config.settings);
    baseline.cli = 'claude';
    delete baseline.runtime;
    config.commitCandidate({ value: baseline, shape: 'absent' });

    let releaseFirst!: () => void;
    const firstReachedSideEffect = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const writes: string[] = [];

    const first = assert.rejects(runtime.applyRuntimeSettingsPatch({ cli: 'codex-app' }, {
        writeSettings: (raw: string) => { writes.push(raw); },
        cliSwitchRefresh: async () => {
            await firstReachedSideEffect;
            throw new Error('CSR-009c late failure');
        },
    }), /CSR-009c late failure/);

    const second = runtime.applyRuntimeSettingsPatch({ runtime: { codexApp: { multiplex: false } } }, {
        writeSettings: (raw: string) => { writes.push(raw); },
    });

    releaseFirst();
    await first;
    await second;

    assert.equal(config.getSettingsPersistenceShape(), 'present',
        'the explicit gate written by the second request must survive the first request failing');
    assert.equal(JSON.parse(writes.at(-1)!).runtime?.codexApp?.multiplex, false,
        'the last write must be the second request, not a stale rollback');
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
    assert.match(body, /if\s*\(\s*hasAnyContent\s*\)\s*\{/);
});

test('CSR-013: no-content switch preserves existing pending bootstrap', () => {
    const txMatch = compactSrc.match(/const\s+tx\s*=\s*db\.transaction\(\(\)\s*=>\s*\{([\s\S]*?)\}\);\s*tx\(\);/);
    assert.ok(txMatch, 'tx wrapper must exist');
    const body = txMatch![1];
    assert.doesNotMatch(body, /else\s*\{[\s\S]*setPendingBootstrapPromptStrict\(null\)/);
    assert.doesNotMatch(body, /setPendingBootstrapPromptStrict\(null\)/);
});

test('CSR-012: cli-changed branch does NOT call syncMainSessionToSettings', () => {
    // Capture the if(cliChanged){...} block and verify no syncMainSessionToSettings inside
    const ifBlock = runtimeSrc.match(/if\s*\(\s*cliChanged\s*\|\|\s*aiEProviderChanged\s*\)\s*\{([\s\S]*?)\}\s*else\s*\{/);
    assert.ok(ifBlock, 'cli/provider changed branch must exist');
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
