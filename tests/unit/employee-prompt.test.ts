// Phase 17.3: employee prompt 명칭 통일 + 내용 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEmployeePrompt, getEmployeePromptV2, clearPromptCache } from '../../src/prompt/builder.ts';
import { needsOrchestration, parseSubtasks } from '../../src/orchestrator/pipeline.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reviewerPath = join(__dirname, '../../skills_ref/dev-code-reviewer/SKILL.md');
const hasSkillsRef = fs.existsSync(reviewerPath);

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
    assert.ok(prompt.includes('cli-jaw browser'));
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

// ─── Phase 2: dev-code-reviewer injection ─────────────

test('EMP-020: Phase 2 injects dev-code-reviewer content', { skip: !hasSkillsRef && 'skills_ref submodule not checked out' }, () => {
    const emp = { name: 'Data', cli: 'claude', role: 'data' };
    const v2 = getEmployeePromptV2(emp, 'data', 2);
    assert.ok(v2.includes('Code Review Guide (Phase 2'), 'Phase 2 should inject code-reviewer guide');
    assert.ok(v2.includes('PLAN AUDIT worker'), 'Phase 2 should have PLAN AUDIT worker context');
});

test('EMP-021: Phase 4 injects dev-testing, NOT dev-code-reviewer', { skip: !hasSkillsRef && 'skills_ref submodule not checked out' }, () => {
    const emp = { name: 'Backend', cli: 'claude', role: 'backend' };
    const v2 = getEmployeePromptV2(emp, 'backend', 4);
    assert.ok(v2.includes('Testing Guide (Phase 4)'), 'Phase 4 should inject testing guide');
    assert.ok(!v2.includes('Code Review Guide (Phase 2'), 'Phase 4 should NOT inject code-reviewer');
    assert.ok(v2.includes('CHECK worker'), 'Phase 4 should have CHECK worker context');
});

test('EMP-022: Phase 3 does NOT inject reviewer or testing guides', () => {
    const emp = { name: 'Frontend', cli: 'claude', role: 'frontend' };
    const v2 = getEmployeePromptV2(emp, 'frontend', 3);
    assert.ok(!v2.includes('Code Review Guide (Phase 2'), 'Phase 3 should NOT inject reviewer');
    assert.ok(!v2.includes('Testing Guide (Phase 4)'), 'Phase 3 should NOT inject testing');
    assert.ok(v2.includes('IMPLEMENTATION worker'), 'Phase 3 should have IMPLEMENTATION worker context');
});

test('EMP-023: String phase "2" works same as number 2 (type coercion safety)', { skip: !hasSkillsRef && 'skills_ref submodule not checked out' }, () => {
    const emp = { name: 'Data', cli: 'claude', role: 'data' };
    clearPromptCache();
    const v2str = getEmployeePromptV2(emp, 'data', '2' as any);
    clearPromptCache();
    const v2num = getEmployeePromptV2(emp, 'data', 2);
    // Both should inject code-reviewer (Number() normalization)
    assert.ok(v2str.includes('Code Review Guide (Phase 2'), 'String "2" must also inject reviewer');
    assert.ok(v2num.includes('Code Review Guide (Phase 2'), 'Number 2 must inject reviewer');
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
    const mod = await import('../../src/prompt/builder.ts');
    assert.equal(mod.getSubAgentPrompt, undefined, 'old name should not exist');
});

test('EMP-014: getSubAgentPromptV2 should not be exported (renamed)', async () => {
    const mod = await import('../../src/prompt/builder.ts');
    assert.equal(mod.getSubAgentPromptV2, undefined, 'old name should not exist');
});
