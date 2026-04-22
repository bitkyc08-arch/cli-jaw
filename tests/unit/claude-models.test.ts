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

test('CM-001: canonical set contains exactly 7 models', () => {
    assert.equal(CLAUDE_CANONICAL_MODELS.length, 7);
    assert.deepEqual([...CLAUDE_CANONICAL_MODELS].sort(), ['claude-haiku-4-5', 'claude-opus-4-6', 'claude-opus-4-6[1m]', 'claude-opus-4-7', 'claude-opus-4-7[1m]', 'claude-sonnet-4-6', 'claude-sonnet-4-6[1m]']);
});

test('CM-002: isClaudeCanonicalModel accepts all canonical values', () => {
    for (const m of CLAUDE_CANONICAL_MODELS) {
        assert.ok(isClaudeCanonicalModel(m), `${m} should be canonical`);
    }
});

test('CM-003: isClaudeCanonicalModel rejects non-canonical values', () => {
    assert.equal(isClaudeCanonicalModel('sonnet'), false);
    assert.equal(isClaudeCanonicalModel('gpt-5.4'), false);
    assert.equal(isClaudeCanonicalModel(''), false);
});

// ─── Legacy migration ────────────────────────────────

test('CM-004: migrateLegacyClaudeValue maps short aliases to full canonical names', () => {
    assert.equal(migrateLegacyClaudeValue('sonnet[1m]'), 'claude-sonnet-4-6[1m]');
    assert.equal(migrateLegacyClaudeValue('opus[1m]'), 'claude-opus-4-6[1m]');
});

test('CM-005: migrateLegacyClaudeValue maps short sonnet/opus/haiku to full names', () => {
    assert.equal(migrateLegacyClaudeValue('sonnet'), 'claude-sonnet-4-6');
    assert.equal(migrateLegacyClaudeValue('opus'), 'claude-opus-4-6');
    assert.equal(migrateLegacyClaudeValue('haiku'), 'claude-haiku-4-5');
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

test('CM-009: legacy map covers exactly 5 short aliases', () => {
    assert.equal(Object.keys(CLAUDE_LEGACY_VALUE_MAP).length, 5);
    assert.ok('sonnet' in CLAUDE_LEGACY_VALUE_MAP);
    assert.ok('sonnet[1m]' in CLAUDE_LEGACY_VALUE_MAP);
    assert.ok('opus' in CLAUDE_LEGACY_VALUE_MAP);
    assert.ok('opus[1m]' in CLAUDE_LEGACY_VALUE_MAP);
    assert.ok('haiku' in CLAUDE_LEGACY_VALUE_MAP);
});

test('CM-010: Haiku is intentionally excluded from legacy map', () => {
    assert.ok(!('claude-haiku-4-5-20251001' in CLAUDE_LEGACY_VALUE_MAP));
});

// ─── Helpers ─────────────────────────────────────────

test('CM-011: getDefaultClaudeModel returns claude-sonnet-4-6', () => {
    assert.equal(getDefaultClaudeModel(), 'claude-sonnet-4-6');
});

test('CM-012: getDefaultClaudeChoices returns all canonical values', () => {
    const choices = getDefaultClaudeChoices();
    assert.deepEqual([...choices].sort(), ['claude-haiku-4-5', 'claude-opus-4-6', 'claude-opus-4-6[1m]', 'claude-opus-4-7', 'claude-opus-4-7[1m]', 'claude-sonnet-4-6', 'claude-sonnet-4-6[1m]']);
});

test('CM-013: getClaudeModelKind classifies correctly', () => {
    assert.equal(getClaudeModelKind('claude-sonnet-4-6'), 'canonical');
    assert.equal(getClaudeModelKind('claude-opus-4-6[1m]'), 'canonical');
    assert.equal(getClaudeModelKind('sonnet'), 'legacy');
    assert.equal(getClaudeModelKind('claude-sonnet-4-7-preview'), 'explicit');
    assert.equal(getClaudeModelKind('default'), 'explicit');
});
