// #439 / #441: two shutdown-and-goal failures that only showed up in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');
const serverSrc = fs.readFileSync(join(root, 'server.ts'), 'utf8');
const lifecycleSrc = fs.readFileSync(join(root, 'src/agent/lifecycle-handler.ts'), 'utf8');

// ─── #439: the database outlives the handlers that write to it ───

test('SHUT-439a: shutdown waits for agent exits before closing the database', () => {
    // Ordering is the whole defect: killAllAgents returns after signalling, and
    // the exit handler that persists the turn runs later. Asserted on source
    // because reproducing it needs a real child, a real SIGTERM and a real
    // sqlite handle — an integration fixture, and npm test does not run those.
    const barrier = serverSrc.indexOf('await waitForAllProcessesEnd()');
    const close = serverSrc.indexOf('closeDb();');
    assert.ok(barrier > -1, 'shutdown must wait for in-flight agent exits');
    assert.ok(close > -1);
    assert.ok(barrier < close, 'the wait must come BEFORE closeDb, or it changes nothing');
});

test('SHUT-439b: the wait is bounded so a wedged child cannot hang shutdown', async () => {
    const { waitForAllProcessesEnd } = await import('../../src/agent/spawn.ts');
    const started = Date.now();
    await waitForAllProcessesEnd(200);
    assert.ok(Date.now() - started < 2_000, 'must return promptly when nothing is running');
});

// ─── #441: cancelling was easier than completing ───

test('GOAL-441a: an AI /goal cancel marker no longer destroys the goal', () => {
    const cancelBranch = lifecycleSrc.slice(lifecycleSrc.indexOf('GOAL_CANCEL_RE.test'));
    const nextBranch = cancelBranch.indexOf('GOAL_PAUSE_RE.test');
    const body = cancelBranch.slice(0, nextBranch > -1 ? nextBranch : 800);

    assert.doesNotMatch(body, /cancelGoal\(\)/,
        'model output must not be able to archive a goal with no evidence gate, '
        + 'when /goal done next door requires verification');
    assert.match(body, /clearGoalTimers\(\)/,
        'the continuation loop should still stop — that part is reversible');
});

test('GOAL-441b: completing still demands evidence', () => {
    assert.match(lifecycleSrc, /goalHasCompletionEvidence\(activeGoal\)/,
        'the /goal done gate must remain');
});

