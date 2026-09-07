import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { median, classifyMemory, parseBurstArgs, browserFailures,
    type MemorySeriesInput, type BrowserOracleSample } from '../smoke/native-activity-burst.mts';
import { burstBodies, isBurstCycle, nextBurstCycle, BURST_PROTOCOL } from '../fixtures/native-activity-burst-server.mts';

const series = (measured = Array(20).fill(10_000_000)): MemorySeriesInput => ({ initial: Array(5).fill(10_000_000),
    measured, final: Array(5).fill(measured.at(-1)), pageBytes: 16384, identityStable: true });

test('median is independent of input order and does not mutate observations', () => {
    const values = [8, 2, 6, 4]; assert.equal(median(values), 5); assert.deepEqual(values, [8, 2, 6, 4]);
    assert.equal(median([9, 3, 7]), 7); assert.throws(() => median([])); assert.throws(() => median([NaN]));
});
test('constant same-identity memory is a bounded local plateau', () => {
    const result = classifyMemory(series());
    assert.equal(result.verdict, 'PLATEAU_OBSERVED'); assert.equal(result.noise, 16384);
    assert.deepEqual(result.windows, [10_000_000, 10_000_000, 10_000_000, 10_000_000]); assert.equal(result.nineSlope, 0);
});
test('hand-worked increasing windows and Theil-Sen slope report growth', () => {
    const result = classifyMemory(series(Array.from({ length: 20 }, (_, index) => 1_000_000 + index * 131072)));
    assert.equal(result.verdict, 'GROWTH_OBSERVED');
    assert.deepEqual(result.windows, [1_262_144, 1_917_504, 2_572_864, 3_228_224]);
    assert.equal(result.lateSlope, 131072); assert.equal(result.nineSlope, 1_179_648); assert.equal(result.lateChange, 655360);
});
test('noise uses within-block variation, never the initial-to-final drift', () => {
    const input = series(Array.from({ length: 20 }, (_, index) => 10_000_000 + index * 100_000));
    input.final = Array(5).fill(90_000_000);
    const result = classifyMemory(input); assert.equal(result.noise, 16384); assert.equal(result.verdict, 'GROWTH_OBSERVED');
});
test('noise equal to a complete bulk submission is inconclusive before plateau', () => {
    const input = series(); input.initial = [10_000_000, 10_000_000, 10_000_000, 10_000_000, 12_097_152];
    const result = classifyMemory(input); assert.equal(result.noise, 2_097_152); assert.equal(result.verdict, 'INCONCLUSIVE');
});
test('an early allocation step is not a fabricated sustained leak', () => {
    const result = classifyMemory(series([...Array(5).fill(10_000_000), ...Array(15).fill(12_000_000)]));
    assert.equal(result.verdict, 'PLATEAU_OBSERVED'); assert.equal(result.totalChange, 2_000_000); assert.equal(result.lateChange, 0);
});
test('late-only positive drift stays inconclusive, not plateau or attributed growth', () => {
    const result = classifyMemory(series([...Array(15).fill(10_000_000), 10_100_000, 10_200_000, 10_300_000, 10_400_000, 10_500_000]));
    assert.equal(result.verdict, 'INCONCLUSIVE');
});
for (const [name, change] of [
    ['identity', (value: MemorySeriesInput) => { value.identityStable = false; }],
    ['missing sample', (value: MemorySeriesInput) => { value.measured.pop(); }],
    ['NaN', (value: MemorySeriesInput) => { value.measured[0] = NaN; }],
    ['zero', (value: MemorySeriesInput) => { value.measured[0] = 0; }],
    ['negative', (value: MemorySeriesInput) => { value.measured[0] = -1; }],
    ['invalid page', (value: MemorySeriesInput) => { value.pageBytes = 0; }],
] as const) test(`missing/invalid ${name} never becomes a zero memory pass`, () => {
    const input = series(); change(input); assert.equal(classifyMemory(input).verdict, 'INCONCLUSIVE');
});

test('CLI parser is strict and does not start a browser on import', () => {
    const result = parseBurstArgs(['--label', 'fixture-01', '--browser-executable', process.execPath]);
    assert.equal(result.label, 'fixture-01'); assert.equal(result.executable, process.execPath);
    assert.ok(result.evidenceRoot.endsWith(path.join('.codexclaw', 'evidence', 'native-activity-burst')));
    for (const args of [[], ['--unknown', '1'], ['--label', '../escape', '--browser-executable', process.execPath],
        ['--label', 'ok', '--browser-executable', 'relative'], ['--label', 'a', '--label', 'b', '--browser-executable', process.execPath],
        ['--label', 'ok', '--browser-executable', process.execPath, '--evidence-root', path.parse(process.execPath).root]])
        assert.throws(() => parseBurstArgs(args));
});
test('cycle shape and progression reject malformed and out-of-range values', () => {
    assert.equal(BURST_PROTOCOL, 'wp29-burst-v2');
    assert.ok(isBurstCycle({ phase: 'preflight', index: 5 })); assert.ok(isBurstCycle({ phase: 'measured', index: 20 }));
    for (const value of [null, [], { phase: 'unknown', index: 1 }, { phase: 'warmup', index: 6 },
        { phase: 'measured', index: 0 }, { phase: 'measured', index: '1' }, { phase: 'measured', index: 1, extra: true }])
        assert.equal(isBurstCycle(value), false);
    assert.deepEqual(nextBurstCycle(null), { phase: 'preflight', index: 1 });
    assert.deepEqual(nextBurstCycle({ phase: 'preflight', index: 5 }), { phase: 'warmup', index: 1 });
    assert.deepEqual(nextBurstCycle({ phase: 'warmup', index: 5 }), { phase: 'measured', index: 1 });
    assert.equal(nextBurstCycle({ phase: 'measured', index: 20 }), null);
});
test('fixed generator supplies643 legal-shaped bodies and exact independent byte totals', () => {
    const bodies = [...burstBodies({ phase: 'measured', index: 7 })];
    assert.equal(bodies.length, 643); assert.equal(bodies[0]?.kind, 'turn-start');
    const first = bodies[1], lastBulk = bodies[512], firstTail = bodies[513], end = bodies[642];
    assert.ok(first?.kind === 'tool' && lastBulk?.kind === 'tool' && firstTail?.kind === 'tool' && end?.kind === 'turn-end');
    assert.equal(first.itemId, 'bulk-0000'); assert.equal(first.name, 'tool-0000');
    assert.equal(first.output, 'C07B0000|' + 'x'.repeat(4079) + '|END0000');
    assert.equal(lastBulk.itemId, 'bulk-0511'); assert.equal(lastBulk.output?.length, 4096);
    assert.equal(firstTail.itemId, 'tail-0000'); assert.equal(firstTail.output, 'ok');
    assert.equal(end.finalText, 'WP29 cycle 07 final');
    assert.equal(bodies.reduce((sum, body) => sum + (body.kind === 'tool' ? Buffer.byteLength(body.output ?? '') : 0), 0), 2_097_410);
});

function healthyBrowser(): BrowserOracleSample {
    const binding = { protocol: 'wp29-burst-v2', cycle: { phase: 'measured', index: 1 }, sessionId: 'owned', scope: 'wp29:owned',
        runId: 'tr_0123456789abcdef', turnId: 'tr_0123456789abcdef', specId: '512x4096+129-small-v1' } as const;
    return { binding, receivedCount: 643, ingestedCount: 643, retiredCallbackHits: 0, suppressedIngestions: 0,
        terminal: true, activeEventSources: 1, maxEventSources: 1, errors: [],
        bulk: { entryCount: 16, retainedChars: 65536, observedFieldChars: 65536, omittedEntries: 496, omittedTextChars: 4608,
            latestAction: 'tool-0511 (done)', retainedIds: Array.from({ length: 16 }, (_, i) => `bulk-${String(i + 496).padStart(4, '0')}`), visibleRows: 16, omissionVisible: true },
        final: { entryCount: 128, retainedChars: 1408, observedFieldChars: 1408, omittedEntries: 513, omittedTextChars: 4608,
            latestAction: 'tail-0128 (done)', retainedIds: Array.from({ length: 128 }, (_, i) => `tail-${String(i + 1).padStart(4, '0')}`), visibleRows: 8, omissionVisible: true },
        finalText: 'WP29 cycle 01 final', finalDomRaw: 'WP29 cycle 01 final', finalDomText: 'WP29 cycle 01 final', answerCount: 1,
        controls: [{ queuedAt: 1, completedAt: 2, frameAt: 3, queuedOrdinal: 65, completedOrdinal: 70, frameOrdinal: 80, open: true }] };
}
test('independent browser oracle accepts the hand-authored healthy result', () => {
    assert.deepEqual(browserFailures(healthyBrowser()), []);
});
test('retired callback and suppressed ingest counterexamples cannot be swallowed as green', () => {
    const retired = healthyBrowser(); retired.retiredCallbackHits = 1;
    assert.ok(browserFailures(retired).includes('retired-subscriber'));
    const dropped = healthyBrowser(); dropped.ingestedCount = 642; dropped.suppressedIngestions = 1;
    assert.ok(browserFailures(dropped).includes('ingested-count'));
});
test('a frame during only the compact tail is not evidence of later bulk progress', () => {
    const value = healthyBrowser(); value.controls[0]!.frameOrdinal = 640;
    assert.ok(browserFailures(value).includes('control-frame-progress'));
});
test('preview counters cannot hide a different observed field sum or duplicate final', () => {
    const value = healthyBrowser(); value.bulk!.observedFieldChars = 65537; value.answerCount = 2;
    assert.ok(browserFailures(value).includes('bulk-bounds')); assert.ok(browserFailures(value).includes('final-owner'));
});
