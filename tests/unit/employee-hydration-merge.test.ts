// ── Employee hydration merge idempotency contracts ──
// Root cause being guarded: employee tool events are internal-audience only,
// so the web UI sees them exclusively through orchestrate-snapshot hydration.
// mergeHydratedProcessSteps used a status-sensitive, ambiguity-fragile fuzzy
// fallback — every focus/click re-hydration duplicated identity-less rows
// (running→done pairs, same-label Bash rows) and compounded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiSrc = readFileSync(join(__dirname, '../../public/js/ui.ts'), 'utf8');
const mergeBlock = uiSrc.slice(
    uiSrc.indexOf('function hasDurableStepIdentity('),
    uiSrc.indexOf('export function applyQueuedOverlay('),
);

test('EHM-001: durable identity = stepRef or traceRunId + positive traceSeq', () => {
    assert.ok(mergeBlock.includes('function hasDurableStepIdentity('), 'identity helper should exist');
    assert.ok(mergeBlock.includes('if (step.stepRef) return true'), 'stepRef alone is durable identity');
    assert.ok(mergeBlock.includes('step.traceSeq > 0'), 'trace identity requires a positive traceSeq');
});

test('EHM-002: identity-less steps match by append-order ordinal before fuzzy', () => {
    const identityIdx = mergeBlock.indexOf('sameProcessStepIdentity(existing, step)');
    const ordinalIdx = mergeBlock.indexOf('ordinalSteps[ordinal]');
    const fuzzyIdx = mergeBlock.indexOf('matches.length === 1');
    assert.ok(identityIdx >= 0 && ordinalIdx >= 0 && fuzzyIdx >= 0, 'all three match tiers should exist');
    assert.ok(identityIdx < ordinalIdx && ordinalIdx < fuzzyIdx,
        'match order must be identity → ordinal → fuzzy');
    assert.ok(mergeBlock.includes('!hasDurableStepIdentity(step)'),
        'ordinal tier applies only to identity-less incoming steps');
});

test('EHM-003: fuzzy fallback is status-agnostic (running→done upgrades in place)', () => {
    const fuzzyStart = mergeBlock.indexOf('const matches = pb.steps.filter');
    const fuzzyEnd = mergeBlock.indexOf('matches.length === 1');
    const fuzzy = mergeBlock.slice(fuzzyStart, fuzzyEnd);
    assert.ok(!fuzzy.includes('existing.status === step.status'),
        'status must not be part of the fuzzy key — transitions between hydrations duplicated rows (doc 01 F2)');
    assert.ok(fuzzy.includes('existing.label === step.label') && fuzzy.includes('existing.type === step.type'),
        'label/type/isEmployee remain the fuzzy key');
});

test('EHM-004: ordinal alignment is preserved when an identity-less step is newly added', () => {
    assert.ok(mergeBlock.includes('ordinalSteps.push(added)'),
        'a newly added identity-less step must join the ordinal list at its position');
});

test('EHM-005: hydration no-op skip guards the merge from identical snapshots (P1-c coupling)', () => {
    assert.ok(uiSrc.includes('signature === lastHydrationSignature && currentAgentDivForActiveRun()) return'),
        'identical snapshots must not reach the merge at all');
});
