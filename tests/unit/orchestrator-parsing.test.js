// Phase 9.4: orchestrator parsing 단위 테스트
// 이미 export된 함수를 직접 검증 (추가 작업 없이 즉시 실행 가능)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtasks, parseDirectAnswer, stripSubtaskJSON } from '../../src/orchestrator/pipeline.js';

// ─── parseSubtasks ───────────────────────────────────

test('ORP-001: fenced json subtasks parse', () => {
    const input = 'Plan:\n```json\n{"subtasks":[{"agent":"백엔드","task":"server.js 분리"}]}\n```\nDone.';
    const st = parseSubtasks(input);
    assert.ok(Array.isArray(st));
    assert.equal(st.length, 1);
    assert.equal(st[0].agent, '백엔드');
    assert.equal(st[0].task, 'server.js 분리');
});

test('ORP-002: multiple subtasks parse', () => {
    const input = '```json\n{"subtasks":[{"agent":"A","task":"x"},{"agent":"B","task":"y"}]}\n```';
    const st = parseSubtasks(input);
    assert.equal(st.length, 2);
    assert.equal(st[1].agent, 'B');
});

test('ORP-003: malformed json returns null', () => {
    assert.equal(parseSubtasks('```json\n{broken\n```'), null);
});

test('ORP-004: no json block returns null', () => {
    assert.equal(parseSubtasks('plain text without any json'), null);
});

test('ORP-005: null/empty input returns null', () => {
    assert.equal(parseSubtasks(null), null);
    assert.equal(parseSubtasks(''), null);
    assert.equal(parseSubtasks(undefined), null);
});

test('ORP-006: raw (unfenced) json with subtasks', () => {
    const input = '결과: {"subtasks":[{"agent":"dev","task":"fix"}]}';
    const st = parseSubtasks(input);
    assert.ok(st);
    assert.equal(st[0].agent, 'dev');
});

// ─── parseDirectAnswer ───────────────────────────────

test('ORP-007: direct_answer only path', () => {
    const input = '```json\n{"direct_answer":"안녕하세요!","subtasks":[]}\n```';
    assert.equal(parseDirectAnswer(input), '안녕하세요!');
});

test('ORP-008: direct_answer with subtasks returns null', () => {
    const input = '```json\n{"direct_answer":"hi","subtasks":[{"agent":"a","task":"b"}]}\n```';
    assert.equal(parseDirectAnswer(input), null);
});

test('ORP-009: no direct_answer returns null', () => {
    const input = '```json\n{"subtasks":[{"agent":"a","task":"b"}]}\n```';
    assert.equal(parseDirectAnswer(input), null);
});

test('ORP-010: null input returns null', () => {
    assert.equal(parseDirectAnswer(null), null);
});

// ─── stripSubtaskJSON ────────────────────────────────

test('ORP-011: strips fenced json block', () => {
    const s = stripSubtaskJSON('요약입니다.\n```json\n{"subtasks":[]}\n```\n끝.');
    assert.ok(!s.includes('subtasks'));
    assert.ok(s.includes('요약'));
    assert.ok(s.includes('끝'));
});

test('ORP-012: strips raw json block', () => {
    const s = stripSubtaskJSON('앞 {"subtasks":[{"agent":"x","task":"y"}]} 뒤');
    assert.ok(!s.includes('subtasks'));
});

test('ORP-013: preserves text without json', () => {
    const text = '아무 JSON도 없는 텍스트';
    assert.equal(stripSubtaskJSON(text), text);
});
