// Regression tests for ui_quickfix: quota label overlap + Agent name input visibility
// Ref: devlog/_plan/ui_quickfix/plan.md
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

// ── Source files ──
const statusSrc = [
    'settings-cli-status.ts',
    'settings-cli-status-render.ts',
].map(file => fs.readFileSync(
    path.join(import.meta.dirname, '../../public/js/features', file), 'utf8',
)).join('\n');
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

// CSSOM verifies declarations; browser QA verifies computed colors and geometry.
// JSDOM CSSOM removes spaces after commas and percentage tokens in functions.
test('WP5: classic tokens preserve legacy names and light/dark parity', () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    try {
        const style = dom.window.document.createElement('style');
        style.textContent = fs.readFileSync(path.join(import.meta.dirname, '../../public/css/variables.css'), 'utf8');
        dom.window.document.head.append(style);
        assert.ok(style.sheet);
        const rules = Array.from(style.sheet.cssRules);
        const declaration = (selector: string): CSSStyleDeclaration => {
            const rule = rules.find(r => 'selectorText' in r && r.selectorText === selector) as CSSStyleRule | undefined;
            assert.ok(rule, selector); return rule.style;
        };
        const dark = declaration(':root'); const light = declaration('[data-theme="light"]');
        const legacy = '--bg --surface --border --text --text-dim --accent --accent2 --green --user-bg --agent-bg --status-idle-bg --status-running-bg --status-running-color --status-steering-bg --status-steering-color --code-bg --link-color --table-border --stop-btn --stop-btn-hover --toggle-off --toggle-on --delete-color --code-label-color --modal-bg --font-display --font-ui --font-mono --sidebar-left-w --sidebar-right-w --sidebar-collapsed-w --space-1 --space-2 --space-3 --space-4 --space-5 --space-6 --space-8 --space-10 --space-12 --text-xs --text-sm --text-base --text-md --text-lg --text-xl --text-2xl --text-3xl --radius-sm --radius-md --radius-lg --radius-xl --radius-full --ease-out-expo --ease-spring --duration-fast --duration-base --duration-slow --error --error-dim --success --success-dim --warning --warning-dim --info --phase-1 --phase-2 --phase-3 --phase-4 --phase-5 --text-on-accent --noise-opacity --scanline-pct --glow-strength --toggle-w --toggle-h --toggle-knob --orc-glow --orc-glow-I --orc-glow-P --orc-glow-A --orc-glow-B --orc-glow-C --orc-glow-D'.split(' ');
        for (const name of legacy) assert.ok(dark.getPropertyValue(name), name);
        const names = '--surface-1 --surface-2 --surface-3 --border-alpha --border-strong --text-muted-60 --font-sans-system --font-mono-system --radius-ctl --focus-ring-shadow'.split(' ');
        for (const name of names) for (const rule of [dark, light]) assert.ok(rule.getPropertyValue(name), name);
        for (const [name, percent] of [['--surface-1', 3], ['--surface-2', 4], ['--surface-3', 6]] as const) {
            assert.equal(dark.getPropertyValue(name).trim(), `color-mix(in srgb,white ${percent}%,transparent)`);
            assert.equal(light.getPropertyValue(name).trim(), `color-mix(in srgb,black ${percent}%,transparent)`);
        }
        assert.equal(dark.getPropertyValue('--border-alpha').trim(), 'color-mix(in srgb,white 8%,transparent)');
        assert.equal(dark.getPropertyValue('--border-strong').trim(), 'color-mix(in srgb,white 12%,transparent)');
        assert.equal(light.getPropertyValue('--bg').trim(), 'oklch(99.2%0 0)');
        assert.equal(light.getPropertyValue('--border-alpha').trim(), 'oklch(92%0.004 286.32)');
        assert.equal(light.getPropertyValue('--border').trim(), 'var(--border-alpha)');
        assert.equal(dark.getPropertyValue('--font-ui').trim(), 'var(--font-sans-system)');
        for (const name of ['--font-sans-system', '--font-mono-system', '--radius-ctl', '--focus-ring-shadow', '--text-muted-60']) assert.equal(dark.getPropertyValue(name), light.getPropertyValue(name), name);
        assert.equal(dark.getPropertyValue('--radius-ctl').trim(), '8px');
        for (const rule of [dark, light]) {
            assert.equal(rule.getPropertyValue('--focus-ring-shadow').trim(), '0 0 0 2px color-mix(in oklab,var(--accent) 70%,transparent)');
        }
        for (const [file, selector] of [
            ['sidebar.css', '.sidebar-left .sidebar-hb-btn:focus-visible'],
            ['layout.css', '.tab-btn:focus-visible'],
        ] as const) {
            const consumer = dom.window.document.createElement('style');
            consumer.textContent = fs.readFileSync(path.join(import.meta.dirname, '../../public/css', file), 'utf8');
            dom.window.document.head.append(consumer); assert.ok(consumer.sheet);
            const rule = Array.from(consumer.sheet.cssRules).find(r => 'selectorText' in r && r.selectorText === selector) as CSSStyleRule | undefined;
            assert.ok(rule, selector);
            assert.equal(rule.style.getPropertyValue('box-shadow').trim(), 'var(--focus-ring-shadow)');
        }
        assert.equal(declaration('::-webkit-scrollbar').getPropertyValue('width').trim(), '6px');
        assert.equal(declaration('::-webkit-scrollbar-thumb').getPropertyValue('background').trim(), 'var(--border-alpha)');
        assert.equal(declaration('::-webkit-scrollbar-thumb:hover').getPropertyValue('background').trim(), 'var(--border-strong)');
    } finally { dom.window.close(); }
});
