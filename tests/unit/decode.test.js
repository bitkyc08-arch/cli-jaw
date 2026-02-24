// Phase 9.1: decode 단위 테스트
// src/security/decode.js 가 생성되면 통과
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFilenameSafe } from '../../src/security/decode.js';

test('DC-001: decodes normal UTF-8 filename', () => {
    const decoded = decodeFilenameSafe('%ED%95%9C%EA%B8%80.md');
    assert.equal(decoded, '한글.md');
});

test('DC-002: passes through plain ASCII filename', () => {
    assert.equal(decodeFilenameSafe('image.png'), 'image.png');
});

test('DC-003: defaults to upload.bin on null/undefined', () => {
    assert.equal(decodeFilenameSafe(null), 'upload.bin');
    assert.equal(decodeFilenameSafe(undefined), 'upload.bin');
    assert.equal(decodeFilenameSafe(''), 'upload.bin');
});

test('DC-004: rejects malformed percent-encoding', () => {
    assert.throws(() => decodeFilenameSafe('%E0%A4%A'), /invalid_percent_encoding/);
});

test('DC-005: rejects overlong filename', () => {
    const longName = 'a'.repeat(250) + '.png';
    assert.throws(() => decodeFilenameSafe(longName), /filename_too_long/);
});
