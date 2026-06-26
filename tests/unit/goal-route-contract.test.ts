import { readSource } from './source-normalize.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const __dirname = import.meta.dirname;
const projectRoot = join(__dirname, '../..');

const routeSrc = readSource(join(projectRoot, 'src/routes/goal.ts'), 'utf8');
const serverSrc = readSource(join(projectRoot, 'server.ts'), 'utf8');
const handlerSrc = readSource(join(projectRoot, 'src/cli/handlers-workflows.ts'), 'utf8');
const storeSrc = readSource(join(projectRoot, 'src/goal/store.ts'), 'utf8');
const goalCliSrc = readSource(join(projectRoot, 'bin/commands/goal.ts'), 'utf8');
const typesSrc = readSource(join(projectRoot, 'src/goal/types.ts'), 'utf8');

test('GR-001: goal route registers GET and POST /api/goal', () => {
    assert.ok(routeSrc.includes("'/api/goal'"), 'must register /api/goal');
    assert.ok(routeSrc.includes('app.get'), 'must have GET handler');
    assert.ok(routeSrc.includes('app.post'), 'must have POST handler');
});

test('GR-002: goal route has history endpoint', () => {
    assert.ok(routeSrc.includes("'/api/goal/history'"), 'must register /api/goal/history');
});

test('GR-003: goal route requires objective for set action', () => {
    assert.ok(routeSrc.includes("'objective is required'"), 'set action must validate objective');
});

test('GR-003b: goal route caps objective at 10000 characters', () => {
    assert.ok(routeSrc.includes('MAX_GOAL_OBJECTIVE_CHARS'), 'route should import the goal objective limit');
    assert.ok(routeSrc.includes('objective must be ${MAX_GOAL_OBJECTIVE_CHARS} characters or fewer'),
        'route should reject objectives over the configured limit');
});

test('GR-004: goal route supports clear and reset without confirmation', () => {
    const clearStart = routeSrc.indexOf("case 'clear':");
    const resetStart = routeSrc.indexOf("case 'reset':", clearStart);
    assert.notEqual(clearStart, -1, 'clear action must exist');
    assert.notEqual(resetStart, -1, 'reset action must exist');
    const clearBlock = routeSrc.slice(clearStart, resetStart);
    assert.doesNotMatch(clearBlock, /confirm/, 'clear must not require confirm');
    assert.ok(routeSrc.includes('reset'), 'reset action must exist');
});

test('GR-005: server.ts registers goal routes', () => {
    assert.ok(serverSrc.includes('registerGoalRoutes'), 'server must register goal routes');
});

test('GR-006: goal handler supports all subcommands', () => {
    for (const sub of ['set', 'plan', 'refine', 'status', 'update', 'done', 'cancel', 'pause', 'resume', 'clear', 'reset', 'history']) {
        assert.ok(
            handlerSrc.includes(`sub === '${sub}'`),
            `handler must support /${sub} subcommand`,
        );
    }
});

test('GR-007: goal handler supports /goal run with preflight', () => {
    assert.ok(handlerSrc.includes("sub === 'run'"), 'handler must check for run subcommand');
    assert.ok(handlerSrc.includes('preflight') && handlerSrc.includes('allGatesPassed'), 'run must check preflight gates');
});

test('GR-008: goal store uses atomic writes', () => {
    assert.ok(storeSrc.includes('.tmp'), 'store must use tmp file for atomic writes');
    assert.ok(storeSrc.includes('renameSync'), 'store must rename tmp to target');
});

test('GR-009: goal store archives to history on clear/complete/cancel', () => {
    assert.ok(storeSrc.includes('archiveGoal'), 'store must have archive helper');
});

test('GR-010: agent pause requires independent audit evidence while manual pause remains available', () => {
    assert.ok(routeSrc.includes("body?.actor === 'agent'"), 'route must distinguish explicit agent pause');
    assert.ok(routeSrc.includes('Agent-initiated goal pause requires independent audit evidence'), 'agent pause must reject missing audit evidence');
    assert.ok(routeSrc.includes('pauseGoal({'), 'route must pass pause metadata into the store');
    assert.ok(storeSrc.includes('pauseAudit'), 'store must persist pause audit metadata');
});

test('GR-011: goal CLI exposes agent pause audit flags', () => {
    assert.ok(goalCliSrc.includes('--agent --audit'), 'CLI help should document audited agent pause');
    assert.ok(goalCliSrc.includes("payload.actor = 'agent'"), 'CLI should mark explicit agent pause');
    assert.ok(goalCliSrc.includes('payload.audit'), 'CLI should send audit evidence');
    assert.ok(goalCliSrc.includes('!process.stdin.isTTY'), 'non-interactive CLI pause should not silently take the manual path');
    assert.ok(goalCliSrc.includes('Non-interactive goal pause must use'), 'non-interactive pause should require agent audit wording');
});

test('GR-012: store exports refineObjective for plan-mode confirmation', () => {
    assert.ok(storeSrc.includes('refineObjective'), 'store must export refineObjective');
    assert.ok(storeSrc.includes("goal.goalMode = 'direct'"), 'refineObjective must transition goalMode to direct');
    assert.ok(storeSrc.includes('delete goal.planHint'), 'refineObjective must clear plan hints after final objective selection');
});

test('GR-013: route supports refine-objective action', () => {
    assert.ok(routeSrc.includes("'refine-objective'"), 'route must handle refine-objective action');
    assert.ok(routeSrc.includes('refineObjective'), 'route must call refineObjective from store');
});

test('GR-014: store and types support GoalMode', () => {
    assert.ok(typesSrc.includes("'direct' | 'plan'"), 'types must define GoalMode union');
    assert.ok(typesSrc.includes('goalMode?'), 'GoalState must have optional goalMode');
    assert.ok(storeSrc.includes('goalMode: opts?.goalMode'), 'setGoal must persist goalMode');
});

test('GR-015: goal CLI supports plan subcommand', () => {
    assert.ok(goalCliSrc.includes("sub === 'plan'"), 'CLI must handle plan subcommand');
    assert.ok(goalCliSrc.includes("goalMode: 'plan'"), 'CLI plan must send goalMode plan');
    assert.ok(goalCliSrc.includes('GOAL_PLAN_PENDING_OBJECTIVE'), 'CLI plan should store pending objective instead of raw hint');
    assert.ok(goalCliSrc.includes('planHint'), 'CLI plan should send hint separately');
    assert.ok(goalCliSrc.includes('replace: true'), 'CLI plan should replace/archive an existing active goal');
});

test('GR-016: plan-mode goals store planHint and block updates before refine', () => {
    assert.ok(typesSrc.includes('GOAL_PLAN_PENDING_OBJECTIVE'), 'types must define a pending plan objective');
    assert.ok(typesSrc.includes('planHint?'), 'GoalState must store planHint separately');
    assert.ok(routeSrc.includes('planHint'), 'route set action should accept planHint');
    assert.ok(routeSrc.includes('MAX_GOAL_PLAN_HINT_CHARS'), 'route should cap planHint size before persistence');
    assert.ok(routeSrc.includes('must be refined before checkpoints'), 'route update should reject plan-mode checkpoints');
    assert.ok(handlerSrc.includes('must be refined before checkpoints'), 'slash update should reject plan-mode checkpoints');
});

test('GR-017: goal refine surfaces are documented in CLI and command metadata', () => {
    assert.ok(goalCliSrc.includes('refine <objective>'), 'CLI help must document goal refine');
    assert.ok(goalCliSrc.includes("'refine-objective'"), 'CLI refine should call refine-objective action');
    assert.ok(handlerSrc.includes("sub === 'refine'"), 'slash handler must support /goal refine');
    assert.ok(handlerSrc.includes('refineObjective(objective)'), 'slash refine must call refineObjective');
});

test('GR-018: goal replacement UX archives existing active or paused goals instead of blocking slash commands', () => {
    assert.ok(routeSrc.includes('body?.replace === true'), 'route must require explicit replace for generic API replacement');
    assert.ok(routeSrc.includes("goalMode === 'plan'"), 'route must allow plan-mode set to replace an existing goal');
    assert.ok(routeSrc.includes('replaceExisting ? { replace: true }'), 'route must pass replace through to setGoal');
    assert.ok(routeSrc.includes('!replaceExisting'), 'route must preserve the 409 guard for non-replacement API calls');
    assert.ok(goalCliSrc.includes('payload.replace = true'), 'CLI goal set must mark replacement intent');
    assert.ok(handlerSrc.includes('Previous goal archived'), 'slash handler must tell the user the previous goal was archived');
    assert.ok(handlerSrc.includes('replace: true'), 'slash handler must use store replacement semantics');
    assert.doesNotMatch(handlerSrc, /recoverableGoalConflict/, 'slash goal creation must no longer use active-goal conflict recovery');
});

test('GR-019: goal API exposes derived pauseGate without persisting a new status', () => {
    assert.ok(routeSrc.includes('describeGoalPauseGate'), 'route must import derived pause gate helper');
    assert.ok(routeSrc.includes('pauseGate: describeGoalPauseGate(goal)'), 'GET /api/goal must expose pauseGate sibling');
    assert.ok(routeSrc.includes('pauseGate: describeGoalPauseGate(armedGoal)'), 'first agent pause 409 must expose armed pauseGate');
    assert.doesNotMatch(typesSrc, /waiting-for-user/, 'P1 must not add waiting-for-user status');
});
