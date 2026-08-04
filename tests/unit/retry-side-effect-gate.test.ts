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
test('only effectful tools block a retry', () => {
    assert.match(handler, /function performedSideEffects/);
    // Blocking on ANY tool would turn "long turn, rate-limited on the final
    // model call" into a hard failure even for a read-only run.
    assert.match(handler, /REPEATABLE_TOOL_TYPES/);
    assert.match(handler, /'search'/);
    assert.match(handler, /'thinking'/);
    assert.match(handler, /some\(tool => !REPEATABLE_TOOL_TYPES\.has\(tool\.toolType\)\)/);
});

test('an unknown tool type is treated as effectful', () => {
    // A newly added tool kind must fail closed rather than silently becoming
    // retryable.
    const repeatable = new Set(['search', 'thinking']);
    const performed = (types: string[]): boolean => types.some(t => !repeatable.has(t));

    assert.equal(performed(['search', 'thinking']), false, 'read-only runs stay retryable');
    assert.equal(performed(['search', 'command']), true, 'a command is effectful');
    assert.equal(performed(['file']), true, 'a file write is effectful');
    assert.equal(performed(['some-new-tool']), true, 'unknown types must fail closed');
    assert.equal(performed([]), false, 'a run with no tools is retryable');
});

test('every path that re-runs the prompt consults the side-effect gate', () => {
    const guards = [
        // main 429 retry
        /effectiveIs429 && !isStall\s*&& !performedSideEffects\(ctx\)/,
        // employee transient retry
        /!cls\.isStall && !cls\.isAuth\s*&& !performedSideEffects\(ctx\)/,
        // fallback to another CLI re-runs the same prompt too
        /!suppressClaudeRateLimitFallback && !performedSideEffects\(ctx\)/,
    ];

    for (const guard of guards) {
        assert.match(handler, guard, `retry path missing the side-effect gate: ${guard}`);
    }
});

test('a declined retry explains itself', () => {
    // Silence here would look like a missing feature rather than a decision.
    assert.match(handler, /already executed effectful tools/);
    assert.match(handler, /re-running would repeat them/);
});

test('the gate does not disturb the stale-resume tool check', () => {
    // An existing guard uses the same "a real turn ran tools" reasoning; it must
    // keep its own explicit check rather than being folded into the new helper.
    assert.match(handler, /ctx\.toolLog\.length === 0/);
});
