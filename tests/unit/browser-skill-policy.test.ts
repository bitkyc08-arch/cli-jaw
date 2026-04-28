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
    assert.match(browserSkill, /headless/i);
});

test('BSP-003: browser skill separates planned runtime delta from current commands', { skip: !hasBrowserSkill && 'skills_ref submodule not checked out' }, () => {
    const browserSkill = fs.readFileSync(browserSkillPath, 'utf8');
    assert.match(browserSkill, /## Current Commands/);
    assert.match(browserSkill, /## Planned Runtime Delta/);
    assert.match(browserSkill, /snapshot --interactive --max-nodes 30/);
    assert.match(browserSkill, /screenshot --clip 0 0 320 180 --json/);
    assert.match(browserSkill, /wait-for-selector/);
    assert.match(browserSkill, /not current commands/i);
});

test('BSP-004: browser skill documents snapshot-scoped refs and vision fallback policy', { skip: !hasBrowserSkill && 'skills_ref submodule not checked out' }, () => {
    const browserSkill = fs.readFileSync(browserSkillPath, 'utf8');
    assert.match(browserSkill, /latest-snapshot scoped/i);
    assert.match(browserSkill, /Ref IDs are short-lived/i);
    assert.match(browserSkill, /vision-click.*fallback/i);
});

test('BSP-002: vision-click skill documents screenshot-based coordinate click', { skip: !hasVisionSkill && 'skills_ref submodule not checked out' }, () => {
    const visionSkill = fs.readFileSync(visionSkillPath, 'utf8');
    assert.match(visionSkill, /screenshot/i);
    assert.match(visionSkill, /coordinate/i);
});
