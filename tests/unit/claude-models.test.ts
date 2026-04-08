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

test('CM-001: canonical set contains exactly 5 aliases', () => {
    assert.equal(CLAUDE_CANONICAL_MODELS.length, 5);
    assert.deepEqual([...CLAUDE_CANONICAL_MODELS].sort(), ['haiku', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]']);
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

test('CM-004: migrateLegacyClaudeValue maps historical 1M values to aliases', () => {
    assert.equal(migrateLegacyClaudeValue('claude-sonnet-4-6[1m]'), 'sonnet[1m]');
    assert.equal(migrateLegacyClaudeValue('claude-opus-4-6[1m]'), 'opus[1m]');
});

test('CM-005: migrateLegacyClaudeValue maps historical non-1M full names to aliases', () => {
    assert.equal(migrateLegacyClaudeValue('claude-sonnet-4-6'), 'sonnet');
    assert.equal(migrateLegacyClaudeValue('claude-opus-4-6'), 'opus');
});

test('CM-006: migrateLegacyClaudeValue preserves pinned Haiku', () => {
    assert.equal(
        migrateLegacyClaudeValue('claude-haiku-4-5-20251001'),
        'claude-haiku-4-5-20251001',
    );
});

test('CM-007: migrateLegacyClaudeValue preserves unknown explicit values', () => {
    assert.equal(
        migrateLegacyClaudeValue('claude-sonnet-4-7-preview[1m]'),
        'claude-sonnet-4-7-preview[1m]',
    );
});

test('CM-008: migrateLegacyClaudeValue is idempotent on canonical values', () => {
    for (const m of CLAUDE_CANONICAL_MODELS) {
        assert.equal(migrateLegacyClaudeValue(m), m);
    }
});

// ─── Legacy map ──────────────────────────────────────

test('CM-009: legacy map covers exactly 4 historical values', () => {
    assert.equal(Object.keys(CLAUDE_LEGACY_VALUE_MAP).length, 4);
    assert.ok('claude-sonnet-4-6' in CLAUDE_LEGACY_VALUE_MAP);
    assert.ok('claude-opus-4-6' in CLAUDE_LEGACY_VALUE_MAP);
    assert.ok('claude-sonnet-4-6[1m]' in CLAUDE_LEGACY_VALUE_MAP);
    assert.ok('claude-opus-4-6[1m]' in CLAUDE_LEGACY_VALUE_MAP);
});

test('CM-010: Haiku is intentionally excluded from legacy map', () => {
    assert.ok(!('claude-haiku-4-5-20251001' in CLAUDE_LEGACY_VALUE_MAP));
});

// ─── Helpers ─────────────────────────────────────────

test('CM-011: getDefaultClaudeModel returns sonnet', () => {
    assert.equal(getDefaultClaudeModel(), 'sonnet');
});

test('CM-012: getDefaultClaudeChoices returns all canonical values', () => {
    const choices = getDefaultClaudeChoices();
    assert.deepEqual([...choices].sort(), ['haiku', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]']);
});

test('CM-013: getClaudeModelKind classifies correctly', () => {
    assert.equal(getClaudeModelKind('sonnet'), 'canonical');
    assert.equal(getClaudeModelKind('opus[1m]'), 'canonical');
    assert.equal(getClaudeModelKind('claude-sonnet-4-6'), 'legacy');
    assert.equal(getClaudeModelKind('claude-sonnet-4-7-preview'), 'explicit');
    assert.equal(getClaudeModelKind('default'), 'explicit');
});
