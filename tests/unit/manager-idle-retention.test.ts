import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { fnv1a32 } from '../../public/manager/src/lib/fnv1a.js';
import { addBounded } from '../../public/manager/src/lib/bounded-set.js';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/**
 * 260803 unit, 050 phase — idle cost and retention.
 */

test('D3: fnv1a32 is stable, cheap, and collision-free across realistic chunk text', () => {
    assert.equal(fnv1a32('hello'), fnv1a32('hello'), 'must be deterministic');
    assert.notEqual(fnv1a32('hello'), fnv1a32('hello '), 'a one-char difference must change the hash');
    assert.equal(fnv1a32(''), fnv1a32(''));

    // The key it replaces embedded the whole text; the hash must stay short.
    const long = 'x'.repeat(100_000);
    assert.ok(fnv1a32(long).length <= 8, 'hash must be short regardless of input size');

    // No collisions across a realistic streaming burst.
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(fnv1a32(`assistant chunk number ${i} with some text`));
    assert.equal(seen.size, 20_000, 'no collisions across 20k distinct chunks');
});

test('D3: addBounded evicts oldest-first and never exceeds the bound', () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i += 1) addBounded(set, `key-${i}`, 10);

    assert.equal(set.size, 10, 'must hold exactly the bound');
    assert.ok(!set.has('key-0'), 'oldest entries are evicted');
    assert.ok(set.has('key-99'), 'newest entry is retained');
    assert.ok(set.has('key-90'), 'the most recent window is intact');
});

test('D4: the three previously ungated pollers now check document.hidden', () => {
    for (const path of [
        'public/manager/src/electron-metrics.tsx',
        'public/manager/src/notes/useNotesExternalSync.ts',
        'public/manager/src/browser-panel/use-embedded-target-sync.ts',
    ]) {
        assert.ok(
            read(path).includes('document.hidden'),
            `${path} must skip polling while the window is hidden`,
        );
    }
});

test('D3: the CEO console dedupe set is bounded too', () => {
    const source = read('public/manager/src/jaw-ceo/useJawCeo.ts');
    assert.ok(source.includes('addBounded('), 'the same unbounded pattern existed here');
});
