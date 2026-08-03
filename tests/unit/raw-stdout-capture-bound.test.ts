import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(projectRoot, p), 'utf8');

/**
 * Only the paths that consume RAW child stdout need an accumulation bound: a
 * child stuck in a log loop streams straight into them. Paths fed by parsed
 * assistant events are already bounded upstream by the model, and capping them
 * silently truncated a real final answer once (commit 8b4ce983b).
 */
test('raw stdout accumulation stays bounded', () => {
    const agy = read('src/agent/agy-runtime.ts');
    assert.match(agy, /AGY_FULLTEXT_MAX_CHARS/);
    // Truncation must be announced, never silent.
    assert.match(agy, /AGY_FULLTEXT_TRUNCATION_NOTICE/);

    const kiro = read('src/agent/kiro-runtime.ts');
    assert.match(kiro, /ctx\.fullText\.length < maxBytes/);
});

test('the raw stdout handler routes through the bounded appender', () => {
    const spawnSrc = read('src/agent/spawn.ts');
    // If a future change appends raw stdout directly to fullText instead of
    // going through appendAgyFullText, the bound is silently lost.
    assert.match(spawnSrc, /appendAgyFullText\(ctx, text\)/);
});

test('every per-chunk stderr append is bounded', () => {
    // Streaming appends are the ones that can run away: they fire per data chunk
    // for the lifetime of the child. One-shot diagnostic appends (watchdog
    // context, transcript errors) add a single fixed-size sanitized block at
    // teardown and are intentionally exempt.
    const lines = read('src/agent/spawn.ts').split('\n');
    const streamingAppends: string[] = [];

    lines.forEach((line, index) => {
        if (!/ctx\.stderrBuf\s*\+=\s*text/.test(line)) return;
        const context = lines.slice(Math.max(0, index - 2), index + 1).join(' ');
        if (!/stderrBuf\.length < 4000/.test(context)) streamingAppends.push(line.trim());
    });

    assert.deepEqual(streamingAppends, [], 'a per-chunk stderr append must be capped');
});
