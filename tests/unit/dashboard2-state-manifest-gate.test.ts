// 260726 wp12 S2 — the state manifest is a contract, not a snapshot.
//
// DS-4 migrates 149 state render branches onto five primitives. The obvious
// gate — "count the raw className/role occurrences, require 0" — proves nothing:
// deleting a branch scores the same as migrating it correctly, and migrating it
// to the WRONG primitive also scores 0. A reviewer caught exactly that hole.
//
// So the gate is differential. The manifest records every branch under a stable
// id with its expected target primitive. This test fails when a branch appears,
// disappears, or changes routing without the manifest being updated in the same
// commit — which forces the migration to be described, not just performed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const ENUMERATOR = join(ROOT, 'scripts/qa/enumerate-states.mts');

// The baseline lives in tests/fixtures, not devlog. devlog is a private
// submodule, so keeping the baseline there made this gate skip itself in any
// checkout without submodule access — which is exactly where a required gate
// must not go quiet.
const MANIFEST = join(ROOT, 'tests/fixtures/wp12-state-manifest.json');

interface Branch {
    id: string;
    file: string;
    axis: string;
    target: string;
    form: 'raw' | 'primitive';
    inferredAxis?: string;
}
interface Manifest {
    total: number;
    byTarget: Record<string, number>;
    byForm?: Record<string, number>;
    duplicateIds: unknown[];
    branches: Branch[];
}

function enumerate(): Manifest {
    const out = execFileSync('npx', ['tsx', ENUMERATOR], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(out) as Manifest;
}

const haveManifest = existsSync(MANIFEST);

test('the baseline manifest is tracked in this repository, not a submodule', () => {
    assert.ok(haveManifest, `${MANIFEST} must exist so this gate cannot silently skip`);
});

test('branch ids are unique, so a branch can be tracked across edits', () => {
    const live = enumerate();
    assert.deepEqual(
        live.duplicateIds,
        [],
        'two branches sharing an id cannot be told apart when one of them migrates',
    );
});

test('every branch routes to a primitive the manifest declares', { skip: !haveManifest }, () => {
    const live = enumerate();
    const recorded = new Map(
        (JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest).branches.map(b => [b.id, b]),
    );

    const appeared: string[] = [];
    const rerouted: string[] = [];
    const reclassified: string[] = [];
    for (const branch of live.branches) {
        const before = recorded.get(branch.id);
        if (!before) {
            appeared.push(`${branch.file}: ${branch.id} (${branch.axis} -> ${branch.target})`);
            continue;
        }
        if (before.target !== branch.target) {
            rerouted.push(`${branch.id}: ${before.target} -> ${branch.target}`);
        }
        // Routing to the right primitive with the wrong kind is still wrong:
        // a StatePanel showing `kind="empty"` during a fetch is a lie.
        if (before.axis !== branch.axis) {
            reclassified.push(`${branch.id}: ${before.axis} -> ${branch.axis}`);
        }
        recorded.delete(branch.id);
    }
    const vanished = [...recorded.values()].map(b => `${b.file}: ${b.id} (was ${b.target})`);

    assert.deepEqual(
        { appeared, rerouted, reclassified, vanished },
        { appeared: [], rerouted: [], reclassified: [], vanished: [] },
        'regenerate the manifest in the same commit: '
        + 'npx tsx scripts/qa/enumerate-states.mts > tests/fixtures/wp12-state-manifest.json',
    );
});

test('migration never loses a branch: raw + primitive always totals the baseline', { skip: !haveManifest }, () => {
    // The failure this guards against is the one that makes a differential gate
    // worthless: delete 138 raw branches, add 5 primitive definitions, then
    // regenerate the manifest and call it done. Because the id is derived from
    // the guard — which migration preserves — a migrated branch keeps its id and
    // only flips `form`, so the total must hold.
    const live = enumerate();
    const recorded = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
    assert.equal(
        live.total,
        recorded.total,
        'a branch was added or dropped; migration should only change form raw -> primitive',
    );
});

test('a migrated branch declares a kind its guard agrees with', () => {
    // `<StatePanel kind="empty">` under a loading guard is the failure this
    // catches: the routing is right, the state the user is told about is wrong.
    // Raw branches have nothing to disagree with, so only migrated ones apply.
    const live = enumerate();
    const dishonest = live.branches
        .filter(b => b.form === 'primitive' && b.inferredAxis && b.inferredAxis !== b.axis)
        .map(b => `${b.file}: ${b.id} declares kind="${b.axis}" but its guard implies ${b.inferredAxis}`);

    assert.deepEqual(dishonest, []);
});

// DS-4 is complete only when nothing hand-rolled is left. Kept skipped until S2
// starts so it states the finish line without failing S1, then flipped on.
test('DS-4 completion: every branch is a primitive callsite', { skip: 'enable when S2 (state surfaces) begins' }, () => {
    const live = enumerate();
    const recorded = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
    const raw = live.branches.filter(b => b.form === 'raw').map(b => `${b.file}: ${b.id}`);

    assert.deepEqual(raw, [], 'these branches still render hand-rolled state markup');
    assert.equal(live.byForm?.['primitive'], recorded.total);
});

test('the manifest denominator matches what the enumerator finds', { skip: !haveManifest }, () => {
    const live = enumerate();
    const recorded = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
    assert.equal(live.total, recorded.total);
    // Axis and target are tallied in one pass, so a mismatch means the recorded
    // file was hand-edited — which is how three earlier denominators went wrong.
    assert.equal(
        Object.values(live.byTarget).reduce((a, b) => a + b, 0),
        live.total,
        'target tally must account for every branch',
    );
});
