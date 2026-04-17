import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Static guards for the stop / steer / pending-queue regression fixes
// (devlog/_plan/steer/05_stop_steer_bug_report.md).
//
// These do not exercise runtime behavior — they pin the source-level
// invariants so the fixes don't silently regress.

const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
const orchestrateRouteSrc = fs.readFileSync(join(__dirname, '../../src/routes/orchestrate.ts'), 'utf8');

// ─── Fix A: stop should clear the queue ──────────────────────────────

test('Fix A: purgeQueueOnStop helper exists and clears queue + persisted DB rows', () => {
    const fnIdx = spawnSrc.indexOf('function purgeQueueOnStop');
    assert.ok(fnIdx > 0, 'purgeQueueOnStop helper must exist in spawn.ts');
    const body = spawnSrc.slice(fnIdx, fnIdx + 600);
    assert.ok(body.includes('messageQueue.splice(0)'), 'must drain messageQueue in place');
    assert.ok(body.includes('deleteQueuedMessage.run'), 'must remove persisted DB rows');
    assert.ok(body.includes("broadcast('queue_update'"), 'must broadcast pending=0 to clients');
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

test('Fix B: steer route uses peek → kill → wait → remove ordering', () => {
    const block = getSteerHandlerBlock();
    const peekIdx = block.indexOf('messageQueue.find');
    const killIdx = block.indexOf("killActiveAgent('steer')");
    const waitIdx = block.indexOf('waitForProcessEnd');
    const removeIdx = block.indexOf('removeQueuedMessage');
    assert.ok(peekIdx > 0 && killIdx > peekIdx, 'must peek before killing — otherwise a kill failure leaves the queue mutated');
    assert.ok(waitIdx > killIdx, 'must wait for process end after kill');
    assert.ok(removeIdx > waitIdx, 'must remove from queue only after the kill+wait succeeds');
});

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

// ─── Fix C1: stop should make isAgentBusy() return false synchronously ──

test('Fix C1: killActiveAgent nullifies activeProcess synchronously when stopped by user', () => {
    const fnIdx = spawnSrc.indexOf('export function killActiveAgent');
    const body = spawnSrc.slice(fnIdx, fnIdx + 2000);
    assert.ok(
        /reason === 'api'\s*\|\|\s*reason === 'user'[\s\S]*activeProcess\s*=\s*null/.test(body),
        "killActiveAgent must set activeProcess = null synchronously when reason is 'api' or 'user' so isAgentBusy() flips immediately",
    );
});

test('Fix C1: killAllAgents clears activeProcess + activeProcesses synchronously when stopped by user', () => {
    const fnIdx = spawnSrc.indexOf('export function killAllAgents');
    const body = spawnSrc.slice(fnIdx, fnIdx + 2500);
    assert.ok(
        /reason === 'api'\s*\|\|\s*reason === 'user'[\s\S]*activeProcess\s*=\s*null[\s\S]*activeProcesses\.clear\(\)/.test(body),
        "killAllAgents must synchronously clear activeProcess and activeProcesses for 'api'/'user' stops",
    );
});

test('Fix C2: kill helpers also clear worker registry on user stop (so submitMessage idle branch fires)', () => {
    const helperIdx = spawnSrc.indexOf('function clearWorkerSlotsOnStop');
    assert.ok(helperIdx > 0, 'clearWorkerSlotsOnStop helper must exist');
    const helperBody = spawnSrc.slice(helperIdx, helperIdx + 600);
    assert.ok(helperBody.includes('clearAllWorkers()'), 'helper must call clearAllWorkers from worker-registry');

    const killActiveIdx = spawnSrc.indexOf('export function killActiveAgent');
    const killActive = spawnSrc.slice(killActiveIdx, killActiveIdx + 2000);
    assert.ok(killActive.includes('clearWorkerSlotsOnStop'), 'killActiveAgent must call clearWorkerSlotsOnStop on user stop');

    const killAllIdx = spawnSrc.indexOf('export function killAllAgents');
    const killAll = spawnSrc.slice(killAllIdx, killAllIdx + 2500);
    assert.ok(killAll.includes('clearWorkerSlotsOnStop'), 'killAllAgents must call clearWorkerSlotsOnStop on user stop');
});

test('Fix B2: enqueueMessage returns the queue id and gateway threads it into SubmitResult.queuedId', () => {
    const enqueueIdx = spawnSrc.indexOf('export function enqueueMessage');
    const enqueue = spawnSrc.slice(enqueueIdx, enqueueIdx + 1200);
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
