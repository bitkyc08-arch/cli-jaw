import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clampPendingLine, MAX_PENDING_LINE_CHARS } from '../../src/agent/spawn/line-buffer.js';

const projectRoot = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(projectRoot, p), 'utf8');

test('a pending line under the cap is returned untouched', () => {
    const line = 'x'.repeat(1024);
    const result = clampPendingLine(line);

    assert.equal(result.overflowed, false);
    assert.equal(result.buffer, line, 'normal traffic must not be altered');
});

test('a newline-free stream cannot grow the buffer without limit', () => {
    // Mirrors the reader loop: chunks arrive, no newline ever does.
    let buffer = '';
    const chunk = 'x'.repeat(1024 * 1024);

    for (let i = 0; i < 64; i++) {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        buffer = clampPendingLine(buffer).buffer;
    }

    assert.ok(
        buffer.length <= MAX_PENDING_LINE_CHARS,
        `buffer grew to ${buffer.length}, above the ${MAX_PENDING_LINE_CHARS} cap`,
    );
});

test('overflow is reported so truncation is never silent', () => {
    const result = clampPendingLine('x'.repeat(MAX_PENDING_LINE_CHARS + 1));

    assert.equal(result.overflowed, true);
    assert.equal(result.buffer.length, MAX_PENDING_LINE_CHARS);
});

test('every NDJSON reader clamps its pending line', () => {
    // A reader that keeps a trailing partial line must bound it, or a child that
    // never emits a newline grows it for the lifetime of the process.
    for (const file of ['src/agent/spawn.ts', 'src/agent/pi-runtime.ts']) {
        const lines = read(file).split('\n');
        lines.forEach((line, index) => {
            if (!/buffer = lines\.pop\(\)/.test(line)) return;
            const following = lines.slice(index, index + 6).join(' ');
            assert.match(
                following,
                /clampPendingLine/,
                `${file}:${index + 1} keeps an unbounded pending line`,
            );
        });
    }
});
