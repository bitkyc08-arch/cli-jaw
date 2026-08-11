import { readSource } from './source-normalize.js';
// PABCD 검증: state machine + worker dispatch + orchestrate structure
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createQueueController } from '../../src/agent/spawn/queue.ts';
import { SessionLanes } from '../../src/orchestrator/session-lanes.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pipelineSrc = readSource(join(__dirname, '../../src/orchestrator/pipeline.ts'), 'utf8');
const spawnSrc = readSource(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
const queueSrc = readSource(join(__dirname, '../../src/agent/spawn/queue.ts'), 'utf8');
const stateMachineSrc = readSource(join(__dirname, '../../src/orchestrator/state-machine.ts'), 'utf8');
const routeSrc = readSource(join(__dirname, '../../src/routes/orchestrate.ts'), 'utf8');

// ─── VR: PABCD State Machine 구조 검증 ───────────────

test('VR-001: pipeline imports getState from state-machine', () => {
    assert.match(
        pipelineSrc,
        /import\s*\{[\s\S]*\bgetState\b[\s\S]*\}\s*from '\.\/state-machine\.js';/,
        'pipeline must import getState from state-machine',
    );
});

test('VR-002: state machine defines PABCD dispatch phases', () => {
    assert.ok(
        stateMachineSrc.includes('P: `') &&
        stateMachineSrc.includes('A: `') &&
        stateMachineSrc.includes('B: `') &&
        stateMachineSrc.includes('C: `'),
        'state machine should define active PABCD prompt states P/A/B/C',
    );
});

test('VR-003: pipeline drains pending worker results via recursive orchestrate', () => {
    assert.ok(pipelineSrc.includes('listPendingWorkerResults'), 'pipeline should drain pending worker results');
    assert.ok(pipelineSrc.includes('_skipReplayDrain'), 'recursive calls should skip re-draining');
});

test('VR-004: dispatch route handles worker failure gracefully', () => {
    assert.ok(routeSrc.includes('failWorker(slot.agentId'), 'should call failWorker on error');
    assert.ok(pipelineSrc.includes('failed:'), 'should log worker failure');
});

test('VR-005: state machine has PABCD transition guards', () => {
    assert.ok(stateMachineSrc.includes('VALID_TRANSITIONS'), 'must define valid transition map');
    assert.ok(stateMachineSrc.includes("IDLE: ['I', 'P']"), 'IDLE should allow I and P transitions');
    assert.ok(stateMachineSrc.includes("C: ['I', 'D', 'B', 'P']"), 'C should transition to D');
});

test('VR-006: state machine exports canTransition', () => {
    assert.ok(stateMachineSrc.includes('export function canTransition'), 'canTransition must be exported');
});

// ─── RV: PABCD Prefix Map 검증 ──────────────────────

test('RV-001: state machine has PLANNING, AUDIT, and BUILD prefixes', () => {
    assert.ok(stateMachineSrc.includes('PLANNING MODE'), 'P state should have PLANNING prefix');
    assert.ok(stateMachineSrc.includes('PLAN AUDIT'), 'A state should have AUDIT prefix');
    assert.ok(stateMachineSrc.includes('IMPLEMENTATION REVIEW'), 'B state should have BUILD prefix');
});

// ─── QP: Queue Policy 검증 ───────────────────────────

test('QP-001: queue policy is documented as "fair"', () => {
    assert.ok(
        queueSrc.includes('Queue policy: "fair"'),
        'queue.ts should document fair queue policy',
    );
});

test('QP-002: queued messages retain fair FIFO ordering', async () => {
    let busy = true;
    const runs: string[] = [];
    const controller = createQueueController({
        migrateQueuedMessagesV1ToV2() {},
        isSpawnBusy: () => busy,
        hasBlockingWorkers: () => false,
        hasPendingWorkerReplays: () => false,
        insertMessage: { run() {} },
        getActiveChatSession: () => 'default',
        insertQueuedMessage: { run() {} },
        deleteQueuedMessage: { run() {} },
        listQueuedMessages: { all: () => [] },
        broadcast() {},
        importPipeline: async () => ({
            orchestrate: async (prompt: string) => { runs.push(prompt); },
            orchestrateContinue: async () => {},
            orchestrateReset: async () => {},
            isContinueIntent: () => false,
            isResetIntent: () => false,
            drainPendingReplays: async () => {},
        }),
        getWorkingDir: () => null,
        isMultiSessionEnabled: () => false,
    }, new SessionLanes(() => 1));

    controller.enqueueMessage('first', 'web');
    controller.enqueueMessage('other-chat', 'telegram');
    controller.enqueueMessage('same-chat-tail', 'web');
    busy = false;
    await controller.processQueue('default');
    for (let i = 0; i < 20 && (controller.messageQueue.length > 0 || controller.isQueueBusy(null)); i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.deepEqual(runs, ['first', 'other-chat', 'same-chat-tail']);
});

// ─── RC: orchestrateContinue PABCD-aware ─────────────

function getOrchestrateContinueBlock(): string {
    const start = pipelineSrc.indexOf('export async function orchestrateContinue');
    const end = pipelineSrc.indexOf('// ─── Reset', start);
    assert.notEqual(start, -1, 'orchestrateContinue must exist');
    assert.notEqual(end, -1, 'reset section must follow orchestrateContinue');
    return pipelineSrc.slice(start, end);
}

test('RC-001: orchestrateContinue keeps active PABCD continue behavior', () => {
    const continueBlock = getOrchestrateContinueBlock();
    assert.ok(
        continueBlock.includes("state !== 'IDLE'"),
        'continue should check active PABCD state',
    );
    assert.ok(
        continueBlock.includes("orchestrate('Please continue from where you left off.'"),
        'active PABCD continue should call orchestrate with the continue prompt',
    );
    assert.ok(
        continueBlock.includes('_skipClear: true'),
        'active PABCD continue should preserve sessions (_skipClear)',
    );
});

test('RC-004: idle orchestrateContinue does not read or inject worklogs', () => {
    const continueBlock = getOrchestrateContinueBlock();
    assert.ok(
        !continueBlock.includes('readLatestWorklog()'),
        'IDLE continue must not read latest worklog',
    );
    assert.ok(
        !continueBlock.includes('worklog-based resume'),
        'IDLE continue must not keep worklog fallback comments',
    );
    assert.ok(
        !continueBlock.includes('Read the previous worklog'),
        'IDLE continue must not inject previous worklog prompt',
    );
    assert.ok(
        !continueBlock.includes('Worklog: ${latest.path}'),
        'IDLE continue must not inject latest worklog path',
    );
});

test('RC-005: idle orchestrateContinue returns no pending work', () => {
    const continueBlock = pipelineSrc.slice(
        pipelineSrc.indexOf('export async function orchestrateContinue'),
    );
    assert.ok(
        continueBlock.includes("text: 'No pending work to continue.'"),
        'IDLE continue should report no pending work',
    );
    assert.ok(
        !continueBlock.includes("`Read the previous worklog and continue any incomplete tasks"),
        'IDLE continue should not call orchestrate with a worklog prompt',
    );
});

test('RC-002: PABCD requires explicit entry (no auto-activation)', () => {
    assert.ok(
        !pipelineSrc.includes('shouldAutoActivatePABCD'),
        'auto-activation helper should be removed',
    );
    assert.ok(
        !pipelineSrc.includes('PABCD_ACTIVATE_PATTERNS'),
        'activation patterns should be removed',
    );
});

test('RC-003: PABCD requires explicit phase advance (no auto-advance)', () => {
    assert.ok(
        !pipelineSrc.includes('AUTO_APPROVE_NEXT'),
        'auto-approve map should be removed',
    );
});
