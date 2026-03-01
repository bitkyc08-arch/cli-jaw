// Phase 9.4: orchestrator triage 단위 테스트
// 이미 export된 함수를 직접 검증 (추가 작업 없이 즉시 실행 가능)
import test from 'node:test';
import assert from 'node:assert/strict';
import { isContinueIntent, needsOrchestration } from '../../src/orchestrator/pipeline.ts';

// ─── isContinueIntent ────────────────────────────────

test('ORT-001: "continue" matches', () => {
    assert.equal(isContinueIntent('continue'), true);
    assert.equal(isContinueIntent('Continue'), true);
    assert.equal(isContinueIntent('/continue'), true);
});

test('ORT-002: "이어서 해줘" matches', () => {
    assert.equal(isContinueIntent('이어서 해줘'), true);
    assert.equal(isContinueIntent('이어서'), true);
});

test('ORT-003: "계속 해줘" matches', () => {
    assert.equal(isContinueIntent('계속 해줘'), true);
    assert.equal(isContinueIntent('계속'), true);
});

test('ORT-003b: "again/다시" matches', () => {
    assert.equal(isContinueIntent('again'), true);
    assert.equal(isContinueIntent('다시'), true);
    assert.equal(isContinueIntent('다시 해줘'), true);
});

test('ORT-004: non-continue intent returns false', () => {
    assert.equal(isContinueIntent('계획 짜줘'), false);
    assert.equal(isContinueIntent('server.js 수정해줘'), false);
    assert.equal(isContinueIntent('안녕'), false);
});

test('ORT-005: empty/null returns false', () => {
    assert.equal(isContinueIntent(''), false);
    assert.equal(isContinueIntent(null), false);
    assert.equal(isContinueIntent(undefined), false);
});

// ─── needsOrchestration ──────────────────────────────
// needs >= 2 signals from: length>=80, codeKeywords, multiKeywords, filePath, multiTask

test('ORT-006: complex coding request needs orchestration', () => {
    // has: code keyword(구현+수정) + file path(src/) + multi-task(그리고) = 3+ signals
    const msg = 'src/server.js 라우트 분리 구현하고 그리고 tests 추가하고 API 회귀 확인해줘';
    assert.equal(needsOrchestration(msg), true);
});

test('ORT-007: short casual message bypasses orchestration', () => {
    assert.equal(needsOrchestration('안녕'), false);
    assert.equal(needsOrchestration('오늘 날씨 어때?'), false);
});

test('ORT-008: empty/null returns false', () => {
    assert.equal(needsOrchestration(''), false);
    assert.equal(needsOrchestration(null), false);
});

test('ORT-009: long text with code keywords triggers', () => {
    // length >= 80 + code keyword = 2 signals minimum
    const long = 'server.js의 라우트를 모듈별로 분리하고 각 모듈에 대한 단위 테스트를 작성해야 합니다. 현재 900줄이 넘는 파일을 6개로 분리해야 합니다.';
    assert.equal(needsOrchestration(long), true);
});

test('ORT-010: single signal alone is not enough', () => {
    // only file path signal, no code keyword, not long enough, no multi-task
    assert.equal(needsOrchestration('config/ 열어볼게'), false);
});
