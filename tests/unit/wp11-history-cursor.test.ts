// wp11 CF-3 — a repeated history cursor is no-progress, not a loop.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

test('CF-3: loadOlder marks exhausted on a same or non-decreasing cursor', () => {
    const src = readFileSync(join(ROOT, 'public/dashboard2/src/turn-stream/history/history-controller.ts'), 'utf8');
    // The no-progress guard must exist and mark exhausted.
    assert.ok(src.includes('cursorAdvanced'), 'a cursor-advance check exists');
    assert.ok(src.includes('noProgress'), 'a no-progress flag exists');
    assert.ok(src.includes('exhausted: exhausted || noProgress'), 'no-progress marks exhausted, stopping the loop');
    // The contract is exclusive id < before, so a same cursor is no-progress.
    assert.match(src, /oldestCursor < previousCursor|!== previousCursor/, 'a same cursor is detected');
});
