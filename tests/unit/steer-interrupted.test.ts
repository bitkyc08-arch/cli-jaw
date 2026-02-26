import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');

// ─── SI-001: killReason variable exists and killActiveAgent sets it ───

test('SI-001: killActiveAgent sets killReason to the given reason', () => {
    // killReason is internal (not exported), verify via source structure
    assert.ok(
        spawnSrc.includes('let killReason: string | null = null;'),
        'killReason should be declared as let with null default',
    );
    // killActiveAgent(reason) sets killReason = reason
    assert.ok(
        spawnSrc.includes('killReason = reason;'),
        'killActiveAgent should assign reason to killReason',
    );
});

test('SI-002: killActiveAgent defaults reason to "user"', () => {
    assert.ok(
        /export function killActiveAgent\(reason\s*=\s*['"]user['"]\)/.test(spawnSrc),
        'killActiveAgent default reason should be "user"',
    );
});

// ─── SI-003: ACP exit handler tags content with ⏹️ [interrupted] ───

test('SI-003: ACP exit handler adds interrupted prefix to fullText when wasSteer', () => {
    // Find the ACP exit handler (acp.on('exit', ...))
    const acpExitIdx = spawnSrc.indexOf("acp.on('exit'");
    assert.ok(acpExitIdx > 0, 'ACP exit handler should exist');

    const acpExitBlock = spawnSrc.slice(acpExitIdx, acpExitIdx + 2000);

    // wasSteer check
    assert.ok(
        acpExitBlock.includes("const wasSteer = killReason === 'steer';"),
        'ACP exit should check killReason === steer',
    );
    // interrupted prefix on content
    assert.ok(
        acpExitBlock.includes('⏹️ [interrupted]'),
        'ACP exit should tag content with ⏹️ [interrupted]',
    );
    // guard: wasSteer && mainManaged && !opts.internal
    assert.ok(
        acpExitBlock.includes('wasSteer && mainManaged && !opts.internal'),
        'interrupted tagging should be guarded by wasSteer && mainManaged && !opts.internal',
    );
});

// ─── SI-004: ACP exit handler also tags trace ───

test('SI-004: ACP exit handler adds interrupted prefix to traceText when wasSteer', () => {
    const acpExitIdx = spawnSrc.indexOf("acp.on('exit'");
    const acpExitBlock = spawnSrc.slice(acpExitIdx, acpExitIdx + 2200);

    // trace tagging
    assert.ok(
        acpExitBlock.includes("if (traceText) traceText = `⏹️ [interrupted]"),
        'ACP exit should tag traceText with interrupted prefix',
    );
});

// ─── SI-005: ACP exit handler suppresses fallback when wasSteer ───

test('SI-005: ACP exit handler suppresses fallback on steer kill', () => {
    const acpExitIdx = spawnSrc.indexOf("acp.on('exit'");
    const acpExitBlock = spawnSrc.slice(acpExitIdx, acpExitIdx + 3500);

    // The else-if for error/fallback should check !wasSteer
    assert.ok(
        acpExitBlock.includes('code !== 0 && !wasSteer'),
        'ACP exit fallback branch should be guarded by code !== 0 && !wasSteer',
    );
});

// ─── SI-006: Standard CLI close handler has same interrupted logic ───

test('SI-006: Standard CLI close handler tags interrupted output', () => {
    // Standard CLI branch: child.on('close', ...)
    const cliCloseIdx = spawnSrc.indexOf("child.on('close'");
    assert.ok(cliCloseIdx > 0, 'Standard CLI close handler should exist');

    const cliCloseBlock = spawnSrc.slice(cliCloseIdx, cliCloseIdx + 3500);

    // wasSteer check
    assert.ok(
        cliCloseBlock.includes("const wasSteer = killReason === 'steer';"),
        'CLI close should check killReason === steer',
    );
    // interrupted prefix on content
    assert.ok(
        cliCloseBlock.includes('⏹️ [interrupted]'),
        'CLI close should tag content with ⏹️ [interrupted]',
    );
    // trace tagging
    assert.ok(
        cliCloseBlock.includes("if (traceText) traceText = `⏹️ [interrupted]"),
        'CLI close should tag traceText with interrupted prefix',
    );
    // fallback suppression
    assert.ok(
        cliCloseBlock.includes('code !== 0 && !wasSteer'),
        'CLI close fallback branch should be guarded by code !== 0 && !wasSteer',
    );
});

// ─── SI-007: killReason is consumed (reset to null) after exit ───

test('SI-007: killReason is consumed (set to null) after mainManaged exit', () => {
    // Both ACP and CLI exit handlers should have: if (mainManaged) killReason = null;
    const consumePattern = 'if (mainManaged) killReason = null;';
    const firstIdx = spawnSrc.indexOf(consumePattern);
    assert.ok(firstIdx > 0, 'killReason consumption should exist');

    const secondIdx = spawnSrc.indexOf(consumePattern, firstIdx + 1);
    assert.ok(secondIdx > firstIdx, 'killReason should be consumed in both ACP and CLI exit handlers');
});

// ─── Structural: both exit paths are symmetric ───

test('SI-STRUCT: ACP and CLI exit handlers have symmetric steer logic', () => {
    const acpExitIdx = spawnSrc.indexOf("acp.on('exit'");
    const cliCloseIdx = spawnSrc.indexOf("child.on('close'");

    assert.ok(acpExitIdx > 0, 'ACP exit should exist');
    assert.ok(cliCloseIdx > 0, 'CLI close should exist');
    assert.ok(acpExitIdx < cliCloseIdx, 'ACP exit should come before CLI close in source');

    // Both should have the same key lines
    const acpBlock = spawnSrc.slice(acpExitIdx, acpExitIdx + 2000);
    const cliBlock = spawnSrc.slice(cliCloseIdx, cliCloseIdx + 2500);

    for (const pattern of [
        "killReason === 'steer'",
        'killReason = null',
        '⏹️ [interrupted]',
        'wasSteer && mainManaged && !opts.internal',
    ]) {
        assert.ok(acpBlock.includes(pattern), `ACP exit should contain: ${pattern}`);
        assert.ok(cliBlock.includes(pattern), `CLI close should contain: ${pattern}`);
    }
});

// ─── steerAgent exports and flow ───

test('steerAgent calls killActiveAgent with "steer" reason', () => {
    // Verify steerAgent function calls killActiveAgent('steer')
    const steerFnMatch = spawnSrc.match(/export async function steerAgent[\s\S]*?^}/m);
    assert.ok(steerFnMatch, 'steerAgent function should exist');
    const steerBody = steerFnMatch[0];
    assert.ok(
        steerBody.includes("killActiveAgent('steer')"),
        'steerAgent should call killActiveAgent with "steer" reason',
    );
    assert.ok(
        steerBody.includes('waitForProcessEnd'),
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
    // This is critical: if trace has ⏹️ [interrupted], history block will show it
    assert.ok(
        spawnSrc.includes("role === 'assistant' && row.trace"),
        'buildHistoryBlock should check for trace on assistant messages',
    );
});
