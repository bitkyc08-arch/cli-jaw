import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const heartbeatSrc = readFileSync(join(projectRoot, 'src/memory/heartbeat.ts'), 'utf8');
const queueSrc = readFileSync(join(projectRoot, 'src/agent/spawn/queue.ts'), 'utf8');
const routeSrc = readFileSync(join(projectRoot, 'src/routes/orchestrate.ts'), 'utf8');
const pipelineSrc = readFileSync(join(projectRoot, 'src/orchestrator/pipeline.ts'), 'utf8');

test('heartbeat guard checks PABCD state before orchestrateAndCollect', () => {
    const guardIdx = heartbeatSrc.indexOf("getState('default') !== 'IDLE'");
    // Anchored on the real call. The previous anchor, `orchestrateAndCollect(prompt`,
    // has not existed as a call since the runner moved to the data-returning form —
    // it survives only inside a comment, so this test was measuring the position of
    // a comment. Deleting that line would have failed the test; moving it above the
    // guard would have passed one with the guard removed (#443).
    const collectIdx = heartbeatSrc.indexOf('orchestrateAndCollectData(prompt');

    assert.ok(heartbeatSrc.includes("import { getState } from '../orchestrator/state-machine.js'"));
    assert.ok(guardIdx > -1, 'heartbeat must check PABCD state');
    assert.ok(collectIdx > -1, 'heartbeat must still run the collector for IDLE runs');
    assert.ok(guardIdx < collectIdx, 'PABCD guard must run before orchestrateAndCollect');
    assert.ok(heartbeatSrc.includes("'pabcd_active'"), 'defer reason must be structured');
    assert.ok(heartbeatSrc.includes("'defer'"), 'defer policy must be structured');
});

test('heartbeat defers while the main agent is busy', () => {
    const busyIdx = heartbeatSrc.indexOf('isAgentBusy(HEARTBEAT_SCOPE)');
    const collectIdx = heartbeatSrc.indexOf('orchestrateAndCollectData(prompt');

    assert.ok(heartbeatSrc.includes("import { isAgentBusy, messageQueue } from '../agent/spawn.js'"));
    assert.ok(heartbeatSrc.includes("'agent_busy'"), 'agent-busy defer reason must be structured');
    assert.ok(busyIdx > -1, 'heartbeat must check isAgentBusy before starting');
    assert.ok(collectIdx > -1, 'heartbeat must still run the collector for IDLE runs');
    assert.ok(busyIdx < collectIdx, 'agent-busy guard must run before orchestrateAndCollect');
    assert.match(
        heartbeatSrc,
        /queueHeartbeatJob\(job,\s*'agent_busy',\s*'defer'\)/,
        'busy main agent must defer the heartbeat instead of starting it',
    );
});

test('heartbeat drain respects main-agent and user-queue priority', () => {
    const drainIdx = heartbeatSrc.indexOf('export async function drainPending');
    const drainBlock = heartbeatSrc.slice(drainIdx, drainIdx + 500);

    assert.ok(heartbeatSrc.includes("import { hasPendingWorkerReplays } from '../orchestrator/worker-registry.js'"));
    assert.ok(drainIdx > -1, 'drainPending must exist');
    assert.ok(
        drainBlock.includes('isAgentBusy(HEARTBEAT_SCOPE) || messageQueue.length > 0 || hasPendingWorkerReplays(HEARTBEAT_SCOPE)'),
        'drain must wait for main idle, empty user queue, and replayed worker results',
    );
    assert.ok(drainBlock.includes('pendingJobs.shift()'), 'drain still consumes pending jobs once safe');
});

test('user queue drain triggers heartbeat drain only after normal queue priority clears', () => {
    const processIdx = queueSrc.indexOf('async function processQueue');
    const processBlock = queueSrc.slice(processIdx, processIdx + 1200);

    assert.ok(queueSrc.includes('function drainHeartbeatPendingSoon'), 'queue controller must expose heartbeat drain scheduling helper');
    assert.ok(queueSrc.includes("import('../../memory/heartbeat.js')"), 'heartbeat drain must be dynamic to avoid a static cycle');
    assert.ok(processBlock.includes('messageQueue.length === 0'), 'heartbeat drain hook must require an empty user queue');
    assert.ok(processBlock.includes('!deps.isSpawnBusy(requestedScope)'), 'heartbeat drain hook must require idle scoped main spawn state');
    assert.ok(processBlock.includes('!deps.hasPendingWorkerReplays(requestedScope)'), 'heartbeat drain hook must not preempt scoped worker replays');
});

test('heartbeat exposes runtime state for snapshot recovery', () => {
    assert.ok(heartbeatSrc.includes('export function getHeartbeatRuntimeState'));
    assert.ok(heartbeatSrc.includes('deferredPending'));
    assert.ok(heartbeatSrc.includes('agentBusyPending'));
    assert.ok(routeSrc.includes("import { getHeartbeatRuntimeState } from '../memory/heartbeat.js'"));
    assert.ok(routeSrc.includes('heartbeat: getHeartbeatRuntimeState()'));
});

test('PABCD reset drains deferred heartbeat queue after state returns to IDLE', () => {
    const resetIdx = pipelineSrc.indexOf('resetState(scope)');
    const drainIdx = pipelineSrc.indexOf("await import('../memory/heartbeat.js')");

    assert.ok(heartbeatSrc.includes('export async function drainPending'));
    assert.ok(resetIdx > -1, 'resetState call must exist');
    assert.ok(drainIdx > resetIdx, 'heartbeat drain must happen after resetState');
});
