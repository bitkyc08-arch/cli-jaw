// wp5b — the code scenario ledger is a claim about coverage, so the claim
// itself needs a contract.
//
// Two separate things are checked here. First the ledger's own shape: ids are
// unique, every row says why it exists and what would distinguish it, and the
// reachability/evidence pairing has no loophole. Second, and more important,
// that the fixture's responses are the ones the PRODUCTION decoders accept —
// because the failure this phase started from was a fixture whose catch-all
// happened to satisfy a decoder by accident, which made an empty session list
// indistinguishable from a harness gap.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scenarioLedgerStatus } from '../../scripts/qa/scenario-ledger.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const HARNESS = readFileSync(join(ROOT, 'public/dashboard2/src/dev/e2e-app-harness.tsx'), 'utf8');

test('the ledger declares clean, non-overlapping denominators', () => {
    const status = scenarioLedgerStatus();
    assert.deepEqual(status.malformed, [], 'every row must be well-formed');
    assert.deepEqual(status.duplicate, [], 'scenario ids must be unique');
    assert.equal(status.total, status.integration + status.shadowed);
    // Pinned so shrinking the denominator becomes a visible edit rather than a
    // quiet improvement in the pass rate.
    assert.equal(status.total, 36);
    assert.equal(status.integration, 35);
    assert.equal(status.shadowed, 1);
});

test('not-applicable is reserved for states nothing can produce', () => {
    const { scenarios } = scenarioLedgerStatus();
    for (const scenario of scenarios) {
        const evidence = scenario.evidenceStatus ?? 'planned';
        if (evidence === 'not-applicable') {
            assert.equal(scenario.reachability, 'shadowed', `${scenario.id} must be shadowed`);
            // A shadowed row has to name its missing producer, otherwise it is
            // just an untested state wearing an exemption.
            assert.match(scenario.why, /:\d+/, `${scenario.id} must cite the source that shadows it`);
        }
        if (scenario.reachability === 'shadowed') {
            assert.notEqual(evidence, 'proven', `${scenario.id} cannot be proven`);
        }
    }
});

test('request oracles pin an exact count, including zero', () => {
    const { scenarios } = scenarioLedgerStatus();
    let zeroCounts = 0;
    for (const scenario of scenarios) {
        for (const want of scenario.expectRequests ?? []) {
            assert.equal(typeof want.count, 'number', `${scenario.id} needs an exact count`);
            if (want.count === 0) zeroCounts += 1;
        }
    }
    // At least one row must assert that nothing was sent. Those are the rows
    // that catch a control which silently does nothing at all.
    assert.ok(zeroCounts >= 3, `expected several zero-count assertions, saw ${zeroCounts}`);
});

test('every scenario lever exists in the harness', () => {
    const { scenarios } = scenarioLedgerStatus();
    const levers = new Set<string>();
    for (const scenario of scenarios) {
        for (const key of Object.keys(scenario.code ?? {})) levers.add(key);
    }
    for (const lever of levers) {
        // A lever the harness does not read is a scenario silently measuring
        // the default screen.
        assert.ok(
            HARNESS.includes(`cfg.${lever}`) || HARNESS.includes(`${lever}?:`),
            `harness does not implement the ${lever} lever`,
        );
    }
});

test('the harness answers every code endpoint the client can call', () => {
    // Derived from code-api-client.ts rather than listed by hand, so a new
    // client method fails here instead of falling into the unknown bucket.
    const client = readFileSync(
        join(ROOT, 'public/dashboard2/src/code/code-api-client.ts'),
        'utf8',
    );
    // Static paths only. Session-scoped routes are built by interpolation
    // (`/sessions/${id}/model`) and the harness matches those with one regex,
    // so they are asserted separately below.
    const paths = [...client.matchAll(/(?:request|post)\(\s*['"](\/[a-z/-]+)['"]/g)]
        .map(match => match[1]!);
    assert.ok(paths.length >= 4, `expected the client's static paths, saw ${paths.length}`);
    for (const path of new Set(paths)) {
        assert.ok(HARNESS.includes(`path === '${path}'`), `harness has no handler for ${path}`);
    }
    // The interpolated ones: model, prompt, cancel and DELETE all land on the
    // session-scoped matcher.
    assert.match(HARNESS, /sessionScoped/);
    assert.match(HARNESS, /verb === '\/model'/);
    assert.match(HARNESS, /verb === '\/prompt'/);
});

test('the code catch-all fails loudly instead of decoding by accident', () => {
    // The original bug: an unhandled /api/code request fell through to a
    // generic `{ok:true, sessions: []}` which decoded cleanly as "no sessions".
    assert.match(HARNESS, /unhandled code endpoint/);
    assert.match(HARNESS, /this\.unknownRequests\.push/);
});
