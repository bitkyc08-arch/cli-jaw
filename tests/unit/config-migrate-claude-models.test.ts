import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateSettings } from '../../src/core/config.ts';

test('CfgM-001: migrateSettings preserves user-typed Claude full-ID perCli model', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {
            claude: { model: 'claude-sonnet-4-6[1m]', effort: 'high' },
            codex: { model: 'gpt-5.4', effort: 'medium' },
        },
    });
    assert.equal(s.perCli.claude.model, 'claude-sonnet-4-6[1m]');
    assert.equal(s.perCli.claude.effort, 'high');
    assert.equal(s.perCli.codex.model, 'gpt-5.4');
});

test('CfgM-002: migrateSettings preserves full-ID Claude activeOverrides verbatim', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {},
        activeOverrides: {
            claude: { model: 'claude-opus-4-6' },
        },
    });
    assert.equal(s.activeOverrides.claude.model, 'claude-opus-4-6');
});

test('CfgM-003: migrateSettings preserves Claude memory.model verbatim when cli is claude', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {},
        memory: { cli: 'claude', model: 'claude-sonnet-4-6' },
    });
    assert.equal(s.memory.model, 'claude-sonnet-4-6');
});

test('CfgM-004: migrateSettings does NOT normalize memory.model when cli is not claude', () => {
    const s = migrateSettings({
        cli: 'codex',
        perCli: {},
        memory: { cli: 'codex', model: 'gpt-5.4' },
    });
    assert.equal(s.memory.model, 'gpt-5.4');
});

test('CfgM-005: migrateSettings preserves pinned Haiku ID verbatim', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {
            claude: { model: 'claude-haiku-4-5-20251001' },
        },
    });
    assert.equal(s.perCli.claude.model, 'claude-haiku-4-5-20251001');
});

test('CfgM-006: migrateSettings is idempotent on already-alias canonical values', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {
            claude: { model: 'sonnet[1m]', effort: 'medium' },
        },
        activeOverrides: {
            claude: { model: 'opus' },
        },
        memory: { cli: 'claude', model: 'haiku' },
    });
    assert.equal(s.perCli.claude.model, 'sonnet[1m]');
    assert.equal(s.activeOverrides.claude.model, 'opus');
    assert.equal(s.memory.model, 'haiku');
});

test('CfgM-007: migrateSettings preserves sonnet/opus full IDs verbatim', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {
            claude: { model: 'claude-sonnet-4-6' },
        },
        activeOverrides: {
            claude: { model: 'claude-opus-4-6[1m]' },
        },
    });
    assert.equal(s.perCli.claude.model, 'claude-sonnet-4-6');
    assert.equal(s.activeOverrides.claude.model, 'claude-opus-4-6[1m]');
});

test('CfgM-009: migrateSettings preserves claude-opus-4-7 verbatim across PUT cycle', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: { claude: { model: 'claude-opus-4-7', effort: 'medium' } },
        activeOverrides: { claude: { model: 'claude-opus-4-7[1m]' } },
        memory: { cli: 'claude', model: 'claude-opus-4-7' },
    });
    assert.equal(s.perCli.claude.model, 'claude-opus-4-7');
    assert.equal(s.activeOverrides.claude.model, 'claude-opus-4-7[1m]');
    assert.equal(s.memory.model, 'claude-opus-4-7');
});

test('CfgM-008: migrateSettings rewrites deprecated Copilot fast opus model', () => {
    const s = migrateSettings({
        cli: 'copilot',
        perCli: {
            copilot: { model: 'claude-opus-4.6-fast', effort: 'high' },
        },
        activeOverrides: {
            copilot: { model: 'claude-opus-4.6-fast' },
        },
        memory: { cli: 'copilot', model: 'claude-opus-4.6-fast' },
    });
    assert.equal(s.perCli.copilot.model, 'claude-opus-4.6');
    assert.equal(s.activeOverrides.copilot.model, 'claude-opus-4.6');
    assert.equal(s.memory.model, 'claude-opus-4.6');
});
