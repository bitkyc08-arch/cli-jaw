import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateSettings } from '../../src/core/config.ts';

test('CfgM-001: migrateSettings normalizes legacy Claude perCli model values', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {
            claude: { model: 'sonnet[1m]', effort: 'high' },
            codex: { model: 'gpt-5.4', effort: 'medium' },
        },
    });
    assert.equal(s.perCli.claude.model, 'claude-sonnet-4-6[1m]');
    assert.equal(s.perCli.claude.effort, 'high');
    assert.equal(s.perCli.codex.model, 'gpt-5.4');
});

test('CfgM-002: migrateSettings preserves canonical Claude activeOverrides model values', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {},
        activeOverrides: {
            claude: { model: 'claude-opus-4-6' },
        },
    });
    // claude-opus-4-6 is now canonical — not migrated to alias
    assert.equal(s.activeOverrides.claude.model, 'claude-opus-4-6');
});

test('CfgM-003: migrateSettings normalizes Claude memory.model when cli is claude', () => {
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

test('CfgM-005: migrateSettings preserves pinned Haiku in perCli', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {
            claude: { model: 'claude-haiku-4-5-20251001' },
        },
    });
    assert.equal(s.perCli.claude.model, 'claude-haiku-4-5-20251001');
});

test('CfgM-006: migrateSettings is idempotent on already-canonical values', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {
            claude: { model: 'claude-sonnet-4-6[1m]', effort: 'medium' },
        },
        activeOverrides: {
            claude: { model: 'claude-opus-4-6' },
        },
        memory: { cli: 'claude', model: 'claude-haiku-4-5' },
    });
    assert.equal(s.perCli.claude.model, 'claude-sonnet-4-6[1m]');
    assert.equal(s.activeOverrides.claude.model, 'claude-opus-4-6');
    assert.equal(s.memory.model, 'claude-haiku-4-5');
});

test('CfgM-007: migrateSettings normalizes sonnet legacy values, preserves opus canonical', () => {
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
