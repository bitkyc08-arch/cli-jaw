// 260726 wp13 — the ledger is the contract, so the ledger itself is gated.
//
// The ask was "at least 100 visual gates". The first ledger said 125 total, but
// only 96 of those were visual — the rest were runtime and integration
// scenarios. Counting them together to reach the number would have been a
// sleight of hand, so the visual floor is enforced separately here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLedger, SURFACES, VIEWPORTS } from '../../scripts/qa/gate-ledger.mjs';

const gates = buildLedger();

test('there are at least 100 visual gates, counted on their own', () => {
    const visual = gates.filter((g) => g.group === 'visual');
    assert.ok(visual.length >= 100, `only ${visual.length} visual gates`);
});

test('every gate id is unique', () => {
    const ids = gates.map((g) => g.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual([...new Set(duplicates)], []);
});

test('every gate names a fixture, an oracle and an expectation', () => {
    const incomplete = gates
        .filter((g) => !g.fixture || !g.oracle || !g.expected)
        .map((g) => g.id);
    assert.deepEqual(incomplete, [], 'a gate without an expectation cannot fail meaningfully');
});

test('the theme axis is applied only where theme can change the verdict', () => {
    // Geometry is identical across themes: same DOM, same box model. Doubling
    // those checks by theme would inflate the count for nothing.
    const geometric = ['target-size', 'accessible-name', 'occlusion', 'text-clipping', 'type-scale'];
    const themed = gates.filter((g) => g.theme !== 'any').map((g) => g.oracle);
    for (const oracle of geometric) {
        assert.ok(!themed.includes(oracle), `${oracle} must not be counted per theme`);
    }
    // And colour oracles must be, because light-only failures are real: the
    // accent-on-soft-background failure appears in light and not in dark.
    for (const oracle of ['contrast-text', 'contrast-icon', 'focus-visible']) {
        assert.ok(themed.includes(oracle), `${oracle} must be checked per theme`);
    }
});

test('every feature surface has visual gates, not just the shell', () => {
    // notes, board and code were absent from the first ledger, and `side-pane`
    // does not stand in for them: it shows whichever panel was last restored.
    const covered = new Set(gates.filter((g) => g.group === 'visual').map((g) => g.fixture));
    for (const surface of ['notes', 'board', 'code', 'hover-dock', 'settings']) {
        assert.ok(covered.has(surface), `${surface} has no visual gate`);
    }
    assert.ok(SURFACES.length >= 9, 'the surface list should cover every feature panel');
});

test('layout gates run at more than one width', () => {
    const widths = new Set(gates.filter((g) => g.oracle === 'layout-overflow').map((g) => g.viewport));
    assert.equal(widths.size, VIEWPORTS.length);
});

test('runtime and jawcode gates describe scenarios, not surfaces', () => {
    for (const gate of gates.filter((g) => g.group !== 'visual')) {
        assert.equal(gate.theme, 'any', `${gate.id} should not vary by theme`);
        assert.ok(gate.expected.length > 20, `${gate.id} needs a real expectation`);
    }
});
