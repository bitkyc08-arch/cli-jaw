import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillPath = join(root, 'skills_ref/web-ai/SKILL.md');
const browserSkillPath = join(root, 'skills_ref/browser/SKILL.md');

test('WAIS-001: web-ai skill exists and documents structured prompt shape', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    assert.match(skill, /structured question envelope/);
    assert.match(skill, /\[SYSTEM\]/);
    assert.match(skill, /## Project/);
    assert.match(skill, /## Constraints/);
});

test('WAIS-002: web-ai skill documents 30_browser-style workflow and fallback policy', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    assert.match(skill, /active-tab -> snapshot -> act -> snapshot -> verify/);
    assert.match(skill, /vision-click.*fallback/i);
    assert.match(skill, /refs are latest-snapshot scoped/i);
});

test('WAIS-003: web-ai skill keeps PRD32 first-slice scope narrow', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    assert.match(skill, /ChatGPT/);
    assert.match(skill, /inline prompt/);
    assert.match(skill, /Gemini \/ Deep Think/);
    assert.match(skill, /file upload/);
});

test('WAIS-003b: web-ai skill documents context packaging before upload', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    assert.match(skill, /context-dry-run/);
    assert.match(skill, /context-render/);
    assert.match(skill, /--context-from-files/);
    assert.match(skill, /--file` still means live browser upload/);
});

test('WAIS-004: browser skill delegates AI workflows to web-ai skill', () => {
    const browserSkill = fs.readFileSync(browserSkillPath, 'utf8');
    assert.match(browserSkill, /For ChatGPT web-ai workflows, use the `web-ai` skill/);
});
