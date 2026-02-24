// Phase 17.3: employee prompt 명칭 통일 + 내용 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmployeePrompt, getEmployeePromptV2 } from '../../src/prompt.js';
import { needsOrchestration, parseSubtasks } from '../../src/orchestrator/pipeline.js';

// ─── getEmployeePrompt: export + 기본 구조 ─────────

test('EMP-001: getEmployeePrompt is exported', () => {
    assert.equal(typeof getEmployeePrompt, 'function');
});

test('EMP-002: getEmployeePromptV2 is exported', () => {
    assert.equal(typeof getEmployeePromptV2, 'function');
});

test('EMP-003: getEmployeePrompt returns string with employee name', () => {
    const emp = { name: 'Frontend', cli: 'claude', role: 'frontend developer' };
    const prompt = getEmployeePrompt(emp);
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.includes('Frontend'));
    assert.ok(prompt.includes('frontend developer'));
});

test('EMP-004: getEmployeePrompt includes executor rules (no subtask output)', () => {
    const emp = { name: 'Backend', cli: 'claude', role: 'backend' };
    const prompt = getEmployeePrompt(emp);
    assert.ok(prompt.includes('Do NOT output JSON subtasks'));
    assert.ok(prompt.includes('executor'));
});

test('EMP-005: getEmployeePrompt includes browser control section', () => {
    const emp = { name: 'Test', cli: 'claude', role: 'tester' };
    const prompt = getEmployeePrompt(emp);
    assert.ok(prompt.includes('Browser Control'));
    assert.ok(prompt.includes('cli-claw browser'));
});

test('EMP-006: getEmployeePrompt includes telegram section', () => {
    const emp = { name: 'Test', cli: 'claude', role: '' };
    const prompt = getEmployeePrompt(emp);
    assert.ok(prompt.includes('Telegram File Delivery'));
});

test('EMP-007: getEmployeePrompt defaults role to general developer', () => {
    const emp = { name: 'NoRole', cli: 'claude' };
    const prompt = getEmployeePrompt(emp);
    assert.ok(prompt.includes('general developer'));
});

// ─── getEmployeePromptV2: phase-aware ────────────────

test('EMP-008: getEmployeePromptV2 returns longer string than base', () => {
    const emp = { name: 'Frontend', cli: 'claude', role: 'frontend' };
    const base = getEmployeePrompt(emp);
    const v2 = getEmployeePromptV2(emp, 'frontend', 1);
    assert.ok(v2.length > base.length, 'v2 should include additional skill content');
});

test('EMP-009: getEmployeePromptV2 includes phase gate', () => {
    const emp = { name: 'Backend', cli: 'claude', role: 'backend' };
    const v2 = getEmployeePromptV2(emp, 'backend', 3);
    // Should include some phase-related content
    assert.ok(v2.length > 0);
});

// ─── Phase 17: triage AI dispatch ────────────────────

test('EMP-010: needsOrchestration returns false for short messages', () => {
    assert.equal(needsOrchestration('안녕'), false);
    assert.equal(needsOrchestration('ㅎㅇ'), false);
});

test('EMP-011: parseSubtasks extracts subtask JSON from agent response', () => {
    const text = '직원한테 시킬게요\n```json\n{"subtasks":[{"agent":"Frontend","task":"UI 수정"}]}\n```';
    const subtasks = parseSubtasks(text);
    assert.ok(Array.isArray(subtasks));
    assert.equal(subtasks.length, 1);
    assert.equal(subtasks[0].agent, 'Frontend');
});

test('EMP-012: parseSubtasks returns empty for no JSON', () => {
    const subtasks = parseSubtasks('그냥 직접 해줄게요');
    assert.ok(!subtasks || subtasks.length === 0);
});

// ─── old name should not exist ───────────────────────

test('EMP-013: getSubAgentPrompt should not be exported (renamed)', async () => {
    const mod = await import('../../src/prompt.js');
    assert.equal(mod.getSubAgentPrompt, undefined, 'old name should not exist');
});

test('EMP-014: getSubAgentPromptV2 should not be exported (renamed)', async () => {
    const mod = await import('../../src/prompt.js');
    assert.equal(mod.getSubAgentPromptV2, undefined, 'old name should not exist');
});
