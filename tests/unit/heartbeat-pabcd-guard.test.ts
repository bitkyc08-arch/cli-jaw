import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const heartbeatSrc = readFileSync(join(projectRoot, 'src/memory/heartbeat.ts'), 'utf8');
const routeSrc = readFileSync(join(projectRoot, 'src/routes/orchestrate.ts'), 'utf8');
const pipelineSrc = readFileSync(join(projectRoot, 'src/orchestrator/pipeline.ts'), 'utf8');

test('heartbeat guard checks PABCD state before orchestrateAndCollect', () => {
    const guardIdx = heartbeatSrc.indexOf("getState('default') !== 'IDLE'");
    const collectIdx = heartbeatSrc.indexOf('orchestrateAndCollect(prompt');

    assert.ok(heartbeatSrc.includes("import { getState } from '../orchestrator/state-machine.js'"));
    assert.ok(guardIdx > -1, 'heartbeat must check PABCD state');
    assert.ok(collectIdx > -1, 'heartbeat must still call orchestrateAndCollect for IDLE runs');
    assert.ok(guardIdx < collectIdx, 'PABCD guard must run before orchestrateAndCollect');
    assert.ok(heartbeatSrc.includes("'pabcd_active'"), 'defer reason must be structured');
    assert.ok(heartbeatSrc.includes("'defer'"), 'defer policy must be structured');
});

test('heartbeat exposes runtime state for snapshot recovery', () => {
    assert.ok(heartbeatSrc.includes('export function getHeartbeatRuntimeState'));
    assert.ok(heartbeatSrc.includes('deferredPending'));
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
