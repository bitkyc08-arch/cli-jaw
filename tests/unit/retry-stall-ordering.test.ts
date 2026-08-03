import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');
const handler = readFileSync(join(projectRoot, 'src', 'agent', 'lifecycle-handler.ts'), 'utf8');

/**
 * A stalled run must never be retried: the watchdog fires after work may already
 * have started, so respawning could repeat tool side effects.
 *
 * On the main path that exclusion is structural rather than a condition — the
 * stall branch resolves and returns before the 429 retry is reached. That is easy
 * to break by reordering, so the ordering itself is pinned here.
 */
test('the stall branch returns before the main 429 retry can fire', () => {
    const stallBranch = handler.indexOf('if (isStall) {');
    const retryBranch = handler.indexOf('effectiveIs429 && mainAttempt < MAIN_MAX_RETRIES');

    assert.ok(stallBranch > 0, 'stall branch must exist');
    assert.ok(retryBranch > 0, 'main 429 retry must exist');
    assert.ok(
        stallBranch < retryBranch,
        'a stalled run must be resolved before the 429 retry is considered',
    );

    const between = handler.slice(stallBranch, retryBranch);
    assert.match(
        between,
        /return;/,
        'the stall branch must return, otherwise a stalled run falls through into retry',
    );
});

test('the employee transient retry excludes stalls and auth failures explicitly', () => {
    const guard = handler.match(
        /if \(\(cls\.is429 \|\| cls\.isClaudeRateLimit \|\| cls\.isTransientStartup\)[^{]*\{/,
    );

    assert.ok(guard, 'employee transient retry guard must exist');
    assert.match(guard[0], /!cls\.isStall/);
    assert.match(guard[0], /!cls\.isAuth/);
});

test('retries stay bounded', () => {
    assert.match(handler, /const MAIN_MAX_RETRIES = \d+;/);
    assert.match(handler, /const EMP_MAX_RETRIES = \d+;/);
    // Jitter matters: without it, many clients failing at once retry in lockstep.
    assert.match(handler, /0\.5 \+ Math\.random\(\) \* 0\.5/);
});
