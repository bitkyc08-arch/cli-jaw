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

test('D3: dedupe keys no longer embed the full chunk text', () => {
    const source = read('public/manager/src/code/code-event-dedupe.ts');
    assert.ok(
        !source.includes('${stableId}:${text}`'),
        'the raw text must not be part of the key — that retained a second copy of the transcript',
    );
    assert.ok(source.includes('fnv1a32(text)'), 'the text must be hashed into the key');
    assert.ok(source.includes('addBounded('), 'the dedupe set must be bounded');
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

test('D2: the transcript virtualizer resets measurements on session switch', () => {
    const hook = read('public/manager/src/code/useCodeTranscriptVirtualRows.ts');
    assert.ok(hook.includes('resetKey'), 'the hook must accept a reset key');
    // Must use the public measure(): itemSizeCache is the durable store and is
    // private, while measurementsCache is reassigned to a fresh lazy view on
    // every recompute, so clearing it releases nothing.
    assert.ok(hook.includes('virtualizer.measure()'), 'must clear sizes via the supported API');
    assert.ok(!hook.includes('measurementsCache = []'), 'clearing measurementsCache is a no-op and must not be relied on');
    assert.ok(hook.includes('virtualizerRef.current = null'), 'the instance must be released on unmount');

    // A reset key that never changes would make the whole thing inert.
    const transcript = read('public/manager/src/code/CodeTranscript.tsx');
    assert.ok(transcript.includes('resetKey: sessionId'), 'the session id must feed the reset key');
    const workbench = read('public/manager/src/code/CodeWorkbench.tsx');
    assert.ok(workbench.includes('sessionId={props.activeSessionId}'), 'the session id must actually be passed down');
});

test('D3: seeding from a session replay never evicts its own entries', () => {
    const source = read('public/manager/src/code/code-event-dedupe.ts');
    // A replay longer than the bound would otherwise drop keys for content
    // already on screen, and the next matching live chunk would re-append it.
    assert.ok(
        source.includes('Math.max(MAX_SEEN_KEYS, events.length)'),
        'replay seeding must size the bound to the replay itself',
    );
});

test('D3: the CEO console dedupe set is bounded too', () => {
    const source = read('public/manager/src/jaw-ceo/useJawCeo.ts');
    assert.ok(source.includes('addBounded('), 'the same unbounded pattern existed here');
});
