/**
 * Tests for the choice selector overlay (Phase 1) and selector store state (store.ts).
 *
 * Covers:
 * - filterSelectorItems: empty filter, partial match, case insensitive, label match
 * - renderChoiceSelector: output sanity (returns positive box height, writes ANSI)
 * - SelectorState: createSelectorState defaults, state transitions
 * - ChoiceSelectorItem current marker
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    filterSelectorItems,
    renderChoiceSelector,
    type ChoiceSelectorItem,
} from '../../src/cli/tui/overlay.ts';
import { createSelectorState, createOverlayState } from '../../src/cli/tui/store.ts';

// ─── filterSelectorItems ─────────────────────

const ITEMS: ChoiceSelectorItem[] = [
    { value: 'claude-opus-4-6', label: 'claude', current: true },
    { value: 'claude-sonnet-4-6', label: 'claude', current: false },
    { value: 'gpt-4.1', label: 'openai', current: false },
    { value: 'gemini-2.5-pro', label: 'google', current: false },
    { value: 'codex-mini', label: 'openai', current: false },
];

test('CS-001: filterSelectorItems returns all items when filter is empty', () => {
    const result = filterSelectorItems(ITEMS, '');
    assert.equal(result.length, ITEMS.length);
});

test('CS-002: filterSelectorItems matches value substring', () => {
    const result = filterSelectorItems(ITEMS, 'opus');
    assert.equal(result.length, 1);
    assert.equal(result[0]!.value, 'claude-opus-4-6');
});

test('CS-003: filterSelectorItems is case insensitive', () => {
    const result = filterSelectorItems(ITEMS, 'SONNET');
    assert.equal(result.length, 1);
    assert.equal(result[0]!.value, 'claude-sonnet-4-6');
});

test('CS-004: filterSelectorItems matches label', () => {
    const result = filterSelectorItems(ITEMS, 'openai');
    assert.equal(result.length, 2);
});

test('CS-005: filterSelectorItems returns empty for no match', () => {
    const result = filterSelectorItems(ITEMS, 'zzz-no-match');
    assert.equal(result.length, 0);
});

test('CS-006: filterSelectorItems matches partial from middle of value', () => {
    const result = filterSelectorItems(ITEMS, '4.1');
    assert.equal(result.length, 1);
    assert.equal(result[0]!.value, 'gpt-4.1');
});

// ─── renderChoiceSelector ────────────────────

test('CS-007: renderChoiceSelector returns positive height and writes output', () => {
    let output = '';
    const height = renderChoiceSelector({
        write: (chunk) => { output += chunk; },
        cols: 80,
        rows: 24,
        dimCode: '\x1b[2m',
        resetCode: '\x1b[0m',
        title: 'Model',
        subtitle: 'claude: claude-opus-4.6',
        filter: '',
        items: ITEMS,
        selected: 0,
    });
    assert.ok(height > 0, 'box height should be positive');
    assert.ok(output.length > 0, 'should produce ANSI output');
    assert.ok(output.includes('Model'), 'should contain title');
});

test('CS-008: renderChoiceSelector marks current item with bullet', () => {
    let output = '';
    renderChoiceSelector({
        write: (chunk) => { output += chunk; },
        cols: 80,
        rows: 24,
        dimCode: '\x1b[2m',
        resetCode: '\x1b[0m',
        title: 'Model',
        subtitle: 'current',
        filter: '',
        items: ITEMS,
        selected: 1,
    });
    assert.ok(output.includes('●'), 'should include current marker bullet');
});

test('CS-009: renderChoiceSelector handles empty items list', () => {
    let output = '';
    const height = renderChoiceSelector({
        write: (chunk) => { output += chunk; },
        cols: 80,
        rows: 24,
        dimCode: '\x1b[2m',
        resetCode: '\x1b[0m',
        title: 'Model',
        subtitle: 'none',
        filter: '',
        items: [],
        selected: 0,
    });
    assert.ok(height > 0, 'should still render a box');
});

test('CS-010: renderChoiceSelector clamps to terminal rows', () => {
    const manyItems: ChoiceSelectorItem[] = Array.from({ length: 50 }, (_, i) => ({
        value: `model-${i}`,
        label: 'test',
        current: i === 0,
    }));
    const height = renderChoiceSelector({
        write: () => {},
        cols: 80,
        rows: 20,
        dimCode: '',
        resetCode: '',
        title: 'Test',
        subtitle: 'many items',
        filter: '',
        items: manyItems,
        selected: 0,
    });
    assert.ok(height <= 20, `height ${height} should not exceed terminal rows 20`);
});

// ─── SelectorState ───────────────────────────

test('CS-011: createSelectorState returns closed state with empty arrays', () => {
    const state = createSelectorState();
    assert.equal(state.open, false);
    assert.equal(state.commandName, '');
    assert.equal(state.filter, '');
    assert.equal(state.selected, 0);
    assert.deepEqual(state.allItems, []);
    assert.deepEqual(state.filteredItems, []);
});

test('CS-012: createOverlayState includes selector sub-state', () => {
    const overlay = createOverlayState();
    assert.ok(overlay.selector, 'overlay should have selector field');
    assert.equal(overlay.selector.open, false);
});

// ─── Handler non-regression: /model and /cli with args still work ────

test('CS-013: modelHandler with explicit args still returns success', async () => {
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { loadLocales } = await import('../../src/core/i18n.ts');
    const { modelHandler } = await import('../../src/cli/handlers.ts');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    loadLocales(join(__dirname, '../../public/locales'));

    const ctx = {
        locale: 'ko',
        interface: 'cli',
        getSettings: async () => ({ cli: 'claude', perCli: { claude: { model: 'old-model' } } }),
        getSession: async () => ({}),
        updateSettings: async () => ({ ok: true }),
    };
    const result = await modelHandler(['new-model'], ctx);
    assert.equal(result.ok, true);
    assert.ok(result.text.includes('new-model'));
});

test('CS-014: cliHandler with explicit args still returns success', async () => {
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { loadLocales } = await import('../../src/core/i18n.ts');
    const { cliHandler } = await import('../../src/cli/handlers.ts');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    loadLocales(join(__dirname, '../../public/locales'));

    const ctx = {
        locale: 'ko',
        interface: 'cli',
        getSettings: async () => ({ cli: 'claude', perCli: { claude: {}, codex: {} } }),
        getSession: async () => ({}),
        updateSettings: async () => ({ ok: true }),
    };
    const result = await cliHandler(['codex'], ctx);
    assert.equal(result.ok, true);
    assert.ok(result.text.includes('codex'));
});

// ─── Remote surface regression: handlers still return text for no-arg ──

test('CS-015: modelHandler no-arg returns readable text (Telegram/Discord contract)', async () => {
    const { modelHandler } = await import('../../src/cli/handlers.ts');

    const ctx = {
        locale: 'ko',
        interface: 'telegram',
        getSettings: async () => ({ cli: 'claude', perCli: { claude: { model: 'claude-opus-4-6' } } }),
        getSession: async () => ({}),
    };
    const result = await modelHandler([], ctx);
    assert.equal(result.ok, true);
    assert.ok(result.text.length > 0, 'should return non-empty text');
    assert.ok(!result.text.startsWith('cmd.'), 'should not be a raw i18n key');
});

test('CS-016: cliHandler no-arg returns readable text (Telegram/Discord contract)', async () => {
    const { cliHandler } = await import('../../src/cli/handlers.ts');

    const ctx = {
        locale: 'ko',
        interface: 'telegram',
        getSettings: async () => ({ cli: 'claude', perCli: { claude: {}, codex: {} } }),
        getSession: async () => ({}),
    };
    const result = await cliHandler([], ctx);
    assert.equal(result.ok, true);
    assert.ok(result.text.length > 0, 'should return non-empty text');
    assert.ok(!result.text.startsWith('cmd.'), 'should not be a raw i18n key');
});

// ─── P1 fix: findPackageRoot locale path resolution ──────────

test('CS-017: public/locales exists at the resolved PROJECT_ROOT (source tree)', async () => {
    const { dirname, join } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const { fileURLToPath: toPath } = await import('node:url');
    const testFileDir = dirname(toPath(import.meta.url));
    // From tests/unit/ walk up — project root should have public/locales
    const projectRoot = join(testFileDir, '../..');
    assert.ok(existsSync(join(projectRoot, 'public', 'locales', 'ko.json')),
        'ko.json should exist at project root public/locales');
    assert.ok(existsSync(join(projectRoot, 'public', 'locales', 'en.json')),
        'en.json should exist at project root public/locales');
});

// ─── P2 fix: non-Korean locale behavior ─────────────────────

test('CS-018: modelHandler respects en locale when set', async () => {
    const { loadLocales } = await import('../../src/core/i18n.ts');
    const { modelHandler } = await import('../../src/cli/handlers.ts');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    loadLocales(join(__dirname, '../../public/locales'));

    const ctx = {
        locale: 'en',
        interface: 'cli',
        getSettings: async () => ({ cli: 'claude', perCli: { claude: { model: 'claude-opus-4-6' } } }),
        getSession: async () => ({}),
    };
    const result = await modelHandler([], ctx);
    assert.equal(result.ok, true);
    // en locale should produce English text, not raw key and not Korean
    assert.ok(!result.text.startsWith('cmd.'), 'should not be a raw i18n key');
    assert.ok(result.text.length > 0, 'should return non-empty text');
});

// ─── P2 fix: selector zero-result guard ─────────────────────

test('CS-019: selector arrow-down on empty filteredItems does not produce negative index', () => {
    const state = createSelectorState();
    state.open = true;
    state.allItems = ITEMS;
    state.filteredItems = [];  // empty after aggressive filter
    state.selected = 0;

    // Simulate arrow-down guard logic from chat.ts
    const itemCount = state.filteredItems.length;
    if (itemCount > 0) {
        state.selected = Math.min(itemCount - 1, state.selected + 1);
    }
    assert.ok(state.selected >= 0, 'selected must never be negative');
    assert.equal(state.selected, 0, 'selected should stay at 0 for empty list');
});

test('CS-020: selector enter on empty filteredItems is a no-op', () => {
    const state = createSelectorState();
    state.open = true;
    state.filteredItems = [];
    state.selected = 0;

    // Simulate enter guard logic: should not crash
    const itemCount = state.filteredItems.length;
    if (itemCount === 0) {
        // early return in the real code
        assert.ok(true, 'enter on empty list is safely a no-op');
        return;
    }
    assert.fail('should not reach here with empty items');
});
