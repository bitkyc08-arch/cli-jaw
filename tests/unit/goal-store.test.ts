import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CLI_JAW_HOME = mkdtempSync(join(tmpdir(), 'cli-jaw-goal-store-'));

const {
    getActiveGoal, getGoalHistory, setGoal, updateGoal,
    completeGoal, cancelGoal, pauseGoal, resumeGoal, refineObjective,
    clearGoal, resetGoalStore, MAX_GOAL_OBJECTIVE_CHARS, MAX_GOAL_PLAN_HINT_CHARS,
    getAgentPauseCount, incrementAgentPauseCount, resetAgentPauseCount,
} = await import('../../src/goal/store.ts');
const { GOAL_PLAN_PENDING_OBJECTIVE } = await import('../../src/goal/types.ts');

beforeEach(() => { resetGoalStore(); });

describe('Goal Store', () => {
    test('1. no active goal initially', () => {
        assert.equal(getActiveGoal(), null);
    });

    test('2. setGoal creates active goal', () => {
        const goal = setGoal('Build auth system');
        assert.equal(goal.status, 'active');
        assert.equal(goal.objective, 'Build auth system');
        assert.ok(goal.id.length > 0);
    });

    test('3. getActiveGoal returns persisted goal', () => {
        setGoal('Test persistence');
        const goal = getActiveGoal();
        assert.ok(goal);
        assert.equal(goal!.objective, 'Test persistence');
    });

    test('4. updateGoal adds checkpoint', () => {
        setGoal('Checkpoint test');
        const updated = updateGoal('Phase 1 done', 'Start Phase 2');
        assert.ok(updated);
        assert.equal(updated!.checkpoints.length, 1);
        assert.equal(updated!.lastCheckpoint!.summary, 'Phase 1 done');
        assert.equal(updated!.lastCheckpoint!.nextAction, 'Start Phase 2');
    });

    test('4b. updateGoal clears a pending agent pause gate', () => {
        setGoal('Checkpoint clears pause gate');
        incrementAgentPauseCount();
        assert.equal(getAgentPauseCount(), 1);

        const updated = updateGoal('productive progress', 'continue', ['focused test pass']);

        assert.ok(updated);
        assert.equal(getAgentPauseCount(), 0);
    });

    test('5. updateGoal fails with no active goal', () => {
        assert.equal(updateGoal('orphan'), null);
    });

    test('6. completeGoal moves to history', () => {
        setGoal('Complete me');
        const completed = completeGoal('All done');
        assert.ok(completed);
        assert.equal(completed!.status, 'complete');
        assert.equal(completed!.completionNote, 'All done');
        assert.equal(getActiveGoal(), null);
        assert.equal(getGoalHistory().goals.length, 1);
    });

    test('7. cancelGoal moves to history', () => {
        setGoal('Cancel me');
        const cancelled = cancelGoal('Changed plans');
        assert.ok(cancelled);
        assert.equal(cancelled!.status, 'cancelled');
        assert.equal(getActiveGoal(), null);
        assert.equal(getGoalHistory().goals.length, 1);
    });

    test('8. pauseGoal and resumeGoal cycle', () => {
        setGoal('Pause test');
        const paused = pauseGoal({
            reason: 'Need external auth',
            audit: {
                actor: 'agent',
                evidence: 'Independent reviewer confirmed no local auth path remains.',
                timestamp: '2026-06-02T00:00:00.000Z',
            },
        });
        assert.ok(paused);
        assert.equal(paused!.status, 'paused');
        assert.equal(paused!.agentPauseCount, 0);
        assert.equal(paused!.pauseReason, 'Need external auth');
        assert.equal(paused!.pauseAudit?.actor, 'agent');
        assert.match(paused!.pauseAudit?.evidence ?? '', /Independent reviewer/);
        assert.equal(getActiveGoal()!.status, 'paused');

        const resumed = resumeGoal();
        assert.ok(resumed);
        assert.equal(resumed!.status, 'active');
        assert.equal(resumed!.agentPauseCount, 0);
    });

    test('9. pauseGoal fails with no active goal', () => {
        assert.equal(pauseGoal(), null);
    });

    test('9b. pauseGoal can attach agent audit to an already paused goal', () => {
        setGoal('Pause audit backfill test');
        assert.ok(pauseGoal());

        const pausedWithAudit = pauseGoal({
            audit: {
                actor: 'agent',
                evidence: 'Independent reviewer found no viable remaining path after plain pause.',
                timestamp: '2026-06-02T00:00:00.000Z',
            },
        });

        assert.ok(pausedWithAudit);
        assert.equal(pausedWithAudit!.status, 'paused');
        assert.equal(pausedWithAudit!.agentPauseCount, 0);
        assert.equal(pausedWithAudit!.pauseAudit?.actor, 'agent');
        assert.match(pausedWithAudit!.pauseAudit?.evidence ?? '', /Independent reviewer/);
    });

    test('10. resumeGoal fails with non-paused goal', () => {
        setGoal('Not paused');
        assert.equal(resumeGoal(), null);
    });

    test('11. clearGoal archives and removes active', () => {
        setGoal('Clear me');
        assert.ok(clearGoal());
        assert.equal(getActiveGoal(), null);
        assert.equal(getGoalHistory().goals.length, 1);
    });

    test('12. clearGoal returns false with no goal', () => {
        assert.equal(clearGoal(), false);
    });

    test('13. resetGoalStore clears everything', () => {
        setGoal('Will be reset');
        completeGoal();
        setGoal('Another goal');
        resetGoalStore();
        assert.equal(getActiveGoal(), null);
        assert.equal(getGoalHistory().goals.length, 0);
    });

    test('14. setGoal rejects when active goal exists without replace', () => {
        setGoal('First goal');
        assert.throws(() => setGoal('Second goal'), /Active goal already exists/);
        assert.equal(getActiveGoal()!.objective, 'First goal');
    });

    test('14b. setGoal with replace archives existing active goal', () => {
        setGoal('First goal');
        setGoal('Second goal', { replace: true });
        assert.equal(getActiveGoal()!.objective, 'Second goal');
        assert.equal(getGoalHistory().goals.length, 1);
        assert.equal(getGoalHistory().goals[0]!.objective, 'First goal');
    });

    test('15. setGoal with repoRoot', () => {
        const goal = setGoal('With repo', { repoRoot: '/some/path' });
        assert.equal(goal.repoRoot, '/some/path');
    });

    test('16. history limit capped at 50', () => {
        for (let i = 0; i < 55; i++) {
            setGoal(`Goal ${i}`);
            completeGoal();
        }
        assert.equal(getGoalHistory().goals.length, 50);
    });

    test('17. setGoal accepts objectives up to 10000 characters', () => {
        const objective = 'x'.repeat(MAX_GOAL_OBJECTIVE_CHARS);
        const goal = setGoal(objective);
        assert.equal(goal.objective.length, MAX_GOAL_OBJECTIVE_CHARS);
    });

    test('18. setGoal rejects objectives over 10000 characters', () => {
        const objective = 'x'.repeat(MAX_GOAL_OBJECTIVE_CHARS + 1);
        assert.throws(() => setGoal(objective), /10000 characters/);
    });

    test('19. agentPauseCount defaults to 0', () => {
        setGoal('pause count default');
        assert.equal(getAgentPauseCount(), 0);
    });

    test('20. incrementAgentPauseCount increments and persists', () => {
        setGoal('pause count increment');
        incrementAgentPauseCount();
        assert.equal(getAgentPauseCount(), 1);
        incrementAgentPauseCount();
        assert.equal(getAgentPauseCount(), 2);
    });

    test('21. resetAgentPauseCount resets to 0', () => {
        setGoal('pause count reset');
        incrementAgentPauseCount();
        incrementAgentPauseCount();
        assert.equal(getAgentPauseCount(), 2);
        resetAgentPauseCount();
        assert.equal(getAgentPauseCount(), 0);
    });

    test('22. incrementAgentPauseCount fails with no active goal', () => {
        assert.equal(incrementAgentPauseCount(), null);
    });

    test('23. resetAgentPauseCount is no-op with no active goal', () => {
        resetAgentPauseCount();
        assert.equal(getAgentPauseCount(), 0);
    });

    test('24. plan-mode goal stores hint separately from pending objective', () => {
        const goal = setGoal(GOAL_PLAN_PENDING_OBJECTIVE, {
            goalMode: 'plan',
            planHint: 'investigate goalplan context loss',
        });

        assert.equal(goal.objective, GOAL_PLAN_PENDING_OBJECTIVE);
        assert.equal(goal.goalMode, 'plan');
        assert.equal(goal.planHint, 'investigate goalplan context loss');
        assert.notEqual(goal.objective, goal.planHint);
    });

    test('25. plan-mode goal rejects checkpoints before refinement', () => {
        setGoal(GOAL_PLAN_PENDING_OBJECTIVE, {
            goalMode: 'plan',
            planHint: 'must refine first',
        });

        assert.equal(updateGoal('started without refine'), null);
        assert.equal(getActiveGoal()!.checkpoints.length, 0);
    });

    test('26. refineObjective finalizes plan-mode goal and clears hint', () => {
        setGoal(GOAL_PLAN_PENDING_OBJECTIVE, {
            goalMode: 'plan',
            planHint: 'raw hint only',
        });
        incrementAgentPauseCount();

        const refined = refineObjective('Implement refined goal objective');

        assert.ok(refined);
        assert.equal(refined!.objective, 'Implement refined goal objective');
        assert.equal(refined!.goalMode, 'direct');
        assert.equal(refined!.planHint, undefined);
        assert.equal(refined!.agentPauseCount, 0);
        assert.ok(updateGoal('verified after refine'));
    });

    test('27. setGoal rejects overlong plan hints', () => {
        assert.throws(() => setGoal(GOAL_PLAN_PENDING_OBJECTIVE, {
            goalMode: 'plan',
            planHint: 'x'.repeat(MAX_GOAL_PLAN_HINT_CHARS + 1),
        }), /plan hint exceeds/);
    });
});
