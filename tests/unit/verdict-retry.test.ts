// PABCD 검증: state machine + worker dispatch + orchestrate structure
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pipelineSrc = fs.readFileSync(join(__dirname, '../../src/orchestrator/pipeline.ts'), 'utf8');
const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
const stateMachineSrc = fs.readFileSync(join(__dirname, '../../src/orchestrator/state-machine.ts'), 'utf8');

// ─── VR: PABCD State Machine 구조 검증 ───────────────

test('VR-001: pipeline imports getState from state-machine', () => {
    assert.match(
        pipelineSrc,
        /import\s*\{[\s\S]*\bgetState\b[\s\S]*\}\s*from '\.\/state-machine\.js';/,
        'pipeline must import getState from state-machine',
    );
});

test('VR-002: pipeline defines PABCD dispatch states', () => {
    assert.ok(
        pipelineSrc.includes("ACTIVE_PABCD_DISPATCH_STATES = new Set<OrcStateName>(['P', 'A', 'B', 'C'])"),
        'pipeline should define active PABCD states P/A/B/C',
    );
});

test('VR-003: pipeline drains pending worker results via recursive orchestrate', () => {
    assert.ok(pipelineSrc.includes('listPendingWorkerResults'), 'pipeline should drain pending worker results');
    assert.ok(pipelineSrc.includes('_skipReplayDrain'), 'recursive calls should skip re-draining');
});

test('VR-004: pipeline handles worker failure gracefully', () => {
    assert.ok(pipelineSrc.includes('failWorker(emp.id'), 'should call failWorker on error');
    assert.ok(pipelineSrc.includes('failed:'), 'should log worker failure');
});

test('VR-005: state machine has PABCD transition guards', () => {
    assert.ok(stateMachineSrc.includes('VALID_TRANSITIONS'), 'must define valid transition map');
    assert.ok(stateMachineSrc.includes("IDLE: ['P']"), 'IDLE should only allow P transition');
    assert.ok(stateMachineSrc.includes("C: ['D']"), 'C should transition to D');
});

test('VR-006: state machine exports canTransition', () => {
    assert.ok(stateMachineSrc.includes('export function canTransition'), 'canTransition must be exported');
});

// ─── RV: PABCD Prefix Map 검증 ──────────────────────

test('RV-001: state machine has PLANNING, AUDIT, and BUILD prefixes', () => {
    assert.ok(stateMachineSrc.includes('PLANNING MODE'), 'P state should have PLANNING prefix');
    assert.ok(stateMachineSrc.includes('PLAN AUDIT'), 'A state should have AUDIT prefix');
    assert.ok(stateMachineSrc.includes('IMPLEMENTATION REVIEW'), 'B state should have BUILD prefix');
});

// ─── QP: Queue Policy 검증 ───────────────────────────

test('QP-001: queue policy is documented as "fair"', () => {
    assert.ok(
        spawnSrc.includes('Queue policy: "fair"'),
        'spawn.ts should document fair queue policy',
    );
});

test('QP-002: batch tail goes after remaining (fair ordering)', () => {
    const queueBlock = spawnSrc.slice(
        spawnSrc.indexOf('if (batch.length > 1)'),
        spawnSrc.indexOf('const combined = batch[0]'),
    );
    assert.ok(
        queueBlock.includes('...remaining, ...batch.slice(1)'),
        'remaining should come before batch tail in push',
    );
});

// ─── RC: orchestrateContinue PABCD-aware ─────────────

test('RC-001: orchestrateContinue checks PABCD state before worklog', () => {
    const continueBlock = pipelineSrc.slice(
        pipelineSrc.indexOf('export async function orchestrateContinue'),
    );
    assert.ok(
        continueBlock.includes("state !== 'IDLE'"),
        'continue should check active PABCD state',
    );
    assert.ok(
        continueBlock.includes('_skipClear: true'),
        'continue should preserve sessions (_skipClear)',
    );
});

test('RC-002: PABCD requires explicit entry (no auto-activation)', () => {
    assert.ok(
        !pipelineSrc.includes('shouldAutoActivatePABCD'),
        'auto-activation helper should be removed',
    );
    assert.ok(
        !pipelineSrc.includes('PABCD_ACTIVATE_PATTERNS'),
        'activation patterns should be removed',
    );
});

test('RC-003: PABCD requires explicit phase advance (no auto-advance)', () => {
    assert.ok(
        !pipelineSrc.includes('AUTO_APPROVE_NEXT'),
        'auto-approve map should be removed',
    );
});
