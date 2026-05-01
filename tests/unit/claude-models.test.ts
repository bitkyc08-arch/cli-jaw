import test from 'node:test';
import assert from 'node:assert/strict';
import {
    migrateLegacyClaudeValue,
    getDefaultClaudeModel,
    getDefaultClaudeChoices,
    getClaudeModelKind,
    isClaudeCanonicalModel,
    CLAUDE_CANONICAL_MODELS,
    CLAUDE_LEGACY_VALUE_MAP,
} from '../../src/cli/claude-models.ts';

// ─── Canonical set ───────────────────────────────────

test('CM-001: canonical set contains exactly 4 short aliases', () => {
    assert.equal(CLAUDE_CANONICAL_MODELS.length, 4);
    assert.deepEqual([...CLAUDE_CANONICAL_MODELS].sort(), ['haiku', 'opus', 'sonnet', 'sonnet[1m]']);
});

test('CM-002: isClaudeCanonicalModel accepts all canonical values', () => {
    for (const m of CLAUDE_CANONICAL_MODELS) {
        assert.ok(isClaudeCanonicalModel(m), `${m} should be canonical`);
    }
});

test('CM-003: isClaudeCanonicalModel rejects non-canonical values', () => {
    assert.equal(isClaudeCanonicalModel('claude-sonnet-4-6'), false);
    assert.equal(isClaudeCanonicalModel('gpt-5.4'), false);
    assert.equal(isClaudeCanonicalModel(''), false);
});

// ─── Legacy migration ────────────────────────────────

test('CM-004: migrateLegacyClaudeValue passes full Claude IDs through unchanged', () => {
    assert.equal(migrateLegacyClaudeValue('claude-sonnet-4-6[1m]'), 'claude-sonnet-4-6[1m]');
    assert.equal(migrateLegacyClaudeValue('claude-opus-4-6[1m]'), 'claude-opus-4-6[1m]');
    assert.equal(migrateLegacyClaudeValue('claude-opus-4-7'), 'claude-opus-4-7');
    assert.equal(migrateLegacyClaudeValue('claude-opus-4-7[1m]'), 'claude-opus-4-7[1m]');
});

test('CM-005: migrateLegacyClaudeValue passes pinned Haiku/Sonnet IDs through unchanged', () => {
    assert.equal(migrateLegacyClaudeValue('claude-sonnet-4-6'), 'claude-sonnet-4-6');
    assert.equal(migrateLegacyClaudeValue('claude-opus-4-6'), 'claude-opus-4-6');
    assert.equal(migrateLegacyClaudeValue('claude-haiku-4-5'), 'claude-haiku-4-5');
    assert.equal(migrateLegacyClaudeValue('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
});

test('CM-007: migrateLegacyClaudeValue preserves unknown explicit values', () => {
    assert.equal(
        migrateLegacyClaudeValue('claude-sonnet-4-7-preview[1m]'),
        'claude-sonnet-4-7-preview[1m]',
    );
});

test('CM-008: migrateLegacyClaudeValue is idempotent on canonical alias values', () => {
    for (const m of CLAUDE_CANONICAL_MODELS) {
        assert.equal(migrateLegacyClaudeValue(m), m);
    }
});

// ─── Legacy map ──────────────────────────────────────

test('CM-009: legacy map is empty by default (passthrough policy)', () => {
    assert.equal(Object.keys(CLAUDE_LEGACY_VALUE_MAP).length, 0);
});

// ─── Helpers ─────────────────────────────────────────

test('CM-011: getDefaultClaudeModel returns sonnet alias', () => {
    assert.equal(getDefaultClaudeModel(), 'sonnet');
});

test('CM-012: getDefaultClaudeChoices returns aliases + verified pinned full IDs', () => {
    const choices = getDefaultClaudeChoices();
    assert.deepEqual([...choices].sort(), [
        'claude-haiku-4-5',
        'claude-opus-4-6',
        'claude-opus-4-6[1m]',
        'claude-opus-4-7',
        'claude-opus-4-7[1m]',
        'claude-sonnet-4-6',
        'claude-sonnet-4-6[1m]',
        'haiku',
        'opus',
        'sonnet',
        'sonnet[1m]',
    ]);
});

test('CM-013: getClaudeModelKind classifies correctly with empty legacy map', () => {
    assert.equal(getClaudeModelKind('sonnet'), 'canonical');
    assert.equal(getClaudeModelKind('opus'), 'canonical');
    assert.equal(getClaudeModelKind('claude-sonnet-4-6'), 'explicit');
    assert.equal(getClaudeModelKind('claude-opus-4-6[1m]'), 'explicit');
    assert.equal(getClaudeModelKind('claude-opus-4-7'), 'explicit');
    assert.equal(getClaudeModelKind('claude-sonnet-4-7-preview'), 'explicit');
    assert.equal(getClaudeModelKind('default'), 'explicit');
});
