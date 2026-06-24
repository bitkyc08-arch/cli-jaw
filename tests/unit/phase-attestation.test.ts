import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePhaseAttestation,
  parsePhaseAttestationObject,
  stripPhaseAttestation,
  checkAttestationGate,
  detectNoStateNarration,
} from '../../src/orchestrator/attestation.ts';

// ─── parse (tagged block) ───────────────────────────

test('ATT-PARSE-001: parses a well-formed tagged block', () => {
  const text = 'work done.\n<phase_attestation>{"from":"A","to":"B","did":"audited plan via Backend, 3 imports checked, PASS"}</phase_attestation>';
  const att = parsePhaseAttestation(text);
  assert.ok(att);
  assert.equal(att!.from, 'A');
  assert.equal(att!.to, 'B');
  assert.match(att!.did, /audited plan/);
});

test('ATT-PARSE-002: returns null when no block present', () => {
  assert.equal(parsePhaseAttestation('just prose, no block'), null);
  assert.equal(parsePhaseAttestation(''), null);
});

test('ATT-PARSE-003: invalid from/to → null; missing did still parses (did empty)', () => {
  assert.equal(parsePhaseAttestation('<phase_attestation>{"from":"X","to":"B","did":"x"}</phase_attestation>'), null);
  const att = parsePhaseAttestation('<phase_attestation>{"from":"A","to":"B"}</phase_attestation>');
  assert.ok(att, 'block with valid from/to parses even without did');
  assert.equal(att!.did, '');
});

test('ATT-PARSE-004: malformed JSON body → null', () => {
  assert.equal(parsePhaseAttestation('<phase_attestation>{not json}</phase_attestation>'), null);
});

test('ATT-PARSE-005: parses checkOutput + exitCode for C→D', () => {
  const att = parsePhaseAttestation('<phase_attestation>{"from":"C","to":"D","did":"ran tsc+tests","checkOutput":"tests 49/49 pass","exitCode":0}</phase_attestation>');
  assert.ok(att);
  assert.equal(att!.checkOutput, 'tests 49/49 pass');
  assert.equal(att!.exitCode, 0);
});

// ─── parse (object from --attest body) ──────────────

test('ATT-OBJ-001: coerces a valid object', () => {
  const att = parsePhaseAttestationObject({ from: 'A', to: 'B', did: 'real work' });
  assert.ok(att);
  assert.equal(att!.from, 'A');
});

test('ATT-OBJ-002: rejects non-object / array / bad phases', () => {
  assert.equal(parsePhaseAttestationObject(null), null);
  assert.equal(parsePhaseAttestationObject([1, 2]), null);
  assert.equal(parsePhaseAttestationObject('string'), null);
  assert.equal(parsePhaseAttestationObject({ from: 'A', to: 'Z', did: 'x' }), null);
});

// ─── strip ──────────────────────────────────────────

test('ATT-STRIP-001: removes block, keeps prose, idempotent', () => {
  const text = 'hello\n<phase_attestation>{"from":"A","to":"B","did":"x"}</phase_attestation>\nbye';
  const once = stripPhaseAttestation(text);
  assert.ok(!once.includes('phase_attestation'));
  assert.match(once, /hello/);
  assert.match(once, /bye/);
  assert.equal(stripPhaseAttestation(once), once, 'idempotent');
});

test('ATT-STRIP-002: removes a dangling open tag (truncated)', () => {
  const text = 'partial\n<phase_attestation>{"from":"A"';
  assert.ok(!stripPhaseAttestation(text).includes('phase_attestation'));
});

// ─── gate (form-only) ───────────────────────────────

test('ATT-GATE-001: ungated transitions always pass (no attestation needed)', () => {
  assert.equal(checkAttestationGate('IDLE', 'P', null).ok, true);
  assert.equal(checkAttestationGate('IDLE', 'I', null).ok, true);
  assert.equal(checkAttestationGate('A', 'I', null).ok, true);     // any→I
  assert.equal(checkAttestationGate('C', 'B', null).ok, true);     // reject route
});

test('ATT-GATE-002: gated transition without attestation → fail with actionable reason', () => {
  const r = checkAttestationGate('A', 'B', null);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /--attest/);
});

test('ATT-GATE-003: P→A, A→B, B→C pass with a real did', () => {
  for (const [from, to] of [['P', 'A'], ['A', 'B'], ['B', 'C']] as const) {
    const att = parsePhaseAttestationObject({ from, to, did: 'specific real work narrative' })!;
    assert.equal(checkAttestationGate(from, to, att).ok, true, `${from}→${to} should pass`);
  }
});

test('ATT-GATE-004: from/to mismatch → fail', () => {
  const att = parsePhaseAttestationObject({ from: 'A', to: 'B', did: 'x real' })!;
  const r = checkAttestationGate('B', 'C', att);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /does not match/);
});

test('ATT-GATE-005: empty/placeholder did → fail', () => {
  for (const did of ['', '   ', 'tbd', 'TODO', 'done', '...', 'n/a']) {
    const att = parsePhaseAttestationObject({ from: 'A', to: 'B', did })!;
    assert.equal(checkAttestationGate('A', 'B', att).ok, false, `did=${JSON.stringify(did)} should fail`);
  }
});

test('ATT-GATE-006: C→D requires non-empty checkOutput', () => {
  const noOut = parsePhaseAttestationObject({ from: 'C', to: 'D', did: 'ran checks' })!;
  assert.equal(checkAttestationGate('C', 'D', noOut).ok, false);
  const withOut = parsePhaseAttestationObject({ from: 'C', to: 'D', did: 'ran checks', checkOutput: 'tsc clean; 49/49 pass' })!;
  assert.equal(checkAttestationGate('C', 'D', withOut).ok, true);
});

test('ATT-GATE-006b: C→D whitespace-only checkOutput → fail', () => {
  const att = parsePhaseAttestationObject({ from: 'C', to: 'D', did: 'ran checks', checkOutput: '   \n  ' })!;
  assert.equal(checkAttestationGate('C', 'D', att).ok, false);
});

test('ATT-GATE-008: boolean did is not laundered into evidence', () => {
  // A boolean did coerces to '' (not a string) → rejected.
  const att = parsePhaseAttestationObject({ from: 'A', to: 'B', did: true })!;
  assert.equal(att.did, '');
  assert.equal(checkAttestationGate('A', 'B', att).ok, false);
});

test('ATT-GATE-007: C→D rejects non-zero exitCode', () => {
  const att = parsePhaseAttestationObject({ from: 'C', to: 'D', did: 'ran', checkOutput: 'FAIL', exitCode: 1 })!;
  const r = checkAttestationGate('C', 'D', att);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /exitCode 1/);
});

// ─── no-state narration detector ────────────────────

test('ATT-NOSTATE-001: positives — asserting a current phase', () => {
  assert.equal(detectNoStateNarration('현재는 P입니다. 계획을 세우겠습니다'), true);
  assert.equal(detectNoStateNarration('지금 A 단계로 진행합니다'), true);
  assert.equal(detectNoStateNarration('We are now in phase B, building.'), true);
  assert.equal(detectNoStateNarration('entering the A phase'), true);
});

test('ATT-NOSTATE-002: negatives — explaining PABCD, not asserting current phase', () => {
  assert.equal(detectNoStateNarration('PABCD is a 5-phase workflow: P, A, B, C, D.'), false);
  assert.equal(detectNoStateNarration('The plan covers phases of work.'), false);
  assert.equal(detectNoStateNarration('```\ncli-jaw orchestrate P  # enter planning\n```'), false);
  assert.equal(detectNoStateNarration(''), false);
});
