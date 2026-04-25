import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CLI_REGISTRY,
    CLI_KEYS,
    DEFAULT_CLI,
    buildDefaultPerCli,
    buildModelChoicesByCli,
} from '../../src/cli/registry.ts';

// ─── Structure validation ────────────────────────────

test('CLI_KEYS contains exactly 5 known entries', () => {
    assert.deepEqual(CLI_KEYS.sort(), ['claude', 'codex', 'copilot', 'gemini', 'opencode']);
});

test('DEFAULT_CLI is claude', () => {
    assert.equal(DEFAULT_CLI, 'claude');
});

test('every CLI entry has required fields', () => {
    for (const key of CLI_KEYS) {
        const entry = CLI_REGISTRY[key];
        assert.ok(entry, `CLI_REGISTRY["${key}"] is missing`);
        assert.equal(typeof entry.label, 'string', `${key}.label must be string`);
        assert.equal(typeof entry.binary, 'string', `${key}.binary must be string`);
        assert.equal(typeof entry.defaultModel, 'string', `${key}.defaultModel must be string`);
        assert.ok(Array.isArray(entry.models), `${key}.models must be array`);
        assert.ok(entry.models.length > 0, `${key}.models must not be empty`);
        assert.ok(Array.isArray(entry.efforts), `${key}.efforts must be array`);
    }
});

test('every CLI defaultModel is included in its models list', () => {
    for (const key of CLI_KEYS) {
        const entry = CLI_REGISTRY[key];
        assert.ok(
            entry.models.includes(entry.defaultModel),
            `${key}.defaultModel "${entry.defaultModel}" not found in models list`
        );
    }
});

test('registry defaults for gemini and opencode are updated', () => {
    assert.equal(CLI_REGISTRY.gemini.defaultModel, 'gemini-3-flash-preview');
    assert.equal(CLI_REGISTRY.opencode.defaultModel, 'opencode-go/kimi-k2.6');
});

test('opencode registry exposes only the curated OpenCode Go models', () => {
    const models = CLI_REGISTRY.opencode.models;
    assert.deepEqual(models, [
        'opencode-go/glm-5.1',
        'opencode-go/kimi-k2.6',
        'opencode-go/mimo-v2.5-pro',
        'opencode-go/mimo-v2.5',
        'opencode-go/minimax-m2.7',
        'opencode-go/qwen3.6-plus',
        'opencode-go/deepseek-v4-pro',
        'opencode-go/deepseek-v4-flash',
    ]);
});

test('copilot registry excludes deprecated claude-opus-4.6-fast', () => {
    assert.ok(!CLI_REGISTRY.copilot.models.includes('claude-opus-4.6-fast'));
});

test('copilot registry excludes claude-opus-4.6', () => {
    assert.ok(!CLI_REGISTRY.copilot.models.includes('claude-opus-4.6'));
});

test('codex and copilot registries include gpt-5.4-mini', () => {
    assert.ok(CLI_REGISTRY.codex.models.includes('gpt-5.4-mini'), 'codex must expose gpt-5.4-mini');
    assert.ok(CLI_REGISTRY.copilot.models.includes('gpt-5.4-mini'), 'copilot must expose gpt-5.4-mini');
});

test('codex/copilot gpt-5.4-mini is listed right after gpt-5.4 (sensible ordering)', () => {
    for (const key of ['codex', 'copilot'] as const) {
        const models = CLI_REGISTRY[key].models;
        const idx54 = models.indexOf('gpt-5.4');
        const idxMini = models.indexOf('gpt-5.4-mini');
        assert.ok(idx54 >= 0 && idxMini >= 0, `${key} must include both gpt-5.4 and gpt-5.4-mini`);
        assert.equal(idxMini, idx54 + 1, `${key}: gpt-5.4-mini should follow gpt-5.4`);
    }
});

// ─── buildDefaultPerCli ──────────────────────────────

test('buildDefaultPerCli returns correct shape', () => {
    const defaults = buildDefaultPerCli();
    assert.equal(typeof defaults, 'object');
    for (const key of CLI_KEYS) {
        assert.ok(defaults[key], `defaults["${key}"] missing`);
        assert.equal(defaults[key].model, CLI_REGISTRY[key].defaultModel);
        assert.equal(typeof defaults[key].effort, 'string');
    }
});

test('buildDefaultPerCli returns a new object each call', () => {
    const a = buildDefaultPerCli();
    const b = buildDefaultPerCli();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
});

// ─── buildModelChoicesByCli ──────────────────────────

test('buildModelChoicesByCli returns models for each CLI', () => {
    const choices = buildModelChoicesByCli();
    for (const key of CLI_KEYS) {
        assert.ok(Array.isArray(choices[key]), `choices["${key}"] must be array`);
        assert.deepEqual(choices[key], [...CLI_REGISTRY[key].models]);
    }
});

test('buildModelChoicesByCli returns independent copies', () => {
    const a = buildModelChoicesByCli();
    const b = buildModelChoicesByCli();
    a.claude.push('test-model');
    assert.ok(!b.claude.includes('test-model'), 'modifying one copy should not affect another');
});
