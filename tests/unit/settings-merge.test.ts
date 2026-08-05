// Phase 9.4: settings patch merge 단위 테스트
// src/settings-merge.js 가 생성되면 통과 (server.js에서 로직 추출 예정)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettingsPatch, sanitizeSettingsInput } from '../../src/core/settings-merge.ts';

// ─── perCli deep merge ──────────────────────────────

test('SM-001: perCli deep merge preserves existing effort', () => {
    const current = { perCli: { copilot: { model: 'a', effort: 'high' } } };
    const next = mergeSettingsPatch(current, { perCli: { copilot: { model: 'b' } } });
    assert.equal(next.perCli.copilot.model, 'b');
    assert.equal(next.perCli.copilot.effort, 'high');
});

test('SM-002: perCli adds new CLI without removing others', () => {
    const current = { perCli: { claude: { model: 'opus' } } };
    const next = mergeSettingsPatch(current, { perCli: { codex: { model: 'o3' } } });
    assert.equal(next.perCli.claude.model, 'opus');
    assert.equal(next.perCli.codex.model, 'o3');
});

// ─── activeOverrides deep merge ─────────────────────

test('SM-003: activeOverrides deep merge preserves sibling keys', () => {
    const current = { activeOverrides: { codex: { model: 'o3', effort: 'medium' } } };
    const next = mergeSettingsPatch(current, { activeOverrides: { codex: { model: 'o4' } } });
    assert.equal(next.activeOverrides.codex.model, 'o4');
    assert.equal(next.activeOverrides.codex.effort, 'medium');
});

// ─── top-level fields ────────────────────────────────

test('SM-004: top-level scalar fields are replaced', () => {
    const current = { cli: 'claude', permissions: 'safe' };
    const next = mergeSettingsPatch(current, { permissions: 'auto' });
    assert.equal(next.permissions, 'auto');
    assert.equal(next.cli, 'claude'); // 기존 값 유지
});

test('SM-005: empty patch returns original', () => {
    const current = { cli: 'claude', perCli: { claude: { model: 'opus' } } };
    const next = mergeSettingsPatch(current, {});
    assert.deepEqual(next, current);
});

test('SM-006: tui deep merge preserves sibling keys', () => {
    const current = {
        tui: {
            pasteCollapseLines: 2,
            pasteCollapseChars: 160,
            keymapPreset: 'default',
            diffStyle: 'summary',
            themeSeed: 'jaw-default',
        },
    };
    const next = mergeSettingsPatch(current, { tui: { keymapPreset: 'vim' } });
    assert.equal(next.tui.keymapPreset, 'vim');
    assert.equal(next.tui.pasteCollapseLines, 2);
    assert.equal(next.tui.diffStyle, 'summary');
});

test('SM-007: jawCeo deep merge preserves saved voice settings siblings', () => {
    const current = { jawCeo: { openaiApiKey: 'sk-old', other: 'keep' } };
    const next = mergeSettingsPatch(current, { jawCeo: { openaiApiKey: 'sk-new' } });
    assert.equal(next.jawCeo.openaiApiKey, 'sk-new');
    assert.equal(next.jawCeo.other, 'keep');
});

test('SM-008: telegramHub deep merge preserves callback siblings', () => {
    const current = { telegramHub: { mode: 'hub-member', hubCallbackUrl: 'http://127.0.0.1:24576' } };
    const next = mergeSettingsPatch(current, { telegramHub: { mode: 'standalone' } });
    assert.deepEqual(next.telegramHub, { mode: 'standalone', hubCallbackUrl: 'http://127.0.0.1:24576' });
});

test('SM-009: runtime.codexApp merge preserves siblings at both depths', () => {
    const current = {
        runtime: {
            sibling: { keep: true },
            codexApp: { multiplex: false, probeOwned: 'keep' },
        },
    };
    const next = mergeSettingsPatch(current, { runtime: { codexApp: { multiplex: true } } });
    assert.deepEqual(next.runtime, {
        sibling: { keep: true },
        codexApp: { multiplex: true, probeOwned: 'keep' },
    });
    assert.equal(current.runtime.codexApp.multiplex, false, 'candidate merge must not mutate current settings');
});

test('SM-010: shared sanitizer separates execution default from persistence shape', () => {
    const absent = sanitizeSettingsInput({ cli: 'codex-app' }, 'boot');
    assert.equal(absent.value.runtime.codexApp.multiplex, false);
    assert.equal(absent.persistenceShape, 'absent');

    const explicit = sanitizeSettingsInput({
        runtime: { codexApp: { multiplex: false } },
    }, 'watch');
    assert.equal(explicit.value.runtime.codexApp.multiplex, false);
    assert.equal(explicit.persistenceShape, 'present');
});

test('SM-011: shared sanitizer strips laneMode and classifies invalid multiplex', () => {
    const api = sanitizeSettingsInput({
        runtime: { codexApp: { laneMode: 'native', multiplex: 'true', keep: 1 } },
    }, 'api');
    assert.deepEqual(api.serverOwnedPaths, ['runtime.codexApp.laneMode']);
    assert.deepEqual(api.invalidPaths, ['runtime.codexApp.multiplex']);
    assert.deepEqual(api.value.runtime.codexApp, { keep: 1 });
});
