import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');

// ─── SI-001: killReasons Map and consumeKillReason exist ───

test('SI-001: killActiveAgent sets killReason to the given reason', () => {
    assert.ok(
        spawnSrc.includes('const killReasons = new Map'),
        'killReasons Map should be declared',
    );
    assert.ok(
        spawnSrc.includes('killReasons.set('),
        'killActiveAgent should set reason in killReasons Map',
    );
});

test('SI-002: killActiveAgent defaults reason to "user"', () => {
    assert.ok(
        /export function killActiveAgent\(scopeKeyOrReason\s*=\s*['"]user['"],\s*scopedReason\?:\s*string\)/.test(spawnSrc)
            && spawnSrc.includes('const reason = scopedReason ?? scopeKeyOrReason'),
        'killActiveAgent default reason should be "user"',
    );
});

// ─── SI-003: ACP exit handler tags content with ⏹️ [interrupted] ───

test('SI-003: ACP exit handler adds interrupted prefix to fullText when wasSteer', () => {
    const acpExitIdx = spawnSrc.indexOf("acp.on('exit'");
    assert.ok(acpExitIdx > 0, 'ACP exit handler should exist');

    const acpExitBlock = spawnSrc.slice(acpExitIdx, acpExitIdx + 7000);

    assert.ok(
        acpExitBlock.includes("acpKillReason === 'steer'"),
        'ACP exit should check acpKillReason === steer',
    );
    assert.ok(
        acpExitBlock.includes('⏹️ [interrupted]'),
        'ACP exit should tag content with ⏹️ [interrupted]',
    );
});

// ─── SI-004: ACP exit handler also tags trace ───

test('SI-004: ACP exit handler adds interrupted prefix to traceText when wasSteer', () => {
    const acpExitIdx = spawnSrc.indexOf("acp.on('exit'");
    const acpExitBlock = spawnSrc.slice(acpExitIdx, acpExitIdx + 7000);

    assert.ok(
        acpExitBlock.includes("traceText = `⏹️ [interrupted]"),
        'ACP exit should tag traceText with interrupted prefix',
    );
});

// ─── SI-005: ACP exit handler suppresses fallback when wasSteer ───

test('SI-005: ACP exit handler suppresses fallback on steer kill', () => {
    const acpExitIdx = spawnSrc.indexOf("acp.on('exit'");
    const acpExitBlock = spawnSrc.slice(acpExitIdx, acpExitIdx + 7000);

    assert.ok(
        acpExitBlock.includes('wasSteer'),
        'ACP exit fallback should reference wasSteer',
    );
});

// ─── SI-006: Standard CLI close handler has same interrupted logic ───

test('SI-006: Standard CLI close handler tags interrupted output', () => {
    const cliCloseIdx = spawnSrc.indexOf("child.on('close'");
    assert.ok(cliCloseIdx > 0, 'Standard CLI close handler should exist');

    // Window must span the whole close handler; the agy close-path finalization
    // (finalizeAgyFallbackText) sits before the steer tagging and grew the handler.
    const cliCloseBlock = spawnSrc.slice(cliCloseIdx, cliCloseIdx + 14000);

    assert.ok(
        cliCloseBlock.includes("stdKillReason === 'steer'") || cliCloseBlock.includes('wasSteer'),
        'CLI close should check killReason for steer',
    );
    assert.ok(
        cliCloseBlock.includes('⏹️ [interrupted]'),
        'CLI close should tag content with ⏹️ [interrupted]',
    );
    assert.ok(
        cliCloseBlock.includes('!wasKilled'),
        'CLI close fallback should be guarded by !wasKilled',
    );
});

// ─── SI-007: killReason is consumed after exit ───

test('SI-007: killReason is consumed (set to null) after mainManaged exit', () => {
    assert.ok(
        spawnSrc.includes('consumeKillReason('),
        'consumeKillReason should be called in exit handlers',
    );
    // Both ACP and CLI paths should consume
    const acpConsume = spawnSrc.includes('acpKillReason = consumeKillReason') || spawnSrc.includes('consumeKillReason(acp');
    const stdConsume = spawnSrc.includes('stdKillReason = consumeKillReason') || spawnSrc.includes('consumeKillReason(child');
    assert.ok(acpConsume, 'ACP exit should consume kill reason');
    assert.ok(stdConsume, 'CLI exit should consume kill reason');
});

// ─── Structural: both exit paths are symmetric ───

test('SI-STRUCT: ACP and CLI exit handlers have symmetric steer logic', () => {
    const acpExitIdx = spawnSrc.indexOf("acp.on('exit'");
    const cliCloseIdx = spawnSrc.indexOf("child.on('close'");

    assert.ok(acpExitIdx > 0, 'ACP exit should exist');
    assert.ok(cliCloseIdx > 0, 'CLI close should exist');
    assert.ok(acpExitIdx < cliCloseIdx, 'ACP exit should come before CLI close in source');

    const acpBlock = spawnSrc.slice(acpExitIdx, acpExitIdx + 7000);
    const cliBlock = spawnSrc.slice(cliCloseIdx, cliCloseIdx + 14000);

    for (const pattern of [
        'wasSteer',
        '⏹️ [interrupted]',
        'wasSteer && mainManaged && !opts.internal',
    ]) {
        assert.ok(acpBlock.includes(pattern), `ACP exit should contain: ${pattern}`);
        assert.ok(cliBlock.includes(pattern), `CLI close should contain: ${pattern}`);
    }
});

// ─── steerAgent exports and flow ───

test('steerAgent calls killActiveAgent with "steer" reason', () => {
    const steerFnMatch = spawnSrc.match(/export async function steerAgent[\s\S]*?^}/m);
    assert.ok(steerFnMatch, 'steerAgent function should exist');
    const steerBody = steerFnMatch[0];
    assert.ok(
        steerBody.includes("killActiveAgent(scopeKey, 'steer')"),
        'steerAgent should call killActiveAgent for its scope with "steer" reason',
    );
    assert.ok(
        steerBody.includes('waitForMainProcessEnd'),
        'steerAgent should wait for process end after kill',
    );
});

test('steerAgent inserts user message and broadcasts before orchestrating', () => {
    const steerFnMatch = spawnSrc.match(/export async function steerAgent[\s\S]*?^}/m);
    assert.ok(steerFnMatch, 'steerAgent function should exist');
    const steerBody = steerFnMatch[0];

    assert.ok(
        steerBody.includes('insertMessage.run'),
        'steerAgent should insert the new prompt as user message',
    );
    assert.ok(
        steerBody.includes("broadcast('new_message'"),
        'steerAgent should broadcast new_message',
    );
});

// ─── buildHistoryBlock uses trace for assistant messages ───

test('buildHistoryBlock prefers trace over content for assistant messages', () => {
    assert.ok(
        spawnSrc.includes("role === 'assistant' && row.trace"),
        'buildHistoryBlock should check for trace on assistant messages',
    );
});
