// #prompt-cache round-1 — slimmed A-1 / builder contracts.
// Guards the conservative externalization: strong MUST-READ skill stubs
// replace inlined bodies, retained sections stay, and the template cannot
// silently regrow past its budget.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const a1Src = readFileSync(join(root, 'src/prompt/templates/a1-system.md'), 'utf8');
const builderSrc = readFileSync(join(root, 'src/prompt/builder.ts'), 'utf8');
const skillsSrc = readFileSync(join(root, 'src/prompt/templates/skills.md'), 'utf8');

test('PSC-001: externalized sections carry strong MUST-READ skill stubs', () => {
    assert.ok(a1Src.includes('{{JAW_HOME}}/skills/search/SKILL.md'), 'search stub must point at the skill path');
    assert.ok(/BEFORE any external\/web\/X\/real-time search, you MUST read/.test(a1Src), 'search stub must force a read');
    assert.ok(a1Src.includes('{{JAW_HOME}}/skills/telegram-send/SKILL.md'), 'telegram stub must point at the skill path');
    assert.ok(a1Src.includes('{{JAW_HOME}}/skills/structured-renderers/SKILL.md'), 'structured renderer stub must point at the skill path');
    assert.ok(a1Src.includes('compose-block-v1') && a1Src.includes('variants[]'), 'compose-block schema guard must stay in A-1');
    assert.ok(a1Src.includes('type/title/body'), 'compose-block shorthand drift guard must stay in A-1');
    assert.ok(a1Src.includes('{{JAW_HOME}}/skills/diagram/SKILL.md'), 'diagram stub must point at the skill path');
    assert.ok(a1Src.includes('MUST read `{{JAW_HOME}}/skills/diagram/SKILL.md` before writing any output'), 'diagram read stays mandatory');
});

test('PSC-002: retained backbone sections are untouched by the slim', () => {
    assert.ok(a1Src.includes('## Desktop / Browser Control (MANDATORY)'), 'desktop control stays (deferred by decision)');
    assert.ok(a1Src.includes('### Compact Handoff Interpretation'), 'compact interpretation stays (always-on by decision)');
    // round-2 (260610 phase 2, interview Q1=(a)): Goal Mode Rules moved to the
    // continuation prompt (single owner); A-1 keeps the command list + pointer.
    assert.ok(a1Src.includes('## Goal System'), 'goal CLI command list stays in A-1');
    assert.ok(!a1Src.includes('### Goal Mode Rules'), 'goal mode rules moved to continuation (round-1 always-on decision superseded)');
    assert.ok(a1Src.includes('Korean "검색" intent guard'), 'korean search guard heading stays');
});

test('PSC-003: diagram capability listing left the template and the builder', () => {
    assert.ok(!a1Src.includes('{{DIAGRAM_CAPABILITIES}}'), 'capabilities var must be gone from the template');
    assert.ok(!a1Src.includes('{{DIAGRAM_REFERENCES}}'), 'references var must be gone from the template');
    assert.ok(!builderSrc.includes("vars['DIAGRAM_CAPABILITIES']"), 'builder must not compute the capabilities var');
});

test('PSC-004: PABCD guide is a path contract, not an inlined skill body', () => {
    assert.ok(builderSrc.includes('BEFORE running any PABCD phase, you MUST read the full workflow guide'), 'must force reading the skill');
    const orchestrationIdx = builderSrc.indexOf('## PABCD Orchestration Guide');
    assert.ok(orchestrationIdx > 0, 'guide heading stays');
    const block = builderSrc.slice(orchestrationIdx, orchestrationIdx + 1600);
    assert.ok(!block.includes('readFileSync(pabcdPath'), 'skill body must not be inlined');
    assert.ok(block.includes('cli-jaw orchestrate I|P|A|B|C|D'), 'transition command summary stays inline');
    // devlog 260624_goal_work_phase_pabcd_loop, Slice 6: pin the loop / work-phase semantics
    // so the inline guide cannot silently regress to single-cycle wording.
    assert.ok(block.includes('one full P→A→B→C→D per work-phase'), 'inline guide must state one full cycle per work-phase');
    assert.ok(block.includes('a work-phase is an outcome slice, not a PABCD letter'), 'inline guide must disambiguate work-phase vs PABCD-phase');
    assert.ok(block.includes('re-enters P (D→IDLE→P)'), 'inline guide must state goal-mode D→IDLE→P re-entry');
    assert.ok(block.includes('never rubber-stamp to advance'), 'inline guide must carry the anti-skip rule');
    assert.ok(block.includes('design-only PABCD pass'), 'inline guide must mention design-only Phase 0 pass');
});

test('PSC-005: ref skill catalog stays a lookup instruction, never a listing', () => {
    assert.ok(skillsSrc.includes('cli-jaw skill list --inactive'), 'browse command stays');
    assert.ok(skillsSrc.includes('ls {{JAW_HOME}}/skills_ref/'), 'ls lookup stays');
    assert.ok(!skillsSrc.includes('{{REF_SKILLS_LIST}}'), 'no per-skill ref listing variable');
});

test('PSC-006: A-1 template stays under its size budget', () => {
    // 32,558 chars before the slim; regression guard so sections do not
    // silently regrow inline instead of pointing at skills.
    assert.ok(a1Src.length <= 31000, `a1-system.md is ${a1Src.length} chars — over the 31,000 budget`);
});
