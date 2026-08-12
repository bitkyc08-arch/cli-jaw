// Isolation MUST be the first import: tests/run.mts gives every file its own
// process but ONE shared CLI_JAW_HOME, so the eight files that call setGoal race
// on a single goal/active.json and setGoal's already-active guard fires on a
// sibling's goal (#288). ESM evaluates this module's side effects before the
// later imports, so the override lands before src/core/config.ts binds JAW_HOME.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommand, executeCommand } from '../../src/cli/commands.ts';
import { resetGoalStore, setGoal, updateGoal, getAgentPauseCount, getActiveGoal, getGoalHistory, pauseGoal } from '../../src/goal/store.ts';
import { GOAL_PLAN_PENDING_OBJECTIVE } from '../../src/goal/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlersSrc = readFileSync(join(__dirname, '../../src/cli/handlers-workflows.ts'), 'utf8');

async function runGoalCommand(command: string, iface: 'web' | 'telegram' = 'web') {
    const parsed = parseCommand(command);
    return executeCommand(parsed, { interface: iface, locale: 'en' });
}

function goalSubcommandBlock(subcommand: string): string {
    const marker = `if (sub === '${subcommand}')`;
    const start = handlersSrc.indexOf(marker);
    assert.notEqual(start, -1, `missing goal subcommand block: ${subcommand}`);
    const next = handlersSrc.indexOf('\n    if (sub === ', start + marker.length);
    return handlersSrc.slice(start, next === -1 ? handlersSrc.length : next);
}

test('/goal terminal commands bypass fireSteerForWebCli submitMessage path', () => {
    for (const subcommand of ['refine', 'done', 'cancel', 'pause', 'clear']) {
        const block = goalSubcommandBlock(subcommand);
        assert.doesNotMatch(block, /fireSteerForWebCli/);
        assert.doesNotMatch(block, /steerPrompt/);
    }
});

test('/goal set and resume still use the steering path', () => {
    assert.match(goalSubcommandBlock('set'), /fireSteerForWebCli/);
    assert.match(goalSubcommandBlock('resume'), /fireSteerForWebCli/);
});

test('/goalplan stores the hint separately and requires refine before checkpoint', async () => {
    resetGoalStore();
    try {
        const parsed = parseCommand('/goalplan investigate context loss');
        const planned = await executeCommand(parsed, { interface: 'telegram', locale: 'en' });
        assert.equal(planned?.ok, true);
        assert.match(planned?.text ?? '', /Goal plan activated: investigate context loss/);
        assert.match(planned?.steerPrompt ?? '', /cli-jaw goal refine/);

        const pending = getActiveGoal();
        assert.ok(pending);
        assert.equal(pending!.objective, GOAL_PLAN_PENDING_OBJECTIVE);
        assert.equal(pending!.goalMode, 'plan');
        assert.equal(pending!.planHint, 'investigate context loss');

        const status = await runGoalCommand('/goal status');
        assert.equal(status?.ok, true);
        assert.match(status?.text ?? '', /Mode: plan/);
        assert.match(status?.text ?? '', /Plan hint: investigate context loss/);

        const blockedUpdate = await runGoalCommand('/goal update premature checkpoint --evidence fake');
        assert.equal(blockedUpdate?.ok, false);
        assert.match(blockedUpdate?.text ?? '', /must be refined before checkpoints/);
        assert.equal(getActiveGoal()!.checkpoints.length, 0);

        const refined = await runGoalCommand('/goal refine Implement concrete context-preserving goalplan flow');
        assert.equal(refined?.ok, true);
        assert.match(refined?.text ?? '', /Goal refined/);
        assert.equal(getActiveGoal()!.objective, 'Implement concrete context-preserving goalplan flow');
        assert.equal(getActiveGoal()!.goalMode, 'direct');
        assert.equal(getActiveGoal()!.planHint, undefined);

        const allowedUpdate = await runGoalCommand('/goal update verified after refine --evidence focused test');
        assert.equal(allowedUpdate?.ok, true);
        assert.equal(getActiveGoal()!.checkpoints.length, 1);
    } finally {
        resetGoalStore();
    }
});

test('/goal replacement commands archive the previous goal instead of blocking', async () => {
    const cases = [
        {
            command: '/goal set replacement objective',
            expectedObjective: 'replacement objective',
            expectPlanMode: false,
        },
        {
            command: '/goal implement a different objective',
            expectedObjective: 'implement a different objective',
            expectPlanMode: false,
        },
        {
            command: '/goal plan investigate the next target',
            expectedObjective: GOAL_PLAN_PENDING_OBJECTIVE,
            expectedHint: 'investigate the next target',
            expectPlanMode: true,
        },
        {
            command: '/goalplan investigate the next target',
            expectedObjective: GOAL_PLAN_PENDING_OBJECTIVE,
            expectedHint: 'investigate the next target',
            expectPlanMode: true,
        },
    ];

    for (const item of cases) {
        resetGoalStore();
        try {
            setGoal('existing active goal');
            const result = await runGoalCommand(item.command, 'telegram');
            assert.equal(result?.ok, true, `${item.command} should replace the active goal`);
            assert.match(result?.text ?? '', /Previous goal archived: existing active goal/);
            assert.equal(result?.recovery, undefined);

            const active = getActiveGoal();
            assert.ok(active);
            assert.equal(active!.objective, item.expectedObjective);
            assert.equal(active!.goalMode, item.expectPlanMode ? 'plan' : undefined);
            assert.equal(active!.planHint, item.expectedHint);
            assert.equal(getGoalHistory().goals.length, 1);
            assert.equal(getGoalHistory().goals[0]!.objective, 'existing active goal');
            assert.equal(getGoalHistory().goals[0]!.status, 'active');
            assert.match(result?.steerPrompt ?? '', /new goal|goal plan/i);
        } finally {
            resetGoalStore();
        }
    }
});

test('/goal replacement commands also archive paused goals', async () => {
    resetGoalStore();
    try {
        setGoal('existing paused goal');
        assert.ok(pauseGoal({ reason: 'manual pause before replacement' }));

        const result = await runGoalCommand('/goal set replacement after pause', 'telegram');

        assert.equal(result?.ok, true);
        assert.match(result?.text ?? '', /Previous goal archived: existing paused goal/);
        assert.equal(getActiveGoal()!.objective, 'replacement after pause');
        assert.equal(getGoalHistory().goals.length, 1);
        assert.equal(getGoalHistory().goals[0]!.objective, 'existing paused goal');
        assert.equal(getGoalHistory().goals[0]!.status, 'paused');
    } finally {
        resetGoalStore();
    }
});

test('/goal done requires checkpoint evidence without spawning continuation text', async () => {
    resetGoalStore();
    try {
        setGoal('terminal done contract');
        const result = await runGoalCommand('/goal done final note');
        assert.equal(result?.ok, false);
        assert.equal('steerPrompt' in result, false);
        assert.match(result?.text ?? '', /requires verification evidence/);
    } finally {
        resetGoalStore();
    }
});

test('/gd force-completes without checkpoint evidence or continuation text', async () => {
    resetGoalStore();
    try {
        setGoal('terminal gd alias contract');
        const result = await runGoalCommand('/gd final note');
        assert.equal(result?.ok, true);
        assert.equal('steerPrompt' in result, false);
        assert.match(result?.text ?? '', /Goal completed/);
        assert.match(result?.text ?? '', /final note/);
    } finally {
        resetGoalStore();
    }
});

test('/goal done succeeds with checkpoint evidence without spawning continuation text', async () => {
    resetGoalStore();
    try {
        setGoal('terminal done evidence contract');
        updateGoal('verified', '', ['npm test pass']);
        const result = await runGoalCommand('/goal done final note');
        assert.equal(result?.ok, true);
        assert.equal('steerPrompt' in result, false);
        assert.match(result?.text ?? '', /Goal completed/);
    } finally {
        resetGoalStore();
    }
});

test('/goal done --force remains a quiet explicit manual override', async () => {
    resetGoalStore();
    try {
        setGoal('terminal done force contract');
        const result = await runGoalCommand('/goal done final note --force');
        assert.equal(result?.ok, true);
        assert.equal('steerPrompt' in result, false);
        assert.match(result?.text ?? '', /Goal completed/);
        assert.match(result?.text ?? '', /final note/);
    } finally {
        resetGoalStore();
    }
});

test('/goal pause does not return a steerPrompt or spawn continuation text', async () => {
    resetGoalStore();
    try {
        setGoal('terminal pause contract');
        const result = await runGoalCommand('/goal pause');
        assert.equal(result?.ok, true);
        assert.equal('steerPrompt' in result, false);
        assert.match(result?.text ?? '', /Goal paused/);
    } finally {
        resetGoalStore();
    }
});

test('/goal pause --agent requires audit evidence without spawning continuation text', async () => {
    resetGoalStore();
    try {
        setGoal('agent pause audit contract');
        const result = await runGoalCommand('/goal pause --agent');
        assert.equal(result?.ok, false);
        assert.equal('steerPrompt' in result, false);
        assert.match(result?.text ?? '', /requires independent audit evidence/);
    } finally {
        resetGoalStore();
    }
});

test('/goal pause --agent --audit blocked on first attempt (2-tap gate)', async () => {
    resetGoalStore();
    try {
        setGoal('2-tap gate first attempt');
        const result = await runGoalCommand('/goal pause --agent --audit reviewer says PASS');
        assert.equal(result?.ok, false);
        assert.match(result?.text ?? '', /First agent pause attempt/);
        assert.match(result?.text ?? '', /1\/2/);
        assert.equal(getAgentPauseCount(), 1);

        const status = await runGoalCommand('/goal status');
        assert.equal(status?.ok, true);
        assert.match(status?.text ?? '', /Pause gate: pending \(1\/2\)/);
        assert.match(status?.text ?? '', /Pause gate action:/);

        const json = await runGoalCommand('/goal --json');
        assert.equal(json?.ok, true);
        const parsed = JSON.parse(json?.text ?? '{}') as { pauseGate?: { armed?: boolean; reason?: string } };
        assert.equal(parsed.pauseGate?.armed, true);
        assert.equal(parsed.pauseGate?.reason, 'pause_gate_pending');
    } finally {
        resetGoalStore();
    }
});

test('/goal pause --agent --audit succeeds on second attempt (2-tap gate)', async () => {
    resetGoalStore();
    try {
        setGoal('2-tap gate second attempt');
        const result1 = await runGoalCommand('/goal pause --agent --audit first review');
        assert.equal(result1?.ok, false);
        const result2 = await runGoalCommand('/goal pause --agent --audit second review confirms PASS');
        assert.equal(result2?.ok, true);
        assert.equal('steerPrompt' in result2, false);
        assert.match(result2?.text ?? '', /Goal paused/);
        assert.equal(getAgentPauseCount(), 0);
    } finally {
        resetGoalStore();
    }
});

test('/goal pause without --agent always immediate (human path)', async () => {
    resetGoalStore();
    try {
        setGoal('human pause no gate');
        const result = await runGoalCommand('/goal pause');
        assert.equal(result?.ok, true);
        assert.match(result?.text ?? '', /Goal paused/);
    } finally {
        resetGoalStore();
    }
});

test('/goal cancel does not return a steerPrompt or spawn continuation text', async () => {
    resetGoalStore();
    try {
        setGoal('terminal cancel contract');
        const result = await runGoalCommand('/goal cancel no longer needed');
        assert.equal(result?.ok, true);
        assert.equal('steerPrompt' in result, false);
        assert.match(result?.text ?? '', /Goal cancelled/);
    } finally {
        resetGoalStore();
    }
});

test('/goal clear remains a quiet terminal state command', async () => {
    resetGoalStore();
    try {
        setGoal('terminal clear contract');
        const result = await runGoalCommand('/goal clear');
        assert.equal(result?.ok, true);
        assert.equal('steerPrompt' in result, false);
        assert.match(result?.text ?? '', /Active goal cleared/);
    } finally {
        resetGoalStore();
    }
});
