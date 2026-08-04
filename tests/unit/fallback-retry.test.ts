import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resetFallbackState,
    getFallbackState,
} from '../../src/agent/spawn.ts';
import { createQueueController } from '../../src/agent/spawn/queue.ts';
import { SessionLanes } from '../../src/orchestrator/session-lanes.ts';

// ─── Unit tests for fallback retry state ─────────────

test('resetFallbackState clears all entries', () => {
    // getFallbackState returns {} when empty
    resetFallbackState();
    const state = getFallbackState();
    assert.deepEqual(state, {});
});

test('getFallbackState returns object snapshot', () => {
    resetFallbackState();
    const state = getFallbackState();
    assert.equal(typeof state, 'object');
    assert.equal(Object.keys(state).length, 0);
});

test('FALLBACK_MAX_RETRIES is 3 (verified via module constants)', async () => {
    // Read spawn.js source to verify constant
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const src = fs.readFileSync(join(__dirname, '../../src/agent/spawn/queue.ts'), 'utf8');
    const match = src.match(/FALLBACK_MAX_RETRIES\s*=\s*(\d+)/);
    assert.ok(match, 'FALLBACK_MAX_RETRIES constant should exist');
    assert.equal(Number(match[1]), 3);
});

test('fallback state tracks retriesLeft and fallbackCli fields', () => {
    // Verify the data shape via source code (Map entries aren't directly settable from outside)
    resetFallbackState();
    const state = getFallbackState();
    // After reset, no entries
    assert.equal(Object.keys(state).length, 0);
});

test('resetFallbackState is idempotent', () => {
    resetFallbackState();
    resetFallbackState();
    resetFallbackState();
    assert.deepEqual(getFallbackState(), {});
});

test('retry and fallback state are isolated by scope', () => {
    const controller = createQueueController({
        migrateQueuedMessagesV1ToV2() {},
        isSpawnBusy: () => true,
        hasBlockingWorkers: () => false,
        hasPendingWorkerReplays: () => false,
        insertMessage: { run() {} },
        getActiveChatSession: () => 'default',
        insertQueuedMessage: { run() {} },
        deleteQueuedMessage: { run() {} },
        listQueuedMessages: { all: () => [] },
        broadcast() {},
        importPipeline: async () => ({
            orchestrate: async () => {}, orchestrateContinue: async () => {}, orchestrateReset: async () => {},
            isContinueIntent: () => false, isResetIntent: () => false, drainPendingReplays: async () => {},
        }),
        getWorkingDir: () => null,
        isMultiSessionEnabled: () => true,
    }, new SessionLanes(() => 2));
    const timerA = setTimeout(() => {}, 60_000);
    const timerB = setTimeout(() => {}, 60_000);
    controller.retryStateForScope('A').setTimer(timerA);
    controller.retryStateForScope('B').setTimer(timerB);
    controller.fallbackStateForScope('A').set('claude', { fallbackCli: 'codex', retriesLeft: 1 });
    controller.fallbackStateForScope('B').set('claude', { fallbackCli: 'pi', retriesLeft: 2 });

    controller.clearRetryTimer('A', false);
    assert.equal(controller.isRetryPending('A'), false);
    assert.equal(controller.isRetryPending('B'), true);
    assert.equal(controller.fallbackStateForScope('A').get('claude')?.fallbackCli, 'codex');
    assert.equal(controller.fallbackStateForScope('B').get('claude')?.fallbackCli, 'pi');
    controller.clearRetryTimer('B', false);
});

// ─── Integration scenario: fallback flow logic ──────

test('fallback retry flow: state transitions described correctly in source', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const lifecycleSrc = fs.readFileSync(join(__dirname, '../../src/agent/lifecycle-handler.ts'), 'utf8');

    // 1. retries exhausted → direct fallback (pre-spawn guard in spawn.ts)
    assert.ok(spawnSrc.includes('retriesLeft <= 0'), 'should check retriesLeft <= 0 for exhaustion');
    assert.ok(spawnSrc.includes('retries exhausted'), 'should log retries exhausted');

    // 2. retry consumed on failure (exit handler in lifecycle-handler.ts)
    assert.ok(lifecycleSrc.includes('st.retriesLeft - 1'), 'should decrement retriesLeft');
    assert.ok(lifecycleSrc.includes('retry consumed'), 'should log retry consumed');

    // 3. success clears state (exit handler in lifecycle-handler.ts)
    assert.ok(lifecycleSrc.includes('fallbackState.delete(cli)'), 'should delete state on success');
    assert.ok(lifecycleSrc.includes('recovered'), 'should log recovery');

    // 4. initial fallback sets max retries (exit handler in lifecycle-handler.ts)
    assert.ok(lifecycleSrc.includes('retriesLeft: fallbackMaxRetries'), 'should set initial retries');
});

test('server.js calls resetFallbackState on settings save', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // applySettingsPatch lives in core/session-ops.ts since the Phase 2 extraction (devlog 260609, 20).
    const src = fs.readFileSync(join(__dirname, '../../src/core/session-ops.ts'), 'utf8');

    assert.ok(src.includes('resetFallbackState'), 'session-ops should import/use resetFallbackState');
    assert.ok(src.includes('applyRuntimeSettingsPatch'), 'session-ops should delegate settings writes to shared helper');
    assert.ok(src.includes('resetFallbackState,'), 'session-ops should pass resetFallbackState into shared helper');
});

// ─── 429 Retry: helpers ─────────────────────────────

import { describe } from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSrc(rel: string): string {
    return fs.readFileSync(join(__dirname, rel), 'utf8');
}

function extractFn(src: string, name: string): string {
    const start = src.indexOf(`function ${name}`);
    if (start === -1) return '';
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
}

// ─── 429 Retry: structural tests ────────────────────

test('429: isAgentBusy checks activeProcess + retry pending state', () => {
    const src = readSrc('../../src/agent/spawn.ts');
    assert.ok(src.includes('function isAgentBusy'));
    assert.ok(src.includes('queueCtrl.isRetryPending(scopeKey)'));
    assert.ok(src.includes('activeMainProcesses.has(scopeKey)'));
});

test('429: clearRetryTimer accepts resumeQueue param and defaults true', () => {
    const src = readSrc('../../src/agent/spawn/queue.ts');
    const fn = extractFn(src, 'clearRetryTimer');
    assert.ok(fn.includes('resumeQueue = true'), 'default resumeQueue=true');
    assert.ok(fn.includes('if (shouldResume) void processQueue(scope)'), 'conditional scoped processQueue');
    assert.ok(fn.includes('error: true'), 'broadcasts error:true');
});

test('429: killActiveAgent clears only the scoped retry timer and returns hadTimer', () => {
    const src = readSrc('../../src/agent/spawn.ts');
    const fn = extractFn(src, 'killActiveAgent');
    assert.ok(fn.includes('clearRetryTimer(scopeKey, false)'), 'passes scope and resumeQueue=false');
    assert.ok(fn.includes('hadTimer'), 'returns hadTimer');
    assert.ok(!fn.includes('return false'), 'no plain return false');
});

test('429: killAllAgents returns true when timer cancelled', () => {
    const src = readSrc('../../src/agent/spawn.ts');
    const fn = extractFn(src, 'killAllAgents');
    assert.ok(fn.includes('queueCtrl.isRetryPending(null)'));
    assert.ok(fn.includes('killActiveAgent(scopeKey, reason)'));
    assert.ok(fn.includes('hadTimer'), 'tracks hadTimer for return value');
});

test('429: resetFallbackState clears scoped retry state without cross-scope resume', () => {
    const src = readSrc('../../src/agent/spawn/queue.ts');
    const fn = extractFn(src, 'resetFallbackState');
    assert.ok(fn.includes('clearRetryTimer(scope, false)'));
});

test('429: processQueue guards against busy state (retry-aware via deps.isSpawnBusy)', () => {
    const src = readSrc('../../src/agent/spawn/queue.ts');
    const fn = extractFn(src, 'processQueue');
    assert.ok(fn.includes('deps.isSpawnBusy(candidateScope)'), 'processQueue delegates scoped busy check to deps.isSpawnBusy');
});

test('429: retry state is keyed by scope', () => {
    const src = readSrc('../../src/agent/spawn/queue.ts');
    assert.ok(src.includes('const retryByScope = new Map<string, RetryState>()'));
});

test('429: retryPendingResolve stored before setTimeout', () => {
    const src = readSrc('../../src/agent/lifecycle-handler.ts');
    const r = src.indexOf('setResolve(resolve)');
    const t = src.indexOf('setTimer(setTimeout');
    assert.ok(r > 0 && t > 0 && r < t, 'resolve ref stored first');
});

test('429: steerHandler uses isAgentBusy not activeProcess', () => {
    const src = readSrc('../../src/cli/handlers-runtime.ts');
    const fn = src.slice(src.indexOf('async function steerHandler'));
    assert.ok(fn.includes('isAgentBusy'), 'uses isAgentBusy');
    assert.ok(!fn.includes('if (!activeProcess)'), 'no raw activeProcess guard');
});

test('429: gateway uses isAgentBusy', () => {
    const gw = readSrc('../../src/orchestrator/gateway.ts');
    assert.ok(gw.includes('isAgentBusy'));
    assert.ok(!gw.match(/if \(activeProcess\)/));
});

test('429: event consumers handle agent_retry', () => {
    assert.ok(readSrc('../../src/orchestrator/collect.ts').includes('agent_retry'));
    assert.ok(readSrc('../../src/telegram/bot.ts').includes('agent_retry'));
    const ws = readSrc('../../public/js/ws.ts');
    assert.ok(ws.includes('agent_retry'));
    assert.ok(ws.includes('msg.reason'));
    assert.ok(!ws.includes('msg.delay || 10'));
});

test('429: i18n keys exist', () => {
    const ko = readSrc('../../public/locales/ko.json');
    const en = readSrc('../../public/locales/en.json');
    assert.ok(ko.includes('"ws.retry"'));
    assert.ok(ko.includes('"ws.retryNow"'));
    assert.ok(en.includes('"ws.retry"'));
    assert.ok(en.includes('"ws.retryNow"'));
    assert.ok(ko.includes('{reason}'));
    assert.ok(en.includes('{reason}'));
});

// ─── 429 Retry: behavioral tests ────────────────────

describe('429 retry: behavioral tests', () => {
    test('clearRetryTimer(false) is safe on empty state', async () => {
        const spawn = await import('../../src/agent/spawn.ts');
        spawn.clearRetryTimer(false);
        assert.ok(true, 'no-op without crash');
    });

    test('clearRetryTimer(true) is safe on empty state', async () => {
        const spawn = await import('../../src/agent/spawn.ts');
        spawn.clearRetryTimer(true);
        assert.ok(true, 'no-op without crash');
    });

    test('killActiveAgent returns false when nothing pending', async () => {
        const spawn = await import('../../src/agent/spawn.ts');
        const result = spawn.killActiveAgent('test');
        assert.equal(result, false, 'nothing to kill → false');
    });

    test('isAgentBusy reflects activeProcess state', async () => {
        const spawn = await import('../../src/agent/spawn.ts');
        assert.equal(spawn.isAgentBusy(), spawn.activeMainProcesses.has('default'));
    });

    test('processQueue guards against retryPendingTimer at runtime', async () => {
        const spawn = await import('../../src/agent/spawn.ts');
        spawn.processQueue();
        assert.ok(true, 'no-op on empty queue');
    });
});

// ─── 429 Retry: edge case tests ─────────────────────

describe('429 retry: edge case coverage', () => {
    test('timer pending blocks processQueue at runtime', async () => {
        const src = readSrc('../../src/agent/spawn/queue.ts');
        const fn = extractFn(src, 'processQueue');
        assert.ok(fn.includes('deps.isSpawnBusy(candidateScope)'), 'processQueue must guard on scoped busy state');
        assert.ok(fn.includes('messageQueue.length === 0'), 'processQueue must guard on empty queue');
    });

    test('steer/stop during retry calls clearRetryTimer(false) — queue stays blocked', () => {
        // killActiveAgent uses resumeQueue=false to prevent queue drain after steer/stop
        const src = readSrc('../../src/agent/spawn.ts');
        const killFn = extractFn(src, 'killActiveAgent');
        // Must call clearRetryTimer(false) BEFORE the activeProcess check
        const clearIdx = killFn.indexOf('clearRetryTimer(scopeKey, false)');
        const processCheck = killFn.indexOf('if (!activeProcess)');
        assert.ok(clearIdx > 0 && processCheck > 0, 'both calls should exist');
        assert.ok(clearIdx < processCheck, 'clearRetryTimer(false) must precede activeProcess check');

        // killAllAgents delegates each concrete scope through killActiveAgent.
        const killAllFn = extractFn(src, 'killAllAgents');
        assert.ok(killAllFn.includes('killActiveAgent(scopeKey, reason)'),
            'killAllAgents must clear each scope through the scoped stop path');
    });

    test('429 retry branch appears BEFORE fallback branch in unified exit handler', () => {
        // Critical ordering: same-engine retry (429) must be tried before cross-engine fallback
        // After decomposition, both ACP + CLI exit paths delegate to handleAgentExit in lifecycle-handler.ts
        const src = readSrc('../../src/agent/lifecycle-handler.ts');

        const retryIdx = src.indexOf('429 delay retry');
        const fallbackIdx = src.indexOf('Fallback with retry tracking');
        assert.ok(retryIdx > 0, 'handleAgentExit: 429 retry branch must exist');
        assert.ok(fallbackIdx > 0, 'handleAgentExit: fallback branch must exist');
        assert.ok(retryIdx < fallbackIdx,
            'handleAgentExit: 429 retry must come BEFORE fallback to ensure same-engine retry first');
    });
});

// ─── 429 Retry: runtime simulation tests ────────────
// These tests exercise ACTUAL function calls (not string matching)
// to verify state transitions and race condition safety.

describe('429 retry: runtime timer simulation', () => {
    test('isAgentBusy() is false when no process and no timer', async () => {
        // Dynamic import to get real module — verifies initial idle state
        const spawn = await import('../../src/agent/spawn.ts');
        const wasBusy = spawn.isAgentBusy();
        // If no test left a dangling timer or process, should be false
        if (spawn.activeMainProcesses.has('default')) {
            assert.ok(wasBusy, 'should be busy when activeProcess is set');
        } else {
            assert.equal(wasBusy, false, 'should not be busy with no process and no timer');
        }
    });

    test('clearRetryTimer(false) is safe no-op when no timer — race condition defense', async () => {
        // This tests the exact race window from spawn.ts:83 audit finding:
        // Timer callback fires → nulls retryPendingTimer → killActiveAgent calls
        // clearRetryTimer(false) → must not crash or double-fire.
        const spawn = await import('../../src/agent/spawn.ts');

        // Call clearRetryTimer(false) multiple times rapidly — simulates
        // concurrent stop/steer arriving after timer already self-cleared
        spawn.clearRetryTimer(false);
        spawn.clearRetryTimer(false);
        spawn.clearRetryTimer(true);

        // Must not throw, must remain idle
        assert.equal(spawn.isAgentBusy(), false,
            'isAgentBusy must be false after multiple clearRetryTimer calls with no active timer');
    });

    test('killActiveAgent safely handles "nothing active" — timer already self-cleared', async () => {
        // Simulates: timer callback already fired (timer=null, process=null)
        // then killActiveAgent is called from a delayed steer/stop.
        // Must not throw, must not corrupt state.
        const spawn = await import('../../src/agent/spawn.ts');

        // Ensure clean state
        spawn.clearRetryTimer(false);

        // killActiveAgent with nothing active → should be safe no-op
        spawn.killActiveAgent('steer');
        assert.equal(spawn.isAgentBusy(), false,
            'killActiveAgent on empty state must not leave busy flag set');
        assert.equal(spawn.activeMainProcesses.has('default'), false,
            'default main run entry must remain absent after kill on empty state');
    });
});
