// wp11 CF-1 — the live tail's height growth participates in follow.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

test('CF-1: the tail host is observed and re-follows only when already at the bottom', () => {
    const src = readFileSync(join(ROOT, 'public/dashboard2/src/turn-stream/components/TurnStreamViewport.tsx'), 'utf8');
    assert.ok(src.includes('tailRef'), 'a tail host ref exists');
    assert.ok(src.includes('ResizeObserver'), 'the tail height is observed');
    assert.ok(src.includes('wasAtEnd'), 'a pinned-at-end check exists');
    // Re-follows only if already at the bottom (does not yank a user reading up).
    assert.match(src, /if \(nextHeight !== lastHeight && wasAtEnd\(\)\)/, 're-follows only on height change while at end');
});
