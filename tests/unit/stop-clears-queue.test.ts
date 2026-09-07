import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Static guards for the stop / steer / pending-queue regression fixes.

// These do not exercise runtime behavior — they pin the source-level
// invariants so the fixes don't silently regress.

const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
const queueSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn/queue.ts'), 'utf8');
const orchestrateRouteSrc = fs.readFileSync(join(__dirname, '../../src/routes/orchestrate.ts'), 'utf8');

// ─── Fix A: stop should clear the queue ──────────────────────────────

test('Fix A: purgeQueueOnStop helper exists and clears queue + persisted DB rows', () => {
    const fnIdx = queueSrc.indexOf('function purgeQueueOnStop');
    assert.ok(fnIdx > 0, 'purgeQueueOnStop helper must exist in queue.ts');
    const body = queueSrc.slice(fnIdx, fnIdx + 1200);
    assert.ok(body.includes('messageQueue.splice(index, 1)'), 'must remove matching scoped rows in place');
    assert.ok(body.includes('deps.deleteQueuedMessage.run'), 'must remove persisted DB rows');
    assert.ok(body.includes("deps.broadcast('queue_update'"), 'must broadcast pending=0 to clients');
});

test("Fix A: killActiveAgent purges queue when reason='api' or 'user'", () => {
    const fnIdx = spawnSrc.indexOf('export function killActiveAgent');
    const body = spawnSrc.slice(fnIdx, fnIdx + 1500);
    assert.ok(
        /reason === 'api'\s*\|\|\s*reason === 'user'[\s\S]*purgeQueueOnStop/.test(body),
        "killActiveAgent must call purgeQueueOnStop when reason is 'api' or 'user'",
    );
});

test("Fix A: killAllAgents purges queue when reason='api' or 'user'", () => {
    const fnIdx = spawnSrc.indexOf('export function killAllAgents');
    const body = spawnSrc.slice(fnIdx, fnIdx + 2000);
    assert.ok(
        /reason === 'api'\s*\|\|\s*reason === 'user'[\s\S]*purgeQueueOnStop/.test(body),
        "killAllAgents must call purgeQueueOnStop when reason is 'api' or 'user'",
    );
});

// ─── Fix B: steer route must not double-insert / double-broadcast ─────

function getSteerHandlerBlock(): string {
    const routeIdx = orchestrateRouteSrc.indexOf("'/api/orchestrate/queue/:id/steer'");
    assert.ok(routeIdx > 0, 'steer route must exist');
    // Terminate at the next route registration so we only inspect this handler.
    const tail = orchestrateRouteSrc.slice(routeIdx);
    const nextRouteRel = tail.slice(50).search(/app\.(post|get|delete|put)\(/);
    const end = nextRouteRel > 0 ? nextRouteRel + 50 : tail.length;
    return tail.slice(0, end);
}

test('Fix B: steer route does not call submitMessage (avoids double insert+broadcast)', () => {
    const block = getSteerHandlerBlock();
    assert.ok(!block.includes('submitMessage('), 'steer route must NOT call submitMessage — that path re-inserts and re-broadcasts the user message');
});

// ACK-before-background-wait is exercised through the actual registered handler
// in queue-steer-main-wait.test.ts, with independently held main/exit gates.

test('Fix B: steer route inserts the user message exactly once and orchestrates with _skipInsert', () => {
    const block = getSteerHandlerBlock();
    assert.ok(block.includes('insertMessage.run'), 'must insert into messages table once (mirrors processQueue)');
    assert.ok(block.includes('_skipInsert: true'), 'must pass _skipInsert: true to orchestrate to avoid a second insert downstream');
    // Fix B4: steer broadcasts new_message with fromQueue: true so the web client
    // (which dropped the optimistic bubble at enqueue time) renders it now.
    const codeOnly = block.replace(/\/\/[^\n]*/g, '');
    const broadcastMatch = codeOnly.match(/broadcast\(\s*['"]new_message['"][^)]*\)/);
    assert.ok(broadcastMatch, 'must broadcast new_message when steer fires (web client renders here)');
    assert.ok(broadcastMatch[0].includes('fromQueue: true'), 'broadcast must include fromQueue: true');
});

test('Fix B: queued steer preserves routing metadata and rejects concurrent steer', () => {
    const block = getSteerHandlerBlock();
    assert.ok(block.includes('isSteerInProgress(scope)'), 'must reject a second queued steer in the same scope');
    assert.ok(block.includes("return fail(res, 409, 'steer already in progress')"), 'concurrent queued steer should be a 409 without removing the item');
    assert.ok(block.includes('const wasBusyBeforeSteer = isAgentBusy(scope)'), 'must capture scoped busy state before setting steer busy');
    assert.ok(block.includes('const target = peek.target'), 'must capture queue target metadata');
    assert.ok(block.includes('const chatId = peek.chatId'), 'must capture queue chatId metadata');
    assert.ok(block.includes('const requestId = peek.requestId'), 'must capture queue requestId metadata');
    assert.ok(block.includes('const steerMeta = stripUndefined({'), 'must build shared steer metadata');
    assert.ok(block.includes('chatSessionId'), 'shared steer metadata must preserve its chat session');
    assert.ok(block.includes('orchestrateReset({ ...steerMeta, _skipInsert: true })'), 'reset branch must preserve metadata');
    assert.ok(block.includes('orchestrateContinue({ ...steerMeta, _skipInsert: true })'), 'continue branch must preserve metadata');
    assert.ok(block.includes('orchestrate(prompt, { ...steerMeta, _skipInsert: true, _skipReplayDrain: true })'), 'normal branch must preserve metadata');
    // Matched loosely on purpose: the exact call text changed when the queued
    // steer began carrying `fromQueue` so a boot-drained failure can still be
    // delivered (#407). What matters is that the error keeps its routing.
    assert.match(
        block,
        /broadcast\('orchestrate_done',[\s\S]{0,200}error: true,[\s\S]{0,80}\.\.\.steerMeta/,
        'background errors must preserve metadata',
    );
});

// ─── Fix C1: stop should make scoped busy state false synchronously ──

test('Fix C1: killActiveAgent removes only the stopped scope synchronously', () => {
    const fnIdx = spawnSrc.indexOf('export function killActiveAgent');
    const body = spawnSrc.slice(fnIdx, fnIdx + 2500);
    assert.ok(
        /reason === 'api'\s*\|\|\s*reason === 'user'[\s\S]*activeMainProcesses\.delete\(scopeKey\)/.test(body),
        "killActiveAgent must remove the scope entry synchronously for user stops",
    );
});

test('Fix C1: killAllAgents clears scoped main and child registries synchronously', () => {
    const fnIdx = spawnSrc.indexOf('export function killAllAgents');
    const body = spawnSrc.slice(fnIdx, fnIdx + 2500);
    assert.ok(
        /reason === 'api'\s*\|\|\s*reason === 'user'[\s\S]*activeProcesses\.clear\(\)[\s\S]*activeMainProcesses\.clear\(\)/.test(body),
        "killAllAgents must synchronously clear activeProcesses and activeMainProcesses for user stops",
    );
});

test('Fix C2: kill helpers also clear worker registry on user stop (so submitMessage idle branch fires)', () => {
    const helperIdx = spawnSrc.indexOf('function clearWorkerSlotsOnStop');
    assert.ok(helperIdx > 0, 'clearWorkerSlotsOnStop helper must exist');
    const helperBody = spawnSrc.slice(helperIdx, helperIdx + 600);
    assert.ok(helperBody.includes('clearWorkersForScope(scopeKey)'), 'helper must clear only workers owned by the stopped scope');

    const killActiveIdx = spawnSrc.indexOf('export function killActiveAgent');
    const killActive = spawnSrc.slice(killActiveIdx, killActiveIdx + 2000);
    assert.ok(killActive.includes('clearWorkerSlotsOnStop'), 'killActiveAgent must call clearWorkerSlotsOnStop on user stop');

    const killAllIdx = spawnSrc.indexOf('export function killAllAgents');
    const killAll = spawnSrc.slice(killAllIdx, killAllIdx + 2500);
    assert.ok(killAll.includes('clearAllWorkers()'), 'killAllAgents must clear all workers on global user stop');
});

test('Fix C3: stop and steer clear stale main live-run snapshots synchronously', async () => {
    const spawn = await import('../../src/agent/spawn.ts');
    const liveRun = await import('../../src/agent/live-run-state.ts');

    liveRun.beginLiveRun('unit-stop-live-run', 'agy');
    liveRun.appendLiveRunText('unit-stop-live-run', 'intermediate output');
    spawn.setCurrentMainMeta('unit-stop-live-run', { origin: 'web', scopeId: 'unit-stop-live-run' });

    spawn.killActiveAgent('unit-stop-live-run', 'steer');

    assert.equal(liveRun.getLiveRun('unit-stop-live-run').running, false);
    assert.equal(liveRun.getLiveRun('unit-stop-live-run').text, '');

    liveRun.beginLiveRun('unit-stop-live-run', 'agy');
    spawn.setCurrentMainMeta('unit-stop-live-run', { origin: 'web', scopeId: 'unit-stop-live-run' });
    spawn.killAllAgents('user');

    assert.equal(liveRun.getLiveRun('unit-stop-live-run').running, false);
    spawn.setCurrentMainMeta('unit-stop-live-run', null);
});

test('Fix C3: non-stop kill reasons do not clear main live-run snapshots', async () => {
    const spawn = await import('../../src/agent/spawn.ts');
    const liveRun = await import('../../src/agent/live-run-state.ts');

    liveRun.beginLiveRun('unit-nonstop-live-run', 'agy');
    liveRun.appendLiveRunText('unit-nonstop-live-run', 'still running');
    spawn.setCurrentMainMeta('unit-nonstop-live-run', { origin: 'web', scopeId: 'unit-nonstop-live-run' });

    spawn.killActiveAgent('unit-nonstop-live-run', 'test');

    assert.equal(liveRun.getLiveRun('unit-nonstop-live-run').running, true);
    assert.equal(liveRun.getLiveRun('unit-nonstop-live-run').text, 'still running');
    liveRun.clearLiveRun('unit-nonstop-live-run');
    spawn.setCurrentMainMeta('unit-nonstop-live-run', null);
});

test('Fix B2: enqueueMessage returns the queue id and gateway threads it into SubmitResult.queuedId', () => {
    const enqueueIdx = queueSrc.indexOf('function enqueueMessage');
    const enqueue = queueSrc.slice(enqueueIdx, enqueueIdx + 1800);
    assert.ok(/\): string \{/.test(enqueue), 'enqueueMessage must declare string return type');
    assert.ok(/return item\.id/.test(enqueue), 'enqueueMessage must return the queue item id');

    const gatewaySrc = fs.readFileSync(join(__dirname, '../../src/orchestrator/gateway.ts'), 'utf8');
    assert.ok(/queuedId\?:\s*string/.test(gatewaySrc), 'SubmitResult must include optional queuedId');
    assert.ok(/const queuedId = enqueueMessage\(/.test(gatewaySrc), 'gateway must capture the returned queue id');
    assert.ok(/queued: true,\s*requestId,\s*queuedId/.test(gatewaySrc), 'gateway must include queuedId in the queued result');
});

// ─── Cross-cutting: steer reason must not trigger Fix A purge ─────────

test('Fix A is scoped: steer reason does NOT purge the queue', () => {
    // Confirm the guard in killActiveAgent matches specifically 'api' or 'user',
    // leaving 'steer' (and any other reason) untouched. We allow either an inline
    // single-statement guard or a multi-line block guard.
    const fnIdx = spawnSrc.indexOf('export function killActiveAgent');
    const body = spawnSrc.slice(fnIdx, fnIdx + 1500);
    const guard = body.match(/if\s*\(reason === '([^']+)'\s*\|\|\s*reason === '([^']+)'\)\s*\{?[\s\S]*?purgeQueueOnStop/);
    assert.ok(guard, 'purge guard must be a strict OR of two reasons followed by purgeQueueOnStop');
    const reasons = [guard[1], guard[2]];
    assert.ok(reasons.includes('api') && reasons.includes('user'), "guard must check 'api' and 'user'");
    assert.ok(!reasons.includes('steer'), "'steer' reason must not trigger queue purge — steer needs the queued item to survive temporarily");
});
