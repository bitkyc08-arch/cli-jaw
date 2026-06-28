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
    assert.match(
        block,
        /if \(cli === 'grok' \|\| \(cli === 'ai-e' && ctx\.effectiveProvider === 'grok'\)\) \{\s*ctx\.stallWatchdog\?\.markProgress\(\);\s*\}/,
    );

    const markerIdx = block.indexOf("if (cli === 'grok' || (cli === 'ai-e' && ctx.effectiveProvider === 'grok'))");
    const discriminateIdx = block.indexOf('const event = discriminate(dispatchCli, raw);');
    const unknownIdx = block.indexOf("pushTrace(ctx, `[cli:unknown-event]");
    assert.ok(markerIdx > block.indexOf('appendTraceEvent({'), 'marker should run after raw trace append');
    assert.ok(markerIdx < discriminateIdx, 'marker should run before discriminator filtering');
    assert.ok(markerIdx < unknownIdx, 'marker should run before unknown-event return path');

    assert.doesNotMatch(block, /ctx\.stallWatchdog\?\.markProgress\(\);\s*const dispatchCli/);
});
