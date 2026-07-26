// 260726 wp5a — the tool-tab state ledger is a contract, not a table.
//
// The first version was pasted into a devlog document with the stable ids
// truncated to 28 characters, which made two Terminal branches display
// identically and left every activation column reading "TBD". A reviewer could
// not match a fixture result to a branch, which is the only thing the table was
// for. Generating it from the manifest removes both problems at once.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildTabStateLedger } from '../../scripts/qa/tab-state-ledger.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const rows = buildTabStateLedger();

test('the ledger covers every tool-tab branch the manifest knows about', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/wp12-state-manifest.json'), 'utf8')) as {
        branches: Array<{ id: string; file: string }>;
    };
    const expected = manifest.branches.filter(b => /(Terminal|Browser|FileTree|Doc|Design|Diff)Panel\.tsx$/.test(b.file));
    assert.equal(rows.length, expected.length, 'a branch in the manifest with no ledger row is unswept by definition');
    assert.deepEqual(
        rows.map(r => r.id).sort(),
        expected.map(b => b.id).sort(),
        'ids must match the manifest exactly, not a truncation of it',
    );
});

test('every branch says how it is reached', () => {
    // "TBD" means B would have to design the fixture before implementing it,
    // which is the work A is supposed to have finished.
    const unrouted = rows.filter(r => !r.lever || !r.provider || !r.reset).map(r => r.id);
    assert.deepEqual(unrouted, [], 'a branch with no activation route cannot be scheduled');

    const tbd = rows.filter(r => /TBD/i.test(`${r.lever} ${r.provider} ${r.reset}`)).map(r => r.id);
    assert.deepEqual(tbd, []);
});

test('every branch says what proves it rendered', () => {
    // Without this a fixture can open the panel, measure something adjacent,
    // and report a clean pass for a branch that never appeared.
    const unverifiable = rows.filter(r => !r.expectSelector).map(r => r.id);
    assert.deepEqual(unverifiable, []);
});

test('ids are unique, so a fixture result maps to exactly one branch', () => {
    const ids = rows.map(r => r.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual([...new Set(duplicates)], []);
});

test('the six tool tabs are all represented', () => {
    const byComponent = rows.reduce<Record<string, number>>(
        (acc, r) => ({ ...acc, [r.component]: (acc[r.component] ?? 0) + 1 }),
        {},
    );
    for (const component of ['TerminalPanel', 'BrowserPanel', 'FileTreePanel', 'DocPanel', 'DesignPanel', 'DiffPanel']) {
        assert.ok(byComponent[component] > 0, `${component} has no branches in the ledger`);
    }
    assert.equal(Object.values(byComponent).reduce((a, b) => a + b, 0), rows.length);
});
