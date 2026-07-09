import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CLI_JAW_HOME = mkdtempSync(join(tmpdir(), 'cli-jaw-goal-pause-loop-'));

const { parseCommand, executeCommand } = await import('../../src/cli/commands.ts');
const { buildGoalContinuation } = await import('../../src/goal/heartbeat.ts');
const {
    getActiveGoal,
    getAgentPauseCount,
    incrementAgentPauseCount,
    resetGoalStore,
    setGoal,
    updateGoal,
} = await import('../../src/goal/store.ts');
const { describeGoalPauseGate } = await import('../../src/goal/pause-gate.ts');
const { clearAllWorkers } = await import('../../src/orchestrator/worker-registry.ts');
const { resetState } = await import('../../src/orchestrator/state-machine.ts');

async function runGoalCommand(command: string) {
    const parsed = parseCommand(command);
    return executeCommand(parsed, { interface: 'web', locale: 'en' });
}

function cleanup(): void {
    clearAllWorkers();
    resetState('default');
    resetGoalStore();
}

test('agent pause first tap arms pause_gate_pending and second tap pauses', async () => {
    cleanup();
    try {
        setGoal('pause loop regression');

        const first = await runGoalCommand('/goal pause --agent --audit first reviewer pass');
        assert.equal(first?.ok, false);
        assert.match(first?.text ?? '', /First agent pause attempt/);
        assert.equal(getAgentPauseCount(), 1);
        const pauseGate = describeGoalPauseGate(getActiveGoal());
        assert.equal(pauseGate.armed, true);
        assert.equal(pauseGate.attempts, 1);
        assert.equal(pauseGate.requiredAttempts, 2);
        assert.equal(pauseGate.reason, 'pause_gate_pending');

        const armed = buildGoalContinuation();
        assert.equal(armed.shouldContinue, true);
        assert.equal(armed.reason, 'pause_gate_pending');
        assert.match(armed.prompt ?? '', /This second audited call pauses the goal/);

        const second = await runGoalCommand('/goal pause --agent --audit second reviewer pass');
        assert.equal(second?.ok, true);
        assert.match(second?.text ?? '', /Goal paused/);
        assert.equal(getAgentPauseCount(), 0);
        assert.equal(getActiveGoal()?.status, 'paused');

        const halted = buildGoalContinuation();
        assert.equal(halted.shouldContinue, false);
        assert.equal(halted.reason, 'no_active_goal');
    } finally {
        cleanup();
    }
});

test('productive checkpoint clears pause gate and returns to normal goal continuation', () => {
    cleanup();
    try {
        setGoal('pause gate clears on progress');
        incrementAgentPauseCount();

        const armed = buildGoalContinuation();
        assert.equal(armed.reason, 'pause_gate_pending');

        const updated = updateGoal('made progress', 'continue implementation', ['focused test pass']);
        assert.ok(updated);
        assert.equal(getAgentPauseCount(), 0);
        assert.equal(describeGoalPauseGate(getActiveGoal()).armed, false);

        const normal = buildGoalContinuation();
        assert.equal(normal.shouldContinue, true);
        assert.equal(normal.reason, 'goal_active');
        assert.doesNotMatch(normal.prompt ?? '', /AGENT PAUSE GATE/);
    } finally {
        cleanup();
    }
});
