// Isolation MUST be the first import: tests/run.mts gives every file its own
// process but ONE shared CLI_JAW_HOME, so the eight files that call setGoal race
// on a single goal/active.json and setGoal's already-active guard fires on a
// sibling's goal (#288). ESM evaluates this module's side effects before the
// later imports, so the override lands before src/core/config.ts binds JAW_HOME.
import '../setup/isolated-home.ts';
import { readSource } from './source-normalize.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { goalToStatus } from '../../src/workflows/status.ts';
import { incrementAgentPauseCount, resetGoalStore, setGoal } from '../../src/goal/store.ts';

const __dirname = import.meta.dirname;
const projectRoot = join(__dirname, '../..');

const statusSrc = readSource(join(projectRoot, 'src/workflows/status.ts'), 'utf8');

const SDK_DENYLIST = ['openai', '@anthropic-ai/sdk', 'ai', '@ai-sdk/'];

test('WSJ-001: status module is SDK-free', () => {
    for (const sdk of SDK_DENYLIST) {
        assert.ok(!statusSrc.includes(`from '${sdk}`), `must not import ${sdk}`);
    }
});

test('WSJ-002: goal status conversion exists', () => {
    assert.ok(statusSrc.includes('goalToStatus'), 'must export goalToStatus');
});

test('WSJ-003: goal-run status conversion exists', () => {
    assert.ok(statusSrc.includes('goalRunToStatus'), 'must export goalRunToStatus');
});

test('WSJ-004: team status conversion exists', () => {
    assert.ok(statusSrc.includes('teamToStatus'), 'must export teamToStatus');
});

test('WSJ-005: status includes workflow discriminant', () => {
    assert.ok(statusSrc.includes("workflow: 'goal'"), 'must set goal workflow');
    assert.ok(statusSrc.includes("workflow: 'goal-run'"), 'must set goal-run workflow');
    assert.ok(statusSrc.includes("workflow: 'team'"), 'must set team workflow');
});

test('WSJ-006: status includes blockers array', () => {
    assert.ok(statusSrc.includes('blockers'), 'must include blockers');
});

test('WSJ-007: status includes confirmationRequired', () => {
    assert.ok(statusSrc.includes('confirmationRequired'), 'must include confirmation flag');
});

test('WSJ-008: status does not expose raw tokens or credentials', () => {
    assert.ok(!statusSrc.includes('claimToken'), 'must not expose claim tokens');
    assert.ok(!statusSrc.includes('apiKey'), 'must not expose API keys');
    assert.ok(!statusSrc.includes('password'), 'must not expose passwords');
});

test('WSJ-009: goal status exposes pause gate as blocker without changing active state', () => {
    resetGoalStore();
    try {
        const goal = setGoal('workflow pause gate status');
        incrementAgentPauseCount();

        const status = goalToStatus({ ...goal, agentPauseCount: 1 }, 'B');

        assert.equal(status?.state, 'active');
        assert.equal(status?.confirmationRequired, true);
        assert.equal(status?.blockers?.[0]?.code, 'goal-pause-gate-pending');
        assert.match(status?.blockers?.[0]?.message ?? '', /second audited agent pause/);
    } finally {
        resetGoalStore();
    }
});
