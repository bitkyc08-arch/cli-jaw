import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('GROK-WD-001: Grok NDJSON activity marks watchdog progress before event filtering', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const start = spawnSrc.indexOf('const dispatchNdjsonLine = (line: string): void => {');
    assert.ok(start >= 0, 'dispatchNdjsonLine must exist');
    const block = spawnSrc.slice(start, spawnSrc.indexOf("if (cli === 'opencode')", start));

    assert.match(block, /appendTraceEvent\(\{\s*runId: ctx\.traceRunId,\s*source: 'cli_raw',/);
    // The runtime list moved into streamJsonMarksProgress() so cursor could join
    // it and be unit-tested (#405). WHICH runtimes qualify is asserted there;
    // what matters here is that the mark still happens, and where.
    assert.match(
        block,
        /if \(streamJsonMarksProgress\(cli, ctx\.effectiveProvider\)\) \{\s*ctx\.stallWatchdog\?\.markProgress\(\);\s*\}/,
    );

    const markerIdx = block.indexOf('if (streamJsonMarksProgress(cli, ctx.effectiveProvider))');
    const discriminateIdx = block.indexOf('const event = discriminate(dispatchCli, raw);');
    const unknownIdx = block.indexOf("pushTrace(ctx, `[cli:unknown-event]");
    assert.ok(markerIdx > block.indexOf('appendTraceEvent({'), 'marker should run after raw trace append');
    assert.ok(markerIdx < discriminateIdx, 'marker should run before discriminator filtering');
    assert.ok(markerIdx < unknownIdx, 'marker should run before unknown-event return path');

    assert.doesNotMatch(block, /ctx\.stallWatchdog\?\.markProgress\(\);\s*const dispatchCli/);
});

// The list this test used to spell out inline. Kept as a behaviour check so the
// grok wiring cannot be dropped while refactoring the runtime set (#405).
test('GROK-WD-002: grok still counts as structured stream-json progress', async () => {
    const { streamJsonMarksProgress } = await import('../../src/agent/events/helpers.ts');
    assert.equal(streamJsonMarksProgress('grok'), true);
    assert.equal(streamJsonMarksProgress('ai-e', 'grok'), true);
    assert.equal(streamJsonMarksProgress('ai-e', 'anthropic'), false);
});
