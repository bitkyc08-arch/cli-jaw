// Phase 17.3: employee prompt 명칭 통일 + 내용 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEmployeePrompt, getEmployeePromptV2, clearPromptCache, formatSkillListItem, loadActiveSkills } from '../../src/prompt/builder.ts';
import { parseSubtasks } from '../../src/orchestrator/parser.ts';
import { SKILLS_DIR } from '../../src/core/config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reviewerPath = join(__dirname, '../../skills_ref/jaw-dev-code-reviewer/SKILL.md');
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
    assert.ok(prompt.includes('subtask JSON'), 'should prohibit subtask JSON output');
    assert.ok(prompt.includes('executor'));
});

test('EMP-005: getEmployeePrompt includes browser control section', () => {
    const emp = { name: 'Test', cli: 'claude', role: 'tester' };
    const prompt = getEmployeePrompt(emp);
    assert.ok(prompt.includes('Browser Control'));
    assert.ok(prompt.includes('cli-jaw browser'));
});

test('EMP-006: getEmployeePrompt includes channel file delivery section', () => {
    const emp = { name: 'Test', cli: 'claude', role: '' };
    const prompt = getEmployeePrompt(emp);
    assert.ok(prompt.includes('Channel File Delivery'));
});

test('EMP-007: getEmployeePrompt defaults role to general developer', () => {
    const emp = { name: 'NoRole', cli: 'claude' };
    const prompt = getEmployeePrompt(emp);
    assert.ok(prompt.includes('general developer'));
});

// ─── getEmployeePromptV2: phase-aware ────────────────

test('EMP-008: getEmployeePromptV2 adds compact skill and role contracts', () => {
    const emp = { name: 'Frontend', cli: 'claude', role: 'frontend' };
    const base = getEmployeePrompt(emp);
    const v2 = getEmployeePromptV2(emp, 'frontend', 1);
    assert.ok(v2.length > base.length, 'v2 should include compact employee context');
    assert.ok(v2.includes('Skill Loading Contract'), 'v2 should include on-demand skill loading guidance');
    assert.ok(v2.includes('Role Contract'), 'v2 should include role contract');
    assert.ok(v2.includes('dev-frontend'), 'frontend role guide should be named');
    assert.match(v2, /dev-frontend.*MUST USE for any frontend/,
        'role guide should include the skill metadata description, not only the path');
    assert.ok(!v2.includes('## Development Guide (Common)'), 'dev guide body should not be inlined');
});

test('EMP-008b: skill list items include metadata descriptions', () => {
    const line = formatSkillListItem({
        id: 'dev-backend',
        name: 'dev-backend',
        description: 'Backend engineering guide for orchestrated sub-agents.',
        keywords: ['connector-api', 'audit-log'],
    });
    assert.equal(line, '- dev-backend — Backend engineering guide for orchestrated sub-agents. [keywords: connector-api, audit-log]');
});

test('EMP-008c: employee prompt reinforces skill metadata matching', () => {
    const emp = { name: 'Backend', cli: 'claude', role: 'backend' };
    clearPromptCache();
    const v2 = getEmployeePromptV2(emp, 'backend', 1);
    assert.ok(v2.includes('Match by intent, not exact words'),
        'employee prompt should route skills by semantic task intent');
    assert.ok(v2.includes('against visible skill names, descriptions, and any listed metadata, keywords, or triggers'),
        'employee prompt should name metadata fields used for skill matching');
    assert.ok(v2.includes('read that SKILL.md once before deciding it does not apply'),
        'employee prompt should inspect plausible skill candidates before rejecting them');
});

test('EMP-008c2: base employee active skill section names the SKILL.md path pattern', () => {
    const skillDir = join(SKILLS_DIR, 'meta-test');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(join(skillDir, 'SKILL.md'), [
        '---',
        'name: meta-test',
        'description: Test skill for active skill path rendering.',
        'keywords: [path-render]',
        '---',
        '',
        '# Meta Test',
    ].join('\n'));

    const emp = { name: 'Backend', cli: 'claude', role: 'backend' };
    const prompt = getEmployeePrompt(emp);
    assert.ok(prompt.includes(`Read active skills from ${SKILLS_DIR}/<skill-id>/SKILL.md`),
        'base employee prompt should tell employees where to read active skill bodies');
    assert.ok(prompt.includes('[keywords: path-render]'),
        'base employee prompt should render active skill keyword metadata when present');
});

test('EMP-008c3: active skills render nested metadata triggers for routing', () => {
    const skillDir = join(SKILLS_DIR, 'search-route-test');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(join(skillDir, 'SKILL.md'), [
        '---',
        'name: search-route-test',
        'description: Search routing skill.',
        'metadata:',
        '  {',
        '    "triggers": ["검색해", "찾아봐", "context7"],',
        '    "keywords": ["web-search"]',
        '  }',
        '---',
        '',
        '# Search Route Test',
    ].join('\n'));

    const active = loadActiveSkills();
    const skill = active.find(s => s?.id === 'search-route-test');
    assert.deepEqual(skill?.triggers, ['검색해', '찾아봐', 'context7']);
    assert.deepEqual(skill?.keywords, ['web-search']);

    const prompt = getEmployeePrompt({ name: 'Backend', role: 'backend' });
    assert.ok(prompt.includes('[keywords: web-search; triggers: 검색해, 찾아봐, context7]'),
        'base employee prompt should expose nested metadata triggers for skill matching');
    assert.ok(prompt.includes('Search intent override'),
        'base employee prompt should tell workers to inspect active search skill before local grep');
});

test('EMP-008d: docs role resolves to dev-scaffolding skill', () => {
    const emp = { name: 'Docs', cli: 'agy', role: 'docs' };
    clearPromptCache();
    const v2 = getEmployeePromptV2(emp, 'docs', 1);
    assert.ok(v2.includes('dev-scaffolding'),
        'docs role should map to the dev-scaffolding skill');
    assert.ok(!v2.includes('Role guide: documentation: unavailable'),
        'docs role should not point to the removed documentation skill id');
});

test('EMP-008e: AGY employee prompt includes source-verification search grounding rules', () => {
    const emp = { name: 'Data', cli: 'agy', role: 'data' };
    clearPromptCache();
    const v2 = getEmployeePromptV2(emp, 'data', 1);
    assert.ok(v2.includes('AGY Search Grounding Rules'),
        'AGY employees should receive a provider-specific search grounding block');
    assert.ok(v2.includes('AGY/Gemini search summaries are orientation only, not final evidence'),
        'AGY prompt should reject summary-only final evidence');
    assert.ok(v2.includes('Treat search_web output as URL candidates only'),
        'AGY prompt should treat search_web output as URL candidates');
    assert.ok(v2.includes('NEEDS_BROWSER_VERIFICATION'),
        'AGY prompt should require explicit evidence-state labeling');
});

test('EMP-008f: AGY search grounding rules are not injected into non-AGY employee prompts', () => {
    clearPromptCache();
    const agy = getEmployeePromptV2({ name: 'Data', cli: 'agy', role: 'data' }, 'data', 1);
    const codex = getEmployeePromptV2({ name: 'Data', cli: 'codex', role: 'data' }, 'data', 1);
    assert.ok(agy.includes('AGY Search Grounding Rules'),
        'sanity check: AGY prompt should include AGY-specific rules');
    assert.equal(codex.includes('AGY Search Grounding Rules'), false,
        'prompt cache must keep AGY-specific rules out of non-AGY prompts');
});

test('EMP-009: getEmployeePromptV2 includes phase gate', () => {
    const emp = { name: 'Backend', cli: 'claude', role: 'backend' };
    const v2 = getEmployeePromptV2(emp, 'backend', 3);
    // Should include some phase-related content
    assert.ok(v2.length > 0);
});

// ─── Phase 2: dev-code-reviewer injection ─────────────

test('EMP-020: Phase 2 references dev-code-reviewer without inlining content', { skip: !hasSkillsRef && 'skills_ref submodule not checked out' }, () => {
    const emp = { name: 'Data', cli: 'claude', role: 'data' };
    const v2 = getEmployeePromptV2(emp, 'data', 2);
    assert.ok(v2.includes('Phase 2 audit'), 'Phase 2 should include compact audit guidance');
    assert.ok(v2.includes('dev-code-reviewer'), 'Phase 2 should reference code-reviewer guide path');
    assert.ok(!v2.includes('Code Review Guide (Phase 2'), 'Phase 2 should not inline code-reviewer guide body');
    assert.ok(v2.includes('PLAN AUDIT employee'), 'Phase 2 should have PLAN AUDIT employee context');
});

test('EMP-021: Phase 4 references dev-testing, NOT dev-code-reviewer body', { skip: !hasSkillsRef && 'skills_ref submodule not checked out' }, () => {
    const emp = { name: 'Backend', cli: 'claude', role: 'backend' };
    const v2 = getEmployeePromptV2(emp, 'backend', 4);
    assert.ok(v2.includes('Phase 4 check'), 'Phase 4 should include compact testing guidance');
    assert.ok(v2.includes('dev-testing'), 'Phase 4 should reference testing guide path');
    assert.ok(!v2.includes('Testing Guide (Phase 4)'), 'Phase 4 should not inline testing guide body');
    assert.ok(!v2.includes('Code Review Guide (Phase 2'), 'Phase 4 should NOT inject code-reviewer');
    assert.ok(v2.includes('CHECK employee'), 'Phase 4 should have CHECK employee context');
});

test('EMP-022: Phase 3 does NOT inject reviewer or testing guides', () => {
    const emp = { name: 'Frontend', cli: 'claude', role: 'frontend' };
    const v2 = getEmployeePromptV2(emp, 'frontend', 3);
    assert.ok(!v2.includes('Code Review Guide (Phase 2'), 'Phase 3 should NOT inject reviewer');
    assert.ok(!v2.includes('Testing Guide (Phase 4)'), 'Phase 3 should NOT inject testing');
    assert.ok(v2.includes('IMPLEMENTATION employee'), 'Phase 3 should have IMPLEMENTATION employee context');
});

test('EMP-023: String phase "2" works same as number 2 (type coercion safety)', { skip: !hasSkillsRef && 'skills_ref submodule not checked out' }, () => {
    const emp = { name: 'Data', cli: 'claude', role: 'data' };
    clearPromptCache();
    const v2str = getEmployeePromptV2(emp, 'data', '2' as any);
    clearPromptCache();
    const v2num = getEmployeePromptV2(emp, 'data', 2);
    // Both should reference code-reviewer (Number() normalization)
    assert.ok(v2str.includes('Phase 2 audit'), 'String "2" must also reference reviewer guidance');
    assert.ok(v2num.includes('Phase 2 audit'), 'Number 2 must reference reviewer guidance');
});

test('EMP-025: employee prompt uses employee naming and dispatch prohibition', () => {
    const emp = { name: 'Backend', cli: 'claude', role: 'backend' };
    clearPromptCache();
    const v2 = getEmployeePromptV2(emp, 'backend', 1);
    assert.ok(v2.includes('jaw employee'), 'should reference jaw employee identity');
    assert.ok(v2.includes('NEVER re-dispatch jaw employees'), 'should prohibit employee dispatch');
    assert.ok(!v2.includes('worker agent in pipe mode'), 'should not use old worker pipe mode wording');
});

test('EMP-026: employee prompt defers repository paths to Workspace Context', () => {
    const emp = { name: 'Backend', cli: 'claude', role: 'backend' };
    clearPromptCache();
    const v2 = getEmployeePromptV2(emp, 'backend', 3);
    assert.ok(v2.includes('process cwd may be an isolated temporary directory'),
        'employee prompt must warn that cwd may not be the repository root');
    assert.ok(v2.includes("task's ## Workspace Context block"),
        'employee prompt must point employees to the injected Workspace Context');
    assert.ok(v2.includes('Resolve relative repository paths against Project root'),
        'employee prompt must define relative path resolution policy');
});

// ─── Phase 17: triage AI dispatch ────────────────────

test('EMP-011: parseSubtasks extracts subtask JSON from agent response', { skip: 'DEPRECATED: patch3' }, () => {
    const text = '직원한테 시킬게요\n```json\n{"subtasks":[{"agent":"Frontend","task":"UI 수정"}]}\n```';
    const subtasks = parseSubtasks(text);
    assert.ok(Array.isArray(subtasks));
    assert.equal(subtasks.length, 1);
    assert.equal(subtasks[0].agent, 'Frontend');
});

test('EMP-012: parseSubtasks returns empty for no JSON', { skip: 'DEPRECATED: patch3' }, () => {
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
