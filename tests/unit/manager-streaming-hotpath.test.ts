import assert from 'node:assert/strict';
import test from 'node:test';

import { throttleMsFor } from '../../public/manager/src/code/use-throttled-markdown.js';
import {
    highlightCodeCached,
    __resetHighlightCache,
    __highlightCacheStats,
} from '../../public/manager/src/notes/rendering/highlight-cache.js';

/**
 * 260803 unit, 020 phase — streaming hot path.
 *
 * These cover the pure logic behind D1 (adaptive throttle) and D2 (highlight
 * cache + oversize cutoff). The React-level wins (memoized components object,
 * ref-stable virtualizer callbacks) are verified by typecheck plus the build
 * output check, not here.
 */

test('D1: throttle interval grows with message length and clamps at 400ms', () => {
    // Short messages keep the responsive floor.
    assert.equal(throttleMsFor(0), 80);
    assert.equal(throttleMsFor(2000), 80);

    // Past the threshold the interval scales, keeping total parse work
    // near-linear instead of quadratic.
    assert.equal(throttleMsFor(4000), 160);
    assert.equal(throttleMsFor(10_000), 400);

    // Clamped — a huge answer must not stall updates indefinitely.
    assert.equal(throttleMsFor(50_000), 400);
    assert.equal(throttleMsFor(5_000_000), 400);

    // Matches the legacy renderer's constants (public/js/streaming-render.ts).
    assert.ok(throttleMsFor(1) <= throttleMsFor(100_000));
});

test('D2: identical code is highlighted once and served from cache', () => {
    __resetHighlightCache();
    const code = 'const answer = 42;\nconsole.log(answer);';

    const first = highlightCodeCached(code, 'typescript');
    const second = highlightCodeCached(code, 'typescript');

    assert.equal(__highlightCacheStats().entries, 1, 'second call must hit the cache');
    // Same object identity proves no re-tokenization happened.
    assert.equal(first, second);
    assert.equal(first.highlighted, true);
});

test('D2: language is part of the cache key', () => {
    __resetHighlightCache();
    const code = 'x = 1';
    highlightCodeCached(code, 'python');
    highlightCodeCached(code, 'ruby');
    assert.equal(__highlightCacheStats().entries, 2);
});

test('D2: oversized blocks skip highlighting and stay out of the cache', () => {
    __resetHighlightCache();
    const huge = 'a'.repeat(100_001);

    const result = highlightCodeCached(huge, 'typescript');

    assert.equal(result.highlighted, false, 'past the cutoff we must not tokenize');
    assert.equal(__highlightCacheStats().entries, 0, 'and must not retain it');
    assert.ok(result.html.length >= huge.length, 'content is still rendered, just escaped');
});

test('D2: cache is bounded by entry count', () => {
    __resetHighlightCache();
    for (let i = 0; i < 250; i += 1) {
        highlightCodeCached(`const v${i} = ${i};`, 'typescript');
    }
    const { entries } = __highlightCacheStats();
    assert.ok(entries <= 200, `expected <= 200 entries, got ${entries}`);
});

test('D2: escaping is applied so highlighted output cannot inject markup', () => {
    __resetHighlightCache();
    const result = highlightCodeCached('<script>alert(1)</script>', 'definitely-not-a-language');
    assert.equal(result.highlighted, false);
    assert.ok(!result.html.includes('<script>'), 'raw tag must not survive');
    assert.ok(result.html.includes('&lt;script&gt;'));
});
