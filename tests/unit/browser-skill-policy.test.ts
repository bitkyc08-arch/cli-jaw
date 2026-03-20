import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserSkillPath = join(__dirname, '../../skills_ref/browser/SKILL.md');
const visionSkillPath = join(__dirname, '../../skills_ref/vision-click/SKILL.md');
const hasBrowserSkill = fs.existsSync(browserSkillPath);
const hasVisionSkill = fs.existsSync(visionSkillPath);

test('BSP-001: browser skill documents --agent automation mode', { skip: !hasBrowserSkill && 'skills_ref submodule not checked out' }, () => {
    const browserSkill = fs.readFileSync(browserSkillPath, 'utf8');
    assert.match(browserSkill, /browser start --agent/);
    assert.match(browserSkill, /debug console/i);
});

test('BSP-002: vision-click skill distinguishes automation and manual browser start', { skip: !hasVisionSkill && 'skills_ref submodule not checked out' }, () => {
    const visionSkill = fs.readFileSync(visionSkillPath, 'utf8');
    assert.match(visionSkill, /browser start --agent/);
    assert.match(visionSkill, /manual interactive sessions/i);
});
