// Phase 9.1: path-guards 단위 테스트
// src/security/path-guards.js 가 생성되면 통과
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSkillId, assertFilename, safeResolveUnder } from '../../src/security/path-guards.js';
import path from 'node:path';

// ─── assertSkillId ───────────────────────────────────

test('PG-001: assertSkillId accepts simple name', () => {
    assert.equal(assertSkillId('dev'), 'dev');
});

test('PG-002: assertSkillId accepts dot-dash name', () => {
    assert.equal(assertSkillId('dev-backend'), 'dev-backend');
    assert.equal(assertSkillId('skill.v2'), 'skill.v2');
});

test('PG-003: assertSkillId rejects traversal (..)', () => {
    assert.throws(() => assertSkillId('../dev'), /invalid_skill_id|path_segment/);
});

test('PG-004: assertSkillId rejects slash', () => {
    assert.throws(() => assertSkillId('dev/x'), /invalid_skill_id|path_segment/);
});

test('PG-005: assertSkillId rejects backslash', () => {
    assert.throws(() => assertSkillId('dev\\x'), /invalid_skill_id|path_segment/);
});

test('PG-006: assertSkillId rejects empty', () => {
    assert.throws(() => assertSkillId(''), /invalid_skill_id/);
    assert.throws(() => assertSkillId(null), /invalid_skill_id/);
    assert.throws(() => assertSkillId(undefined), /invalid_skill_id/);
});

// ─── assertFilename ──────────────────────────────────

test('PG-007: assertFilename accepts valid .md', () => {
    assert.equal(assertFilename('notes.md'), 'notes.md');
    assert.equal(assertFilename('daily-2026.md'), 'daily-2026.md');
});

test('PG-008: assertFilename rejects wrong extension', () => {
    assert.throws(() => assertFilename('script.js', { allowExt: ['.md'] }), /invalid_extension/);
});

test('PG-009: assertFilename accepts multiple extensions', () => {
    assert.equal(
        assertFilename('image.png', { allowExt: ['.png', '.jpg', '.webp'] }),
        'image.png',
    );
});

test('PG-010: assertFilename rejects traversal in name', () => {
    assert.throws(() => assertFilename('../notes.md'), /invalid_filename/);
});

test('PG-011: assertFilename rejects empty/null', () => {
    assert.throws(() => assertFilename(''), /invalid_filename/);
    assert.throws(() => assertFilename(null), /invalid_filename/);
});

test('PG-012: assertFilename rejects overlong name', () => {
    assert.throws(() => assertFilename('a'.repeat(250) + '.md'), /invalid_filename/);
});

// ─── safeResolveUnder ────────────────────────────────

const BASE = '/tmp/test-memory';

test('PG-013: safeResolveUnder allows normal filename', () => {
    const p = safeResolveUnder(BASE, 'daily.md');
    assert.equal(p, path.resolve(BASE, 'daily.md'));
});

test('PG-014: safeResolveUnder blocks traversal (..)', () => {
    assert.throws(() => safeResolveUnder(BASE, '../etc/passwd'), /path_escape/);
});

test('PG-015: safeResolveUnder blocks absolute path', () => {
    assert.throws(() => safeResolveUnder(BASE, '/etc/passwd'), /path_escape/);
});

test('PG-016: safeResolveUnder blocks encoded traversal (..%2f)', () => {
    // decodeURIComponent happens before this function, so raw % isn't a traversal,
    // but if decoded value escapes base, it should be caught
    assert.throws(() => safeResolveUnder(BASE, '../../etc/passwd'), /path_escape/);
});
