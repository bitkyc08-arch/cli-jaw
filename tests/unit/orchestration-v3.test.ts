// Phase 2 검증: orchestration-v3 단위 테스트
// initAgentPhases — end_phase + sparse fallback + checkpoint
import test from 'node:test';
import assert from 'node:assert/strict';
import { initAgentPhases } from '../../src/orchestrator/pipeline.ts';

// ─── EP: end_phase 파싱 ──────────────────────────────

test('EP-001: end_phase 생략 → maxPhase (하위호환)', () => {
    const [ap] = initAgentPhases([{ agent: 'A', role: 'backend', task: 'x', start_phase: 1 }]);
    // backend fullProfile = [1,2,3,4,5] → maxPhase = 5
    assert.deepEqual(ap.phaseProfile, [1, 2, 3, 4, 5]);
});

test('EP-002: start=3 end=3 → profile [3]', () => {
    const [ap] = initAgentPhases([{ agent: 'A', role: 'backend', task: 'x', start_phase: 3, end_phase: 3 }]);
    assert.deepEqual(ap.phaseProfile, [3]);
});

test('EP-003: start > end → end 보정 (endPhase = max(start, end))', () => {
    const [ap] = initAgentPhases([{ agent: 'A', role: 'backend', task: 'x', start_phase: 5, end_phase: 3 }]);
    // endPhase = max(5, min(5, 3)) = max(5, 3) = 5
    assert.deepEqual(ap.phaseProfile, [5]);
});

test('EP-004: docs start=2 end=2 → sparse fallback [3]', () => {
    // docs fullProfile = [1, 3, 5]
    const [ap] = initAgentPhases([{ agent: 'A', role: 'docs', task: 'x', start_phase: 2, end_phase: 2 }]);
    // filter [1,3,5] where p >= 2 && p <= 2 → [] → fallback: find(p >= 2) = 3
    assert.deepEqual(ap.phaseProfile, [3]);
});

test('EP-005: docs start=2 end=4 → [3]', () => {
    const [ap] = initAgentPhases([{ agent: 'A', role: 'docs', task: 'x', start_phase: 2, end_phase: 4 }]);
    assert.deepEqual(ap.phaseProfile, [3]);
});

test('EP-006: end_phase=99 → clamp to maxPhase', () => {
    const [ap] = initAgentPhases([{ agent: 'A', role: 'backend', task: 'x', start_phase: 3, end_phase: 99 }]);
    assert.deepEqual(ap.phaseProfile, [3, 4, 5]);
});

test('EP-007: default role (custom) → profile [3]', () => {
    const [ap] = initAgentPhases([{ agent: 'A', task: 'x' }]);
    assert.deepEqual(ap.phaseProfile, [3]);
});

test('EP-008: start_phase 생략 → minPhase', () => {
    const [ap] = initAgentPhases([{ agent: 'A', role: 'frontend', task: 'x', end_phase: 2 }]);
    assert.deepEqual(ap.phaseProfile, [1, 2]);
});

// ─── CP: checkpoint 필드 ─────────────────────────────

test('CP-001: checkpoint=true 저장 확인', () => {
    const [ap] = initAgentPhases([{ agent: 'A', role: 'backend', task: 'x', checkpoint: true }]);
    assert.equal(ap.checkpoint, true);
    assert.equal(ap.checkpointed, false);
});

test('CP-002: checkpoint 생략 → false', () => {
    const [ap] = initAgentPhases([{ agent: 'A', role: 'backend', task: 'x' }]);
    assert.equal(ap.checkpoint, false);
    assert.equal(ap.checkpointed, false);
});

test('CP-003: completed 초기값 false', () => {
    const [ap] = initAgentPhases([{ agent: 'A', role: 'backend', task: 'x', checkpoint: true }]);
    assert.equal(ap.completed, false);
});

// ─── 복합 시나리오 ────────────────────────────────────

test('EP-009: 여러 agent — 각각 다른 phase range', () => {
    const phases = initAgentPhases([
        { agent: 'FE', role: 'frontend', task: 'x', start_phase: 3, end_phase: 4 },
        { agent: 'BE', role: 'backend', task: 'y', start_phase: 1, end_phase: 2 },
        { agent: 'Doc', role: 'docs', task: 'z', start_phase: 1, end_phase: 5 },
    ]);
    assert.deepEqual(phases[0].phaseProfile, [3, 4]);
    assert.deepEqual(phases[1].phaseProfile, [1, 2]);
    assert.deepEqual(phases[2].phaseProfile, [1, 3, 5]);
});

test('EP-010: parallel + checkpoint + end_phase 조합', () => {
    const [ap] = initAgentPhases([{
        agent: 'A', role: 'backend', task: 'x',
        start_phase: 3, end_phase: 3,
        checkpoint: true, parallel: true,
    }]);
    assert.deepEqual(ap.phaseProfile, [3]);
    assert.equal(ap.checkpoint, true);
    assert.equal(ap.parallel, true);
    assert.equal(ap.currentPhase, 3);
    assert.equal(ap.currentPhaseIdx, 0);
});
