import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateSettings } from '../../src/core/config.ts';

test('CfgM-001: migrateSettings normalizes legacy Claude perCli model values', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {
            claude: { model: 'claude-sonnet-4-6[1m]', effort: 'high' },
            codex: { model: 'gpt-5.4', effort: 'medium' },
        },
    });
    assert.equal(s.perCli.claude.model, 'sonnet[1m]');
    assert.equal(s.perCli.claude.effort, 'high');
    assert.equal(s.perCli.codex.model, 'gpt-5.4');
});

test('CfgM-002: migrateSettings normalizes legacy Claude activeOverrides model values', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {},
        activeOverrides: {
            claude: { model: 'claude-opus-4-6' },
        },
    });
    assert.equal(s.activeOverrides.claude.model, 'opus');
});

test('CfgM-003: migrateSettings normalizes Claude memory.model when cli is claude', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {},
        memory: { cli: 'claude', model: 'claude-sonnet-4-6' },
    });
    assert.equal(s.memory.model, 'sonnet');
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

test('CfgM-007: migrateSettings normalizes all 4 legacy values across perCli', () => {
    const s = migrateSettings({
        cli: 'claude',
        perCli: {
            claude: { model: 'claude-sonnet-4-6' },
        },
        activeOverrides: {
            claude: { model: 'claude-opus-4-6[1m]' },
        },
    });
    assert.equal(s.perCli.claude.model, 'sonnet');
    assert.equal(s.activeOverrides.claude.model, 'opus[1m]');
});
