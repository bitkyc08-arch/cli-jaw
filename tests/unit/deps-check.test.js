// Phase 8.5 / 9.7: 의존성 검증 semver helper 단위 테스트
import test from 'node:test';
import assert from 'node:assert/strict';

// semver helper 로직 (check-deps-offline.mjs에서 사용하는 것과 동일)
function semver(v) {
    const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
}

function lt(a, b) {
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
    return false;
}

function gte(a, b) { return !lt(a, b); }

function inRange(v, lo, hi) {
    const sv = semver(v);
    return sv && gte(sv, semver(lo)) && lt(sv, semver(hi));
}

// ─── semver parse ────────────────────────────────────

test('DV-001: semver parses valid version', () => {
    assert.deepEqual(semver('8.19.0'), [8, 19, 0]);
    assert.deepEqual(semver('3.3.2'), [3, 3, 2]);
    assert.deepEqual(semver('2.7.0'), [2, 7, 0]);
});

test('DV-002: semver returns null for invalid', () => {
    assert.equal(semver('invalid'), null);
    assert.equal(semver(''), null);
    assert.equal(semver(null), null);
});

// ─── lt comparison ───────────────────────────────────

test('DV-003: lt comparison works', () => {
    assert.ok(lt([8, 16, 0], [8, 17, 1]), '8.16.0 < 8.17.1');
    assert.ok(!lt([8, 19, 0], [8, 17, 1]), '8.19.0 is NOT < 8.17.1');
    assert.ok(!lt([8, 17, 1], [8, 17, 1]), 'equal is NOT lt');
    assert.ok(lt([2, 6, 6], [2, 6, 7]), '2.6.6 < 2.6.7');
});

// ─── ws advisory range ──────────────────────────────

test('DV-004: ws 8.19.0 is safe (outside >=8.0.0 <8.17.1)', () => {
    assert.ok(!inRange('8.19.0', '8.0.0', '8.17.1'));
});

test('DV-005: ws 8.16.0 is vulnerable (inside >=8.0.0 <8.17.1)', () => {
    assert.ok(inRange('8.16.0', '8.0.0', '8.17.1'));
});

test('DV-006: ws 8.17.1 is safe (boundary excluded)', () => {
    assert.ok(!inRange('8.17.1', '8.0.0', '8.17.1'));
});

// ─── node-fetch advisory range ──────────────────────

test('DV-007: node-fetch 3.3.2 is safe (outside >=3.0.0 <3.1.1)', () => {
    assert.ok(!inRange('3.3.2', '3.0.0', '3.1.1'));
});

test('DV-008: node-fetch 3.0.5 is vulnerable (inside >=3.0.0 <3.1.1)', () => {
    assert.ok(inRange('3.0.5', '3.0.0', '3.1.1'));
});

test('DV-009: node-fetch 2.6.6 is vulnerable (< 2.6.7)', () => {
    const sv = semver('2.6.6');
    assert.ok(lt(sv, semver('2.6.7')));
});

test('DV-010: node-fetch 2.7.0 is safe (>= 2.6.7)', () => {
    const sv = semver('2.7.0');
    assert.ok(!lt(sv, semver('2.6.7')));
});
