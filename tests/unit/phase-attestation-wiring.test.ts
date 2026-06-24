import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripPhaseAttestation } from '../../src/orchestrator/sanitize.ts';

const projectRoot = join(import.meta.dirname, '../..');
const pipelineSrc = readFileSync(join(projectRoot, 'src/orchestrator/pipeline.ts'), 'utf8');
const sanitizeSrc = readFileSync(join(projectRoot, 'src/orchestrator/sanitize.ts'), 'utf8');

// sanitize re-export gives all broadcast points symmetric access to the stripper.
test('ATT-WIRE-001: sanitize re-exports stripPhaseAttestation (single source of truth)', () => {
    assert.ok(sanitizeSrc.includes("export { stripPhaseAttestation } from './attestation.js'"), 'sanitize should re-export the canonical stripper');
    assert.equal(typeof stripPhaseAttestation, 'function', 're-export should resolve to the function');
    const stripped = stripPhaseAttestation('hi <phase_attestation>{"from":"A","to":"B","did":"x"}</phase_attestation> bye');
    assert.ok(!stripped.includes('phase_attestation'));
});

test('ATT-WIRE-002: pipeline strips the block for P/A/B/C and persists a fallback', () => {
    assert.ok(pipelineSrc.includes("['P', 'A', 'B', 'C'].includes(state)"), 'pipeline should handle the gated states');
    assert.ok(pipelineSrc.includes('stripPhaseAttestation(attText)'), 'pipeline should strip the block from chat');
    assert.ok(pipelineSrc.includes('pendingAttestation: att'), 'pipeline should persist a fallback attestation');
    assert.ok(pipelineSrc.includes('GATE itself reads --attest'), 'pipeline should document that the gate uses --attest, not this branch');
});

test('ATT-WIRE-003: pipeline no-state detector warns (never blocks) when IDLE', () => {
    assert.ok(pipelineSrc.includes("state === 'IDLE'"), 'no-state detector should only fire when IDLE');
    assert.ok(pipelineSrc.includes('detectNoStateNarration(narrated)'), 'pipeline should call the detector');
    assert.ok(pipelineSrc.includes('the orchestrator is IDLE'), 'warning should explain no phase is active');
    // Must be append-only — the original text is preserved inside the template.
    assert.ok(pipelineSrc.includes('${narrated}'), 'detector must append to (not replace) the message');
});
