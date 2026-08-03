import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { classifyExitError } from '../../src/agent/error-classifier.js';

const projectRoot = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(projectRoot, p), 'utf8');

// ─── R-2: a startup failure is only transient before work began ───

const STARTUP_SIGNATURE = 'agent exited before SessionStart';

test('a startup failure with no output is still treated as transient', () => {
    const cls = classifyExitError('claude-e', 1, STARTUP_SIGNATURE, undefined, '', false);

    assert.equal(cls.isTransientStartup, true, 'pre-work failures must stay retryable');
});

test('the same signature after output is not treated as a startup failure', () => {
    // The classification promises "before work began". Once the run produced
    // output it is past startup, and re-running it would repeat that work.
    const cls = classifyExitError('claude-e', 1, STARTUP_SIGNATURE, undefined, '', true);

    assert.equal(cls.isTransientStartup, false, 'output means the run is past startup');
});

test('output state does not disturb genuine rate-limit classification', () => {
    const withOutput = classifyExitError('codex', 1, 'status: 429 Too Many Requests', undefined, '', true);

    assert.equal(withOutput.is429, true, '429 is orthogonal to how much output arrived');
});

// ─── R-1: the stall exclusion must not depend on branch order ───

test('the main 429 retry excludes stalls explicitly, not just by ordering', () => {
    const handler = read('src/agent/lifecycle-handler.ts');
    const guard = handler.match(/if \(!opts\.internal && !opts\._isFallback && effectiveIs429[^)]*\)/);

    assert.ok(guard, 'the main 429 retry guard must exist');
    assert.match(
        guard[0],
        /!isStall/,
        'a stalled run may already have produced side effects and must never be retried',
    );
});

// ─── E3: stall reports must say what last counted as progress ───

test('the watchdog distinguishes weak output liveness from real progress', () => {
    const watchdog = read('src/agent/watchdog.ts');

    assert.match(watchdog, /ProgressKind/);
    assert.match(watchdog, /markProgress\('output'\)/, 'raw output must be tagged as the weak signal');
    assert.match(watchdog, /markProgress\('rate-limit'\)/);
    assert.match(watchdog, /lastProgress=/, 'the stall reason must name the last progress kind');
});
