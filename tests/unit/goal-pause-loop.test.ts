import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand, executeCommand } from '../../src/cli/commands.ts';
import { buildGoalContinuation } from '../../src/goal/heartbeat.ts';
import {
    getActiveGoal,
    getAgentPauseCount,
    incrementAgentPauseCount,
    resetGoalStore,
    setGoal,
    updateGoal,
} from '../../src/goal/store.ts';
import { clearAllWorkers } from '../../src/orchestrator/worker-registry.ts';
import { resetState } from '../../src/orchestrator/state-machine.ts';

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

        const normal = buildGoalContinuation();
        assert.equal(normal.shouldContinue, true);
        assert.equal(normal.reason, 'goal_active');
        assert.doesNotMatch(normal.prompt ?? '', /AGENT PAUSE GATE/);
    } finally {
        cleanup();
    }
});
