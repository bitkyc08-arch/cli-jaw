import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createQueueController } from '../../src/agent/spawn/queue.ts';
import { SessionLanes } from '../../src/orchestrator/session-lanes.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── SF-001: steerAgent flow — kill existing + wait + start new ───

test('SF-001: steerAgent flow: kill → wait → insert → orchestrate', () => {
    const src = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');

    // Extract steerAgent function body
    const fnStart = src.indexOf('export async function steerAgent');
    assert.ok(fnStart > 0, 'steerAgent should be exported');

    // Find matching closing brace (roughly — next export function)
    const fnEnd = src.indexOf('\nexport ', fnStart + 10);
    const fullSteerBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 1200);
    const fallbackStart = fullSteerBody.indexOf('const steerWaitMs = getSteerWaitMsForActiveAgent(scopeKey)');
    assert.ok(fallbackStart > 0, 'generic explicit /steer fallback should remain available');
    const steerBody = fullSteerBody.slice(fallbackStart);

    // Step 1: kill with 'steer' reason
    const killIdx = steerBody.indexOf("killActiveAgent(scopeKey, 'steer')");
    assert.ok(killIdx > 0, 'should call killActiveAgent("steer")');

    // Step 2: wait for process end
    const waitIdx = steerBody.indexOf('waitForProcessEnd');
    assert.ok(waitIdx > killIdx, 'should wait for process end AFTER kill');

    // Step 3: insert message
    const insertIdx = steerBody.indexOf('insertMessage.run');
    assert.ok(insertIdx > waitIdx, 'should insert message AFTER wait');

    // Step 4: broadcast
    const broadcastIdx = steerBody.indexOf("broadcast('new_message'");
    assert.ok(broadcastIdx > insertIdx, 'should broadcast AFTER insert');

    // Step 5: orchestrate (one of three kinds)
    const orchestrateIdx = Math.min(
        steerBody.indexOf('orchestrateReset') > 0 ? steerBody.indexOf('orchestrateReset') : Infinity,
        steerBody.indexOf('orchestrateContinue') > 0 ? steerBody.indexOf('orchestrateContinue') : Infinity,
        steerBody.indexOf('orchestrate(') > 0 ? steerBody.indexOf('orchestrate(') : Infinity,
    );
    assert.ok(orchestrateIdx > broadcastIdx, 'should orchestrate AFTER broadcast');
});

test('SF-001b: policy steer capability is JWC-busy or a codex-app in-band hook', () => {
    const src = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const start = src.indexOf('export function canSteerAgent');
    const end = src.indexOf('export async function steerAgent', start);
    const capability = src.slice(start, end);
    assert.ok(capability.includes("run?.meta.cli === 'jwc'"));
    assert.ok(capability.includes('jawRuntimesByScope.get(scopeKey)?.busy === true'));
    // wp2: codex-app advertises same-turn steer by installing steerTurnInBand
    // for exactly the duration of a steerable turn.
    assert.ok(capability.includes('steerTurnInBand'), 'codex-app in-band steer capability');
});

// ─── SF-002: steerAgent saves interrupted output via exit handler ───

test('SF-002: exit handler saves interrupted content to DB via insertMessageWithTraceRun', () => {
    // After Phase 2 decomposition, interrupted tagging + insertMessageWithTraceRun
    // moved to lifecycle-handler.ts (handleAgentExit). Verify it there.
    const lifecycleSrc = fs.readFileSync(join(__dirname, '../../src/agent/lifecycle-handler.ts'), 'utf8');

    const interruptedIdx = lifecycleSrc.indexOf('⏹️ [interrupted]');
    const insertTraceIdx = lifecycleSrc.indexOf('insertMessageWithTraceRun.run');
    assert.ok(interruptedIdx > 0, 'lifecycle-handler should have interrupted tagging');
    assert.ok(insertTraceIdx > interruptedIdx, 'insertMessageWithTraceRun should come after interrupted tagging');

    // Also verify spawn.ts exit handlers delegate to handleAgentExit
    const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');

    const acpExitIdx = spawnSrc.indexOf("acp.on('exit'");
    assert.ok(acpExitIdx > 0);
    const acpBlock = spawnSrc.slice(acpExitIdx, acpExitIdx + 7000);
    assert.ok(acpBlock.includes('handleAgentExit'), 'ACP exit should delegate to handleAgentExit');

    const cliCloseIdx = spawnSrc.indexOf("child.on('close'");
    assert.ok(cliCloseIdx > 0);
    // The CLI close handler has grown past 10k chars (agy/kiro buffer flushes);
    // keep a bounded window so the delegation still has to live in this handler.
    const cliBlock = spawnSrc.slice(cliCloseIdx, cliCloseIdx + 20000);
    assert.ok(cliBlock.includes('handleAgentExit'), 'CLI close should delegate to handleAgentExit');
});

// ─── SF-003: buildHistoryBlock includes trace (which has interrupted tag) ───

test('SF-003: buildHistoryBlock uses trace for assistant messages, preserving interrupted tag', () => {
    const src = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');

    // Find buildHistoryBlock function
    const fnIdx = src.indexOf('function buildHistoryBlock');
    assert.ok(fnIdx > 0, 'buildHistoryBlock function should exist');

    const fnBlock = src.slice(fnIdx, src.indexOf('if (!blocks.length)', fnIdx));

    // It should prefer row.trace over row.content for assistant messages
    assert.ok(
        fnBlock.includes("role === 'assistant' && row.trace"),
        'should check if assistant message has trace',
    );

    // When trace exists, it uses trace text (which will contain ⏹️ [interrupted])
    assert.ok(
        fnBlock.includes('row.trace'),
        'should use row.trace for assistant messages',
    );
    assert.ok(
        fnBlock.indexOf("role === 'assistant' && row.trace") < fnBlock.indexOf('content &&'),
        'assistant trace should be preferred before content fallback',
    );

    // content fallback for non-assistant or no-trace
    assert.ok(
        fnBlock.includes(`[${`role || 'user'`}]`) || fnBlock.includes('role ||'),
        'should have fallback for content display',
    );
});

test('SF-004: buildHistoryBlock filters stale worklog continue artifacts', () => {
    const src = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const fnIdx = src.indexOf('function buildHistoryBlock');
    assert.ok(fnIdx > 0, 'buildHistoryBlock function should exist');
    const fnEnd = src.indexOf('function isStaleWorklogHistoryArtifact', fnIdx);
    assert.ok(fnEnd > fnIdx, 'buildHistoryBlock should end before stale artifact helper');
    const fnBlock = src.slice(fnIdx, fnEnd);

    assert.ok(src.includes('function isStaleWorklogHistoryArtifact'), 'stale artifact helper should exist');
    assert.ok(fnBlock.includes('!isStaleWorklogHistoryArtifact(summary)'), 'compact marker summaries must be filtered');
    assert.ok(fnBlock.includes('content && !isStaleWorklogHistoryArtifact(content)'), 'normal content must be filtered');
    assert.ok(fnBlock.includes("role === 'assistant' && row.trace && !isStaleWorklogHistoryArtifact(String(row.trace))"), 'assistant trace must be filtered');
    assert.ok(src.includes('Read the previous worklog and continue any incomplete tasks.'), 'old fallback prompt marker should be filtered');
    assert.ok(src.includes('이 워크로그는 스텁이네요'), 'old Korean stale worklog reply marker should be filtered');
    assert.ok(src.includes('Continuing from previous worklog.'), 'old English locale marker should be filtered');
});

test('SF-004b: resume argv CLIs keep enriched promptForArgs for agy and compact handoff', () => {
    const src = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const promptForArgsIdx = src.indexOf('let promptForArgs =');
    const buildCurrentArgsIdx = src.indexOf('const buildCurrentArgs =');
    const agyBootstrapIdx = src.indexOf('agyBootstrap = buildAgyBootstrapEnvelope');
    const agyPromptAssignIdx = src.indexOf('promptForArgs = agyBootstrap.prompt');

    assert.ok(promptForArgsIdx > 0, 'spawn should compute promptForArgs before argv construction');
    assert.ok(buildCurrentArgsIdx > promptForArgsIdx, 'argv builder should be defined after promptForArgs');
    assert.ok(agyBootstrapIdx > buildCurrentArgsIdx, 'AGY bootstrap should be built after argv builder setup');
    assert.ok(agyPromptAssignIdx > agyBootstrapIdx, 'AGY promptForArgs should be replaced with bootstrap prompt before args are built');
    assert.ok(
        src.includes('buildResumeArgs(cli, runtimeModel, effort, sid, promptForArgs, permissions, options)'),
        'resume argv CLIs must receive promptForArgs, not raw prompt',
    );
    assert.ok(
        src.includes("if (cli !== 'agy') args = buildCurrentArgs(argOptions);"),
        'AGY must defer argv construction until after bootstrap prompt replacement',
    );
});

test('SF-004c: agy passes configured prompt order to the bootstrap envelope', () => {
    const src = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const agyBranchIdx = src.indexOf("if (cli === 'agy') {");
    const preflightIdx = src.indexOf('// ─── DIFF-A: Preflight', agyBranchIdx);
    assert.ok(agyBranchIdx > 0, 'agy should have a dedicated bootstrap branch');
    assert.ok(preflightIdx > agyBranchIdx, 'agy branch should be bounded before preflight');

    const agyBranch = src.slice(agyBranchIdx, preflightIdx);
    assert.ok(agyBranch.includes('buildAgyBootstrapEnvelope({'), 'agy branch should use the bootstrap envelope builder');
    assert.ok(agyBranch.includes('taskPrompt: prompt'), 'agy bootstrap should receive the current task prompt');
    assert.ok(agyBranch.includes('operationalContext: sysPrompt'), 'agy bootstrap should receive operational context separately');
    assert.ok(agyBranch.includes('order: resolveAgyPromptOrder(cfg.promptOrder)'), 'agy bootstrap should receive the configured prompt order');
    assert.ok(agyBranch.includes('promptForArgs = agyBootstrap.prompt'), 'agy args prompt should be the ordered bootstrap prompt');
});

// ─── SF-EDGE: processQueue is called after mainManaged exit ───

test('SF-EDGE: processQueue is triggered after mainManaged exit in both paths', () => {
    const src = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');

    // ACP path — processQueue passed to handleAgentExit (or called directly)
    const acpExitIdx = src.indexOf("acp.on('exit'");
    const acpBlock = src.slice(acpExitIdx, acpExitIdx + 8000);
    assert.ok(
        acpBlock.includes('processQueue'),
        'ACP exit should reference processQueue (direct call or handleAgentExit param)',
    );

    // CLI path — processQueue passed to handleAgentExit (or called directly)
    const cliCloseIdx = src.indexOf("child.on('close'");
    const cliBlock = src.slice(cliCloseIdx, cliCloseIdx + 20000);
    assert.ok(
        cliBlock.includes('processQueue'),
        'CLI close should reference processQueue (direct call or handleAgentExit param)',
    );
});

test('SF-005: ai-e PTY steer uses graceful interrupt timing', () => {
    const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const routeSrc = fs.readFileSync(join(__dirname, '../../src/routes/orchestrate.ts'), 'utf8');
    const handlerSrc = fs.readFileSync(join(__dirname, '../../src/cli/handlers-runtime.ts'), 'utf8');

    assert.ok(
        spawnSrc.includes('CLAUDE_E_STEER_WAIT_MS = 30_000'),
        'claude-e steer should wait long enough for SIGKILL escalation plus exit cleanup',
    );
    assert.ok(
        spawnSrc.includes('CLAUDE_E_STEER_KILL_ESCALATION_MS = 8_000'),
        'claude-e steer should not inherit the default 2s SIGKILL escalation',
    );
    assert.ok(
        spawnSrc.includes("reason === 'steer' && isActiveAiEPtyRuntime(scopeKey)"),
        'kill policy should be scoped to ai-e/claude-e PTY runtimes',
    );
    assert.ok(
        spawnSrc.includes("return { signal: 'SIGINT', escalationMs: CLAUDE_E_STEER_KILL_ESCALATION_MS }"),
        'claude-e steer should send SIGINT so the Rust runtime can emit interrupted and /exit',
    );
    assert.ok(
        spawnSrc.includes('export function getSteerWaitMsForActiveAgent'),
        'steer wait helper should be exported for all steer surfaces',
    );
    assert.ok(
        routeSrc.includes('getSteerWaitMsForActiveAgent(scope)'),
        'queued web steer route should use provider-specific wait timing',
    );
    assert.ok(
        handlerSrc.includes('getSteerWaitMsForActiveAgent(scopeKey)'),
        'slash steer handler should use provider-specific wait timing',
    );
});

test('SF-006: queued web steer accepts item before background old-process wait', () => {
    const routeSrc = fs.readFileSync(join(__dirname, '../../src/routes/orchestrate.ts'), 'utf8');
    const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');

    const routeIdx = routeSrc.indexOf("app.post('/api/orchestrate/queue/:id/steer'");
    assert.ok(routeIdx > 0, 'queued steer route should exist');
    // Window sized to cover the background steer block including the wp1
    // exit-settle/salvage wait between the kill and the re-orchestrate.
    const routeBlock = routeSrc.slice(routeIdx, routeIdx + 5200);

    const waitConfigIdx = routeBlock.indexOf('const steerWaitMs = getSteerWaitMsForActiveAgent(scope)');
    const busyCaptureIdx = routeBlock.indexOf('const wasBusyBeforeSteer = isAgentBusy(scope)');
    const holdIdx = routeBlock.indexOf('setQueueHold(scope, id, Math.max(10_000, steerWaitMs + 5_000))');
    const setBusyIdx = routeBlock.indexOf('setSteerInProgress(scope, true)');
    const removeIdx = routeBlock.indexOf('removeQueuedMessage(id)');
    const responseIdx = routeBlock.indexOf('res.json({ ok: true');
    const backgroundIdx = routeBlock.indexOf('void (async () =>');
    const killIdx = routeBlock.indexOf("killActiveAgent(scope, 'steer')", backgroundIdx);
    const waitIdx = routeBlock.indexOf('await waitForProcessEnd(scope, steerWaitMs)', backgroundIdx);
    const finalClearIdx = routeBlock.indexOf('setSteerInProgress(scope, false)', backgroundIdx);

    assert.ok(waitConfigIdx > 0, 'route should compute provider-specific wait before holding the queue item');
    assert.ok(busyCaptureIdx > waitConfigIdx, 'route should capture pre-steer busy state before marking steer busy');
    assert.ok(holdIdx > busyCaptureIdx, 'route should hold the target queued item before accepting it');
    assert.ok(setBusyIdx > holdIdx, 'route should mark steer busy before accepting the item');
    assert.ok(removeIdx > setBusyIdx, 'route should remove the queued item immediately after marking steer busy');
    assert.ok(responseIdx > removeIdx, 'route should respond after queue removal is committed');
    assert.ok(backgroundIdx > responseIdx, 'old-process wait must run only in background after response');
    assert.ok(killIdx > backgroundIdx, 'background task should kill the old busy path');
    assert.ok(waitIdx > killIdx, 'background task should wait for process end after kill');
    assert.ok(finalClearIdx > waitIdx, 'background task should clear steer busy after wait/orchestrate');
    assert.ok(
        routeBlock.slice(0, responseIdx).indexOf('waitForProcessEnd(scope, steerWaitMs)') === -1,
        'route must not block the button response on waitForProcessEnd',
    );
    assert.ok(routeBlock.includes('isSteerInProgress(scope)'), 'route should reject concurrent queued steer attempts per scope');
    assert.ok(spawnSrc.includes('export function isSteerInProgress(scopeKey'), 'spawn.ts should expose scoped steer-in-progress state for route gating');
    const queueSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn/queue.ts'), 'utf8');
    assert.ok(
        queueSrc.includes('function setQueueHold(scopeKey: string, idOrTimeout?: string | number, timeoutMs = QUEUE_HOLD_TIMEOUT_MS)'),
        'queue hold should accept an extended timeout for long provider steer waits',
    );
});

test('SF-007: clearing A queue hold leaves B hold intact', () => {
    const controller = createQueueController({
        migrateQueuedMessagesV1ToV2() {}, isSpawnBusy: () => true,
        hasBlockingWorkers: () => false, hasPendingWorkerReplays: () => false,
        insertMessage: { run() {} }, getActiveChatSession: () => 'default',
        insertQueuedMessage: { run() {} }, deleteQueuedMessage: { run() {} },
        listQueuedMessages: { all: () => [] }, broadcast() {},
        importPipeline: async () => ({
            orchestrate: async () => {}, orchestrateContinue: async () => {}, orchestrateReset: async () => {},
            isContinueIntent: () => false, isResetIntent: () => false, drainPendingReplays: async () => {},
        }),
        getWorkingDir: () => null, isMultiSessionEnabled: () => true,
    }, new SessionLanes(() => 2));
    controller.setQueueHold('A', 'hold-a');
    controller.setQueueHold('B', 'hold-b');
    controller.clearQueueHold('A', 'hold-a', { resume: false });
    assert.equal(controller.getQueueHoldId('A'), null);
    assert.equal(controller.getQueueHoldId('B'), 'hold-b');
    controller.clearQueueHold('B', 'hold-b', { resume: false });
});
