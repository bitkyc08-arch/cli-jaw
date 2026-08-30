// The Classic heartbeat UI must not mint one id twice in a single save.
//
// The server now rejects a duplicate job id, because two jobs under one id share
// one mention-watch ledger namespace and the second inherits the first's cursor.
// That turns a collision which used to silently merge two jobs into a failure of
// the WHOLE save, so the id source has to be unique per call rather than per
// millisecond. `normalizeHeartbeatJob` runs inside a `.map()`, which is exactly
// where a `Date.now()`-only id collides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
    join(import.meta.dirname, '..', '..', 'public/js/features/heartbeat.ts'),
    'utf8',
);

test('every generated heartbeat id carries a per-call counter, not just a timestamp', () => {
    const generators = source.match(/hb_\$\{Date\.now\(\)[^`]*/g) ?? [];
    assert.ok(generators.length >= 2, 'expected the add and normalize id sources');
    for (const generator of generators) {
        assert.match(generator, /idCounter\+\+/, `bare timestamp id: ${generator}`);
    }
});

test('the counter is declared before its first use, so it cannot hit the TDZ', () => {
    const declaration = source.indexOf('let idCounter');
    const firstUse = source.indexOf('idCounter++');
    assert.ok(declaration >= 0, 'counter declaration missing');
    // `let` is not hoisted-initialized: a use above the declaration throws at
    // runtime, which would break adding a job entirely.
    assert.ok(declaration < firstUse, 'counter is used before it is declared');
});

test('the Manager job factory also carries a per-call counter', () => {
    const manager = readFileSync(
        join(import.meta.dirname, '..', '..', 'public/manager/src/settings/pages/components/heartbeat-helpers.ts'),
        'utf8',
    );
    const generators = manager.match(/id: `hb_\$\{[^`]*/g) ?? [];
    assert.ok(generators.length >= 1, 'expected the Manager id source');
    for (const generator of generators) {
        assert.match(generator, /idCounter\+\+/, `bare timestamp id: ${generator}`);
    }
    const declaration = manager.indexOf('let idCounter');
    const firstUse = manager.indexOf('idCounter++');
    assert.ok(declaration >= 0 && declaration < firstUse, 'counter must be declared before use');
});
