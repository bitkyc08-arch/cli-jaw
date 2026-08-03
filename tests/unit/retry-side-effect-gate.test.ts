import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');
const handler = readFileSync(join(projectRoot, 'src', 'agent', 'lifecycle-handler.ts'), 'utf8');

/**
 * Retrying re-runs the same prompt, so any tool the previous attempt executed
 * runs a second time — another Slack message, another commit. `_skipInsert` only
 * suppresses the local chat row and does nothing about external effects.
 */
test('a run that executed tools is not retried', () => {
    assert.match(handler, /function performedSideEffects/);
    assert.match(handler, /ctx\.toolLog\.length > 0/);
});

test('both transient retry paths consult the side-effect gate', () => {
    const guards = [
        // main 429 retry
        /effectiveIs429 && !isStall\s*&& !performedSideEffects\(ctx\)/,
        // employee transient retry
        /!cls\.isStall && !cls\.isAuth\s*&& !performedSideEffects\(ctx\)/,
    ];

    for (const guard of guards) {
        assert.match(handler, guard, `retry path missing the side-effect gate: ${guard}`);
    }
});

test('a declined retry explains itself', () => {
    // Silence here would look like a missing feature rather than a decision.
    assert.match(handler, /tool call\(s\) already ran/);
    assert.match(handler, /re-running would repeat them/);
});

test('the gate does not disturb the stale-resume tool check', () => {
    // An existing guard uses the same "a real turn ran tools" reasoning; it must
    // keep its own explicit check rather than being folded into the new helper.
    assert.match(handler, /ctx\.toolLog\.length === 0/);
});
