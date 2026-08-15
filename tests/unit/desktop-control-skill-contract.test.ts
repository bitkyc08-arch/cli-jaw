// #308: the public desktop-control skill and its registry entry must not
// regress to macOS-only, and must keep the two platform APIs distinct.
//
// These read the skills_ref submodule, so a skills change requires the gitlink
// to be bumped before root tests pass — which is the point: the shipped skill
// and the shipped prompt cannot drift apart silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const SKILL = path.join(ROOT, 'skills_ref/jaw-desktop-control/SKILL.md');
const CU_REF = path.join(ROOT, 'skills_ref/jaw-desktop-control/reference/computer-use.md');
const REGISTRY = path.join(ROOT, 'skills_ref/registry.json');

const hasSkills = fs.existsSync(SKILL);
const maybe = { skip: hasSkills ? false : 'skills_ref submodule not checked out' };

test('DCS-001: the skill no longer declares macOS as a hard system requirement', maybe, () => {
    const src = fs.readFileSync(SKILL, 'utf8');
    assert.doesNotMatch(src, /"system":\s*\[\s*"macOS"/, 'macOS must not be a hard requirement');
    assert.doesNotMatch(src, /^- macOS only\.$/m, 'the macOS-only precondition must be gone');
});

test('DCS-002: the registry entry does not require macOS', maybe, () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    const entry = registry.skills['jaw-desktop-control'];
    assert.ok(entry, 'jaw-desktop-control must exist in the registry');
    assert.ok(!entry.requires.system.includes('macOS'),
        'requiring macOS here re-gates Windows hosts out of Computer Use');
    assert.ok(entry.requires.system.includes('Google Chrome'), 'the Chrome requirement stays');
});

test('DCS-003: the reference documents the Windows window-scoped API', maybe, () => {
    const ref = fs.readFileSync(CU_REF, 'utf8');
    assert.match(ref, /list_windows\(\)/);
    assert.match(ref, /get_window_state/);
    assert.match(ref, /node_repl/);
    assert.match(ref, /get_app_state`?,? and `?select_text|no.*get_app_state/i,
        'the reference must say which macOS tools are absent on Windows');
});

test('DCS-004: the reference keeps the macOS app-scoped API', maybe, () => {
    const ref = fs.readFileSync(CU_REF, 'utf8');
    assert.match(ref, /get_app_state\(app\)/);
    assert.match(ref, /select_text/);
});

test('DCS-005: the two Windows false-success traps are documented', maybe, () => {
    const ref = fs.readFileSync(CU_REF, 'utf8');
    assert.match(ref, /list_apps\(\)[^\n]*without a working pipe|not a health signal/i);
    assert.match(ref, /not on the pipe/i);
});

test('DCS-006: the sandbox bypass is stated as an attended user choice, not a default', maybe, () => {
    const ref = fs.readFileSync(CU_REF, 'utf8');
    assert.match(ref, /dangerously-bypass-approvals-and-sandbox/);
    assert.match(ref, /never adds it automatically/i);
});
