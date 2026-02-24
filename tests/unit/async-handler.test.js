// Phase 9.2: asyncHandler 단위 테스트
// src/http/async-handler.js 가 생성되면 통과
import test from 'node:test';
import assert from 'node:assert/strict';
import { asyncHandler } from '../../src/http/async-handler.js';

test('AH-001: passes sync handler through', async () => {
    let called = false;
    const handler = asyncHandler((req, res) => { called = true; });
    await handler({}, {}, () => { });
    assert.ok(called);
});

test('AH-002: catches async error and calls next', async () => {
    let caught = null;
    const handler = asyncHandler(async () => {
        throw new Error('boom');
    });
    await handler({}, {}, (e) => { caught = e; });
    assert.equal(caught.message, 'boom');
});

test('AH-003: preserves statusCode on errors', async () => {
    let caught = null;
    const handler = asyncHandler(async () => {
        const e = new Error('forbidden');
        e.statusCode = 403;
        throw e;
    });
    await handler({}, {}, (e) => { caught = e; });
    assert.equal(caught.statusCode, 403);
    assert.equal(caught.message, 'forbidden');
});

test('AH-004: passes req/res/next to handler', async () => {
    let receivedReq, receivedRes;
    const handler = asyncHandler((req, res) => {
        receivedReq = req;
        receivedRes = res;
    });
    const fakeReq = { method: 'GET' };
    const fakeRes = { json: () => { } };
    await handler(fakeReq, fakeRes, () => { });
    assert.equal(receivedReq, fakeReq);
    assert.equal(receivedRes, fakeRes);
});
