// #prompt-cache round-1 — slimmed A-1 / builder contracts.
// Guards the conservative externalization: strong MUST-READ skill stubs
// replace inlined bodies, retained sections stay, and the template cannot
// silently regrow past its budget.

import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SKILLS_DIR } from '../../src/core/config.ts';
import { A2_PATH, getSystemPrompt, shouldIncludeDesktopControlSection } from '../../src/prompt/builder.ts';

const A2_MARKER = 'PSC-A2-BOUNDARY-7f21';

function runtimeA1(currentPrompt: string): string {
    mkdirSync(dirname(A2_PATH), { recursive: true });
    writeFileSync(A2_PATH, A2_MARKER, 'utf8');
    const prompt = getSystemPrompt({ currentPrompt, activeCli: 'codex-app', forDisk: false });
    const boundary = prompt.indexOf(`\n\n${A2_MARKER}`);
    assert.ok(boundary > 0, 'A2 marker must delimit the runtime A-1');
    return prompt.slice(0, boundary);
}

const root = join(import.meta.dirname, '..', '..');
const a1Src = readFileSync(join(root, 'src/prompt/templates/a1-system.md'), 'utf8');
const builderSrc = readFileSync(join(root, 'src/prompt/builder.ts'), 'utf8');
const skillsSrc = readFileSync(join(root, 'src/prompt/templates/skills.md'), 'utf8');

test('PSC-001: externalized sections carry strong MUST-READ skill stubs', () => {
    assert.ok(a1Src.includes('{{JAW_HOME}}/skills/jaw-search/SKILL.md'), 'search stub must point at the skill path');
    assert.ok(/BEFORE any external\/web\/X\/real-time search, you MUST read/.test(a1Src), 'search stub must force a read');
    assert.ok(a1Src.includes('{{JAW_HOME}}/skills/jaw-telegram-send/SKILL.md'), 'telegram stub must point at the skill path');
    assert.ok(a1Src.includes('{{JAW_HOME}}/skills/jaw-structured-renderers/SKILL.md'), 'structured renderer stub must point at the skill path');
    assert.ok(a1Src.includes('compose-block-v1') && a1Src.includes('variants[]'), 'compose-block schema guard must stay in A-1');
    assert.ok(a1Src.includes('type/title/body'), 'compose-block shorthand drift guard must stay in A-1');
    assert.ok(a1Src.includes('{{JAW_HOME}}/skills/jaw-diagram/SKILL.md'), 'diagram stub must point at the skill path');
    assert.ok(a1Src.includes('MUST read `{{JAW_HOME}}/skills/jaw-diagram/SKILL.md` before writing any output'), 'diagram read stays mandatory');
});

test('PSC-002: desktop control stays persisted but runtime routing is conditional', () => {
    assert.ok(a1Src.includes('## Desktop / Browser Control (MANDATORY)'), 'persisted A-1 keeps desktop control');
    assert.equal(shouldIncludeDesktopControlSection('브라우저에서 이 페이지를 확인해', 'codex-app'), true);
    assert.equal(shouldIncludeDesktopControlSection('릴리스 노트를 요약해', 'codex-app'), false);
    // An Office document is a file to produce, not an app to drive (verifier residual).
    assert.equal(shouldIncludeDesktopControlSection('Excel 파일 만들어', 'codex-app'), false);
    assert.equal(shouldIncludeDesktopControlSection('use Chrome to open it', 'codex-app'), true);
    assert.ok(a1Src.includes('### Compact Handoff Interpretation'), 'compact interpretation stays always-on');
    assert.ok(a1Src.includes('## Goal System'), 'goal CLI command list stays in A-1');
    assert.ok(!a1Src.includes('### Goal Mode Rules'), 'goal mode rules stay in continuation only');
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
    // pin the loop / work-phase semantics
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
    // Budget raised 31,000 → 35,000 for the critical-stance block and
    // exclusions-first dispatch constraint (4d8c54cc, 43c2a4f2).
    // Budget raised 35,000 → 36,000 for diagram-file default delivery
    // additions (260707 diagram-file storage + inlay).
    // Budget raised 36,000 → 37,100 for the #308 Computer Use platform
    // contract (§B.0). Windows is a genuinely different API surface, not a
    // variant, and an agent that calls the macOS tools there gets an opaque
    // `sky.get_app_state is not a function`. Only the routing decision lives
    // here; the pipe/session/SSH depth stays in the desktop-control skill.
    // Budget raised 37,100 → 37,800 for the #302/#310 Windows shell contract.
    // This one cannot live in a skill: writing a `.ps1` is plain scripting work
    // that never routes through desktop-control, and a BOM-less file corrupts
    // its own string literals before the script runs. It is a data-loss
    // invariant, so it belongs where every agent already looks.
    // Budget raised 37,800 → 38,100 for the #316 inbound-Slack-context line,
    // which teaches the agent to treat `[Slack]` and `[앞선 대화]` blocks as
    // data rather than instructions — a prompt-injection boundary that only
    // works if it is stated inline.
    // Budget raised 38,100 → 38,250 for #397. The old line actively told the agent
    // to omit `target`, and that instruction was the delivery bug: with no target
    // the send resolves to a single per-channel slot that any inbound message
    // overwrites, so a file built for one channel went to another. Reversing it
    // costs more characters than the wrong advice did, and the reason has to travel
    // with the rule — an agent told "always send target" without being told what
    // happens otherwise will drop it again the first time it is inconvenient.
    // Budget raised 38,250 → 38,750 for two lines that only work inline. The first
    // is the answer-shape rule: an agent that opens with a warm-up paragraph, blurs
    // what it verified against what it guessed, or answers past the question does
    // that in its FIRST sentence — before any skill read could correct it. The
    // second routes 윤문/답변 구성 to jaw-dev-write / jaw-dev-speech, and a routing
    // line the agent never sees routes nothing. The depth lives in those skills;
    // only the trigger is here.
    const alwaysOnA1 = runtimeA1('Summarize the release notes.');
    assert.ok(alwaysOnA1.length <= 38750,
        `runtime A-1 is ${alwaysOnA1.length} chars — over the 38,750 budget`);
});

test('PSC-007: getSystemPrompt includes desktop control for Korean browser intent', () => {
    const prompt = runtimeA1('브라우저에서 URL을 열고 화면 스크린샷을 확인해');
    assert.match(prompt, /## Desktop \/ Browser Control \(MANDATORY\)/);
});

test('PSC-008: getSystemPrompt excludes desktop control otherwise and saves at least 8,000 chars', () => {
    const included = runtimeA1('브라우저에서 이 페이지를 확인해');
    const excluded = runtimeA1('변경된 릴리스 노트를 세 문장으로 요약해');
    assert.doesNotMatch(excluded, /## Desktop \/ Browser Control \(MANDATORY\)/);
    assert.ok(included.length - excluded.length >= 8000,
        `desktop-control removal saved only ${included.length - excluded.length} chars`);
});

test('PSC-009: a routed active skill with desktop/browser metadata includes the section', () => {
    const skillDir = join(SKILLS_DIR, 'window-driver');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
        '---',
        'name: window-driver',
        'description: "Controls desktop windows through native UI"',
        '---',
    ].join('\n'), 'utf8');
    assert.match(runtimeA1('Use $window-driver to finish this task.'),
        /## Desktop \/ Browser Control \(MANDATORY\)/);
});
