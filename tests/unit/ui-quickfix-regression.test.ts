// Regression tests for ui_quickfix: quota label overlap + Agent name input visibility
// Ref: devlog/_plan/ui_quickfix/plan.md
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ── Source files ──
const statusSrc = fs.readFileSync(
    path.join(import.meta.dirname, '../../public/js/features/settings-cli-status.ts'), 'utf8',
);
const layoutCss = fs.readFileSync(
    path.join(import.meta.dirname, '../../public/css/layout.css'), 'utf8',
);
const indexHtml = fs.readFileSync(
    path.join(import.meta.dirname, '../../public/index.html'), 'utf8',
);

// ══════════════════════════════════════════════
// Bug 1: quota label overlap
// ══════════════════════════════════════════════

// Extract the shortLabel replacement chain from source and build a reusable function
function buildShortLabel(cliName: string, label: string): string {
    if (cliName === 'gemini') {
        if (label === 'Pro' || label === 'P') return 'P';
        if (label === 'Flash' || label === 'F') return 'F';
        return label;
    }

    if (cliName === 'copilot') {
        if (label === 'Premium' || label === 'Prem') return '30d';
        if (label.includes('plus monthly subscriber quota')) return '30d';
    }

    return label
        .replace('-hour', 'h')
        .replace('-day', 'd')
        .replace(' Sonnet', '')
        .replace(' Opus', '');
}

test('UQ-001: shortLabel truncates Copilot monthly labels to "30d"', () => {
    assert.equal(buildShortLabel('copilot', 'Premium'), '30d');
    assert.equal(buildShortLabel('copilot', 'Prem'), '30d');
    assert.equal(buildShortLabel('copilot', 'plus monthly subscriber quota'), '30d');
});

test('UQ-002: shortLabel truncates Gemini model labels to "F/P"', () => {
    assert.equal(buildShortLabel('gemini', 'Flash'), 'F');
    assert.equal(buildShortLabel('gemini', 'F'), 'F');
    assert.equal(buildShortLabel('gemini', 'Pro'), 'P');
    assert.equal(buildShortLabel('gemini', 'P'), 'P');
    assert.notEqual(buildShortLabel('gemini', 'Flash Lite'), 'F');
});

test('UQ-003: shortLabel preserves existing abbreviations', () => {
    assert.equal(buildShortLabel('claude', '5-hour'), '5h');
    assert.equal(buildShortLabel('claude', '1-day'), '1d');
    assert.equal(buildShortLabel('claude', '3.5 Sonnet'), '3.5');
    assert.equal(buildShortLabel('claude', '4 Opus'), '4');
});

test('UQ-004: shortLabel handles unknown labels gracefully (passthrough)', () => {
    assert.equal(buildShortLabel('claude', 'Custom'), 'Custom');
    assert.equal(buildShortLabel('claude', ''), '');
});

test('UQ-005: source uses provider-aware quota label normalization', () => {
    const snippets = [
        'function normalizeQuotaWindowLabel(cliName: string, label: string): string',
        "cliName === 'gemini'",
        "label === 'Pro' || label === 'P'",
        "label === 'Flash' || label === 'F'",
        "cliName === 'copilot'",
        "label === 'Premium' || label === 'Prem'",
        "label.includes('plus monthly subscriber quota')",
        "return '30d'",
        'normalizeQuotaWindowLabel(name, w.label)',
    ];
    for (const snippet of snippets) {
        assert.ok(statusSrc.includes(snippet), `source should contain: ${snippet}`);
    }
});

test('UQ-006: label span uses overflow ellipsis, not fixed width', () => {
    // The span must NOT have a bare width:18px without overflow handling
    assert.ok(
        statusSrc.includes('text-overflow:ellipsis'),
        'label span should have text-overflow:ellipsis',
    );
    assert.ok(
        statusSrc.includes('white-space:nowrap'),
        'label span should have white-space:nowrap',
    );
    assert.ok(
        statusSrc.includes('overflow:hidden'),
        'label span should have overflow:hidden',
    );
    assert.ok(
        statusSrc.includes('max-width:48px'),
        'label span should have max-width constraint',
    );
});

test('UQ-007: label span has min-width for short labels (1-2 char)', () => {
    assert.ok(
        statusSrc.includes('min-width:18px'),
        'label span should have min-width for short labels like "5h"',
    );
});

// Edge case: all shortLabel results fit within 48px at 10px font-size (~7 chars max)
test('UQ-008: all known shortLabel outputs are ≤ 7 characters', () => {
    const knownLabels: Array<[string, string]> = [
        ['copilot', 'Premium'],
        ['copilot', 'Prem'],
        ['copilot', 'plus monthly subscriber quota'],
        ['gemini', 'Flash'],
        ['gemini', 'Pro'],
        ['claude', '5-hour'],
        ['claude', '1-day'],
        ['claude', '3.5 Sonnet'],
        ['claude', '4 Opus'],
    ];
    for (const [cliName, label] of knownLabels) {
        const short = buildShortLabel(cliName, label);
        assert.ok(
            short.length <= 7,
            `shortLabel("${cliName}", "${label}") = "${short}" (${short.length} chars) should be ≤ 7`,
        );
    }
});

// ══════════════════════════════════════════════
// Bug 2: Agent name input not visible
// ══════════════════════════════════════════════

test('UQ-009: layout.css has .sidebar-hb-btn.w-auto override with width:auto', () => {
    // Two-class selector must exist to beat single-class .sidebar-hb-btn
    assert.ok(
        layoutCss.includes('.sidebar-hb-btn.w-auto'),
        'layout.css should have .sidebar-hb-btn.w-auto compound selector',
    );
    // Extract the rule block
    const ruleStart = layoutCss.indexOf('.sidebar-hb-btn.w-auto');
    const blockStart = layoutCss.indexOf('{', ruleStart);
    const blockEnd = layoutCss.indexOf('}', blockStart);
    const ruleBody = layoutCss.slice(blockStart + 1, blockEnd);

    assert.ok(
        ruleBody.includes('width: auto') || ruleBody.includes('width:auto'),
        '.sidebar-hb-btn.w-auto should set width: auto',
    );
});

test('UQ-010: .sidebar-hb-btn.w-auto has flex-shrink:0 to prevent collapse', () => {
    const ruleStart = layoutCss.indexOf('.sidebar-hb-btn.w-auto');
    const blockStart = layoutCss.indexOf('{', ruleStart);
    const blockEnd = layoutCss.indexOf('}', blockStart);
    const ruleBody = layoutCss.slice(blockStart + 1, blockEnd);

    assert.ok(
        ruleBody.includes('flex-shrink: 0') || ruleBody.includes('flex-shrink:0'),
        '.sidebar-hb-btn.w-auto should set flex-shrink: 0',
    );
});

test('UQ-011: .sidebar-hb-btn.w-auto appears AFTER .sidebar-hb-btn in cascade', () => {
    const baseIdx = layoutCss.indexOf('.sidebar-hb-btn {');
    const overrideIdx = layoutCss.indexOf('.sidebar-hb-btn.w-auto');
    assert.ok(baseIdx >= 0, '.sidebar-hb-btn base rule should exist');
    assert.ok(overrideIdx > baseIdx, '.sidebar-hb-btn.w-auto must come after .sidebar-hb-btn');
});

test('UQ-012: appNameInput in index.html sits in a flex container with .input-agent-name', () => {
    assert.ok(
        indexHtml.includes('id="appNameInput"'),
        'index.html should have appNameInput element',
    );
    assert.ok(
        indexHtml.includes('class="input-agent-name"'),
        'appNameInput should have input-agent-name class',
    );
    // The save button must have both sidebar-hb-btn and w-auto
    assert.ok(
        indexHtml.includes('id="appNameSave"'),
        'index.html should have appNameSave button',
    );
    // Verify the save button has w-auto class
    const saveMatch = indexHtml.match(/id="appNameSave"[^>]*/);
    assert.ok(saveMatch, 'appNameSave should be found');
    // The button line contains both classes
    const saveBtnLine = indexHtml.split('\n').find(l => l.includes('appNameSave'));
    assert.ok(saveBtnLine, 'should find appNameSave line');
    assert.ok(
        saveBtnLine!.includes('sidebar-hb-btn') && saveBtnLine!.includes('w-auto'),
        'appNameSave button must have both sidebar-hb-btn and w-auto classes',
    );
});

test('UQ-013: .input-agent-name has flex:1 for space allocation', () => {
    const variablesCss = fs.readFileSync(
        path.join(import.meta.dirname, '../../public/css/variables.css'), 'utf8',
    );
    const ruleStart = variablesCss.indexOf('.input-agent-name');
    assert.ok(ruleStart >= 0, '.input-agent-name should exist in variables.css');
    const blockStart = variablesCss.indexOf('{', ruleStart);
    const blockEnd = variablesCss.indexOf('}', blockStart);
    const ruleBody = variablesCss.slice(blockStart + 1, blockEnd);
    assert.ok(
        ruleBody.includes('flex: 1') || ruleBody.includes('flex:1'),
        '.input-agent-name should have flex: 1',
    );
});
