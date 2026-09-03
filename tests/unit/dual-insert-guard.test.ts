// #458: this file writes the shared `orc_state` 'default' row. tests/run.mts forks
// per file but every child inherits ONE CLI_JAW_HOME, so without an isolated home a
// concurrent file's resetState() clobbers this file's setState() mid-assertion.
// Must be the FIRST import: config.ts binds DB_PATH at module evaluation.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSource } from './source-normalize.js';
import { orchestrate } from '../../src/orchestrator/pipeline.ts';
import { resetState } from '../../src/orchestrator/state-machine.ts';
import { createQueueController } from '../../src/agent/spawn/queue.ts';
import { SessionLanes } from '../../src/orchestrator/session-lanes.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcRoot = join(__dirname, '../../src');

const gatewaySrc = readSource(join(srcRoot, 'orchestrator/gateway.ts'), 'utf8');
const spawnSrc = readSource(join(srcRoot, 'agent/spawn.ts'), 'utf8');
const queueSrc = readSource(join(srcRoot, 'agent/spawn/queue.ts'), 'utf8');
const botSrc = readSource(join(srcRoot, 'telegram/bot.ts'), 'utf8');

// ─── DI-001: gateway idle → orchestrate with _skipInsert ───

test('DI-001: gateway idle path passes _skipInsert: true to orchestrate', () => {
    // The idle path calls orchestrate after insertMessage — must tell downstream to skip
    const idleBlock = gatewaySrc.slice(gatewaySrc.indexOf('// ── idle'));
    assert.ok(
        idleBlock.includes('_skipInsert: true'),
        'idle path orchestrate call must include _skipInsert: true',
    );
});

// ─── DI-002: gateway continue → orchestrateContinue with _skipInsert ───

test('DI-002: gateway continue path passes _skipInsert: true to orchestrateContinue', () => {
    const continueBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── continue'),
        gatewaySrc.indexOf('// ── reset'),
    );
    assert.ok(
        continueBlock.includes('orchestrateContinue(') && continueBlock.includes('_skipInsert: true'),
        'continue path orchestrateContinue call must include _skipInsert: true',
    );
});

// ─── DI-003: gateway reset → orchestrateReset with _skipInsert ───

test('DI-003: gateway reset path passes _skipInsert: true to orchestrateReset', () => {
    const resetBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── reset'),
        gatewaySrc.indexOf('// ── busy'),
    );
    assert.ok(
        resetBlock.includes('orchestrateReset(') && resetBlock.includes('_skipInsert: true'),
        'reset path orchestrateReset call must include _skipInsert: true',
    );
});

// ─── DI-004: pipeline PABCD spawnAgent propagates _skipInsert ───

test('DI-004: pipeline PABCD path propagates _skipInsert to spawnAgent', async () => {
    resetState('default');
    let captured: Record<string, unknown> | undefined;
    await orchestrate('dual-insert guard', {
        origin: 'test',
        _skipClear: true,
        _skipReplayDrain: true,
        _skipInsert: true,
        _spawnAgent: (_prompt: string, opts: Record<string, unknown>) => {
            captured = opts;
            return { child: null, promise: Promise.resolve({ text: 'ok', code: 0 }) };
        },
    });
    assert.equal(captured?._skipInsert, true);
    resetState('default');
});

// ─── DI-005: pipeline PABCD has _skipInsert in spawn call ───

test('DI-005: pipeline PABCD spawn defaults _skipInsert to false', async () => {
    resetState('default');
    let captured: Record<string, unknown> | undefined;
    await orchestrate('dual-insert default guard', {
        origin: 'test',
        _skipClear: true,
        _skipReplayDrain: true,
        _spawnAgent: (_prompt: string, opts: Record<string, unknown>) => {
            captured = opts;
            return { child: null, promise: Promise.resolve({ text: 'ok', code: 0 }) };
        },
    });
    assert.equal(captured?._skipInsert, false);
    resetState('default');
});

// ─── DI-006: bot.ts tgOrchestrate → orchestrateAndCollect with _skipInsert ───

test('DI-006: tgOrchestrate passes _skipInsert: true to orchestrateAndCollect', () => {
    const collectCall = botSrc.match(/orchestrateAndCollect(?:Data)?\(prompt,\s*\{[^}]+\}\)/);
    assert.ok(collectCall, 'orchestrateAndCollect call must exist in bot.ts');
    assert.ok(
        collectCall[0].includes('_skipInsert: true'),
        'orchestrateAndCollect call must include _skipInsert: true',
    );
});

// ─── DI-007: spawn.ts processQueue → orchestrate with _skipInsert ───

test('DI-007: processQueue passes _skipInsert: true to every orchestrate path', async () => {
    for (const intent of ['normal', 'continue', 'reset'] as const) {
        let busy = true;
        let captured: Record<string, unknown> | undefined;
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
                orchestrate: async (_prompt: string, meta: Record<string, unknown>) => { captured = meta; },
                orchestrateContinue: async (meta: Record<string, unknown>) => { captured = meta; },
                orchestrateReset: async (meta: Record<string, unknown>) => { captured = meta; },
                isContinueIntent: () => intent === 'continue',
                isResetIntent: () => intent === 'reset',
                drainPendingReplays: async () => {},
            }),
            getWorkingDir: () => null,
            isMultiSessionEnabled: () => false,
        }, new SessionLanes(() => 1));
        controller.enqueueMessage(`dual-insert ${intent}`, 'web');
        busy = false;
        await controller.processQueue('default');
        assert.equal(captured?._skipInsert, true, `${intent} path`);
    }
});

// ─── DI-008: spawn.ts steerAgent → orchestrate with _skipInsert ───

test('DI-008: steerAgent passes _skipInsert: true to orchestrate calls', () => {
    const steerStart = spawnSrc.indexOf('export async function steerAgent');
    const steerEnd = spawnSrc.indexOf('// ─── Helpers', steerStart);
    const steerBlock = spawnSrc.slice(steerStart, steerEnd > 0 ? steerEnd : steerStart + 5000);
    // wp1: the three intent branches share one steerMeta object, so the flag is
    // declared once and every branch consumes it.
    assert.ok(
        steerBlock.includes('_skipInsert: true'),
        'shared steer metadata must suppress duplicate inserts',
    );
    for (const branch of ['orchestrateReset(steerMeta)', 'orchestrateContinue(steerMeta)', 'orchestrate(newPrompt, steerMeta)']) {
        assert.ok(steerBlock.includes(branch), 'steer branch must use shared metadata: ' + branch);
    }
});

// ─── DI-009: processQueue retains its own insertMessage (existing behavior) ───

test('DI-009: processQueue still has its own insertMessage.run (not removed)', () => {
    const pqStart = queueSrc.indexOf('async function processQueue');
    const pqEnd = queueSrc.indexOf('function purgeQueueOnStop', pqStart);
    const pqBlock = queueSrc.slice(pqStart, pqEnd > 0 ? pqEnd : pqStart + 5000);
    assert.ok(
        pqBlock.includes("deps.insertMessage.run('user', combined, source, ''"),
        'processQueue must retain its own insertMessage call',
    );
});

// ─── DI-010: steerAgent retains its own insertMessage (existing behavior) ───

test('DI-010: steerAgent still has its own insertMessage.run (not removed)', () => {
    const steerStart = spawnSrc.indexOf('export async function steerAgent');
    const steerEnd = spawnSrc.indexOf('// ─── Helpers', steerStart);
    const steerBlock = spawnSrc.slice(steerStart, steerEnd > 0 ? steerEnd : steerStart + 800);
    assert.ok(
        steerBlock.includes("insertMessage.run('user', newPrompt, source, ''"),
        'steerAgent must retain its own insertMessage call',
    );
});
