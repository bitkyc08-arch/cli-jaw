// Phase 9.2: HTTP response helpers 단위 테스트
// src/http/response.js 가 생성되면 통과
import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail } from '../../src/http/response.js';

function mockRes() {
    let sent = null, status = 200;
    return {
        status(s) { status = s; return this; },
        json(d) { sent = d; },
        get sent() { return sent; },
        get statusCode() { return status; },
    };
}

test('HR-001: ok wraps data in { ok: true, data }', () => {
    const r = mockRes();
    ok(r, { id: 1 });
    assert.deepEqual(r.sent, { ok: true, data: { id: 1 } });
});

test('HR-002: ok with extra fields merges them', () => {
    const r = mockRes();
    ok(r, [1, 2, 3], { total: 3 });
    assert.deepEqual(r.sent, { ok: true, data: [1, 2, 3], total: 3 });
});

test('HR-003: ok with null data', () => {
    const r = mockRes();
    ok(r, null);
    assert.deepEqual(r.sent, { ok: true, data: null });
});

test('HR-004: fail sets status and error message', () => {
    const r = mockRes();
    fail(r, 400, 'bad_request');
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.sent, { ok: false, error: 'bad_request' });
});

test('HR-005: fail with extra fields', () => {
    const r = mockRes();
    fail(r, 404, 'not_found', { path: '/api/x' });
    assert.equal(r.statusCode, 404);
    assert.deepEqual(r.sent, { ok: false, error: 'not_found', path: '/api/x' });
});

test('HR-006: fail defaults to 500 style', () => {
    const r = mockRes();
    fail(r, 500, 'internal_error');
    assert.equal(r.statusCode, 500);
    assert.equal(r.sent.ok, false);
    assert.equal(r.sent.error, 'internal_error');
});
