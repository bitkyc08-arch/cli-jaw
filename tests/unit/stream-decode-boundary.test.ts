import { test } from 'node:test';
import assert from 'node:assert';
import { createTextStreamReader, sliceWithoutSplittingSurrogate } from '../../src/agent/stream-text.js';

const SAMPLE = '한글 中文 日本語 😀';

/**
 * The core property of #372: a code point split across chunks must survive.
 * Splitting at EVERY byte index is the only honest test — a single hand-picked
 * boundary can pass while 2-, 3-, and 4-byte sequences still break.
 */
test('SD-001: every byte split boundary round-trips exactly', () => {
    const bytes = Buffer.from(SAMPLE, 'utf8');
    for (let i = 0; i <= bytes.length; i++) {
        const reader = createTextStreamReader();
        let out = reader.write(bytes.subarray(0, i));
        out += reader.write(bytes.subarray(i));
        out += reader.end();
        assert.equal(out, SAMPLE, `split at byte ${i} corrupted the stream`);
        assert.ok(!out.includes('\uFFFD'), `split at byte ${i} introduced U+FFFD`);
    }
});

test('SD-002: one byte at a time round-trips exactly', () => {
    const bytes = Buffer.from(SAMPLE, 'utf8');
    const reader = createTextStreamReader();
    let out = '';
    for (const byte of bytes) out += reader.write(Buffer.from([byte]));
    out += reader.end();
    assert.equal(out, SAMPLE);
});

test('SD-003: NDJSON split at every boundary still parses', () => {
    const line = JSON.stringify({ type: 'text', text: SAMPLE }) + '\n';
    const bytes = Buffer.from(line, 'utf8');
    for (let i = 0; i <= bytes.length; i++) {
        const reader = createTextStreamReader();
        const out = reader.write(bytes.subarray(0, i)) + reader.write(bytes.subarray(i)) + reader.end();
        const parsed = JSON.parse(out.trim());
        assert.equal(parsed.text, SAMPLE, `split at byte ${i} broke the JSON payload`);
    }
});

test('SD-004: stdout and stderr readers never share decoder state', () => {
    const stdout = createTextStreamReader();
    const stderr = createTextStreamReader();
    const a = Buffer.from('한', 'utf8');
    const b = Buffer.from('글', 'utf8');
    // Interleave partial writes: a shared decoder would splice these together.
    let outA = stdout.write(a.subarray(0, 2));
    let outB = stderr.write(b.subarray(0, 2));
    outA += stdout.write(a.subarray(2));
    outB += stderr.write(b.subarray(2));
    assert.equal(outA + stdout.end(), '한');
    assert.equal(outB + stderr.end(), '글');
});

test('SD-005: a stream truncated mid-codepoint yields one bounded replacement', () => {
    // Distinct from SD-001: here the bytes genuinely never arrive, so the character
    // cannot be reconstructed. The contract is bounded, explicit replacement — not
    // a throw, and not silent truncation.
    const bytes = Buffer.from('한', 'utf8');
    const reader = createTextStreamReader();
    const partial = reader.write(bytes.subarray(0, 2));
    const residual = reader.end();
    assert.equal(partial, '');
    assert.ok(residual.length > 0 && residual.length <= 2);
    assert.ok([...residual].every(ch => ch === '\uFFFD'));
});

test('SD-006: end() is idempotent', () => {
    const reader = createTextStreamReader();
    reader.write(Buffer.from('ok', 'utf8'));
    assert.equal(reader.end(), '');
    assert.equal(reader.end(), '');
});

test('SD-007: string input passes through unchanged', () => {
    const reader = createTextStreamReader();
    assert.equal(reader.write('already decoded 한글'), 'already decoded 한글');
});

test('SD-008: invalid UTF-8 is bounded, not thrown', () => {
    const reader = createTextStreamReader();
    const out = reader.write(Buffer.from([0x80, 0x80, 0x41])) + reader.end();
    assert.ok(out.endsWith('A'));
    assert.ok(out.length <= 3);
});

test('SD-009: clamping never splits a surrogate pair', () => {
    const text = 'ab😀cd';
    // '😀' occupies indices 2 and 3; clamping at 3 would leave a lone high surrogate.
    const clamped = sliceWithoutSplittingSurrogate(text, 3);
    assert.equal(clamped, 'ab');
    assert.ok(!/[\uD800-\uDBFF]$/.test(clamped));
    assert.equal(sliceWithoutSplittingSurrogate(text, 4), 'ab😀');
    assert.equal(sliceWithoutSplittingSurrogate(text, 99), text);
    assert.equal(sliceWithoutSplittingSurrogate(text, 0), '');
});

