import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    const steerBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 500);

    // Step 1: kill with 'steer' reason
    const killIdx = steerBody.indexOf("killActiveAgent('steer')");
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
    const cliBlock = spawnSrc.slice(cliCloseIdx, cliCloseIdx + 10000);
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
    const fnBlock = src.slice(fnIdx, src.indexOf('function withHistoryPrompt'));

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
    const resumeArgsIdx = src.indexOf('args = buildResumeArgs(cli');

    assert.ok(promptForArgsIdx > 0, 'spawn should compute promptForArgs before argv construction');
    assert.ok(resumeArgsIdx > promptForArgsIdx, 'resume args should be built after promptForArgs');
    assert.ok(
        src.includes('buildResumeArgs(cli, runtimeModel, effort, sid, promptForArgs, permissions, argOptions)'),
        'resume argv CLIs must receive promptForArgs, not raw prompt',
    );
});

test('SF-004c: agy front-loads current task before operational context', () => {
    const src = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const agyBranchIdx = src.indexOf("if (cli === 'agy' && sysPrompt)");
    const kiroBranchIdx = src.indexOf("else if ((cli === 'kiro-code'");
    assert.ok(agyBranchIdx > 0, 'agy should have a dedicated prompt ordering branch');
    assert.ok(kiroBranchIdx > agyBranchIdx, 'kiro branch should remain separate from agy');

    const agyBranch = src.slice(agyBranchIdx, kiroBranchIdx);
    assert.ok(agyBranch.includes('[Current cli-jaw task]'), 'agy prompt should put task context first');
    assert.ok(agyBranch.includes('${promptForArgs}\\n\\n---\\n\\n[Operational Context'), 'agy should append operational context after task prompt');
    assert.ok(
        agyBranch.indexOf('[Current cli-jaw task]') < agyBranch.indexOf('[Operational Context'),
        'agy must not put the long operational context before the current user task',
    );
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
        spawnSrc.includes("reason === 'steer' && isActiveAiEPtyRuntime()"),
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
        routeSrc.includes('getSteerWaitMsForActiveAgent()'),
        'queued web steer route should use provider-specific wait timing',
    );
    assert.ok(
        handlerSrc.includes('getSteerWaitMsForActiveAgent()'),
        'slash steer handler should use provider-specific wait timing',
    );
});

test('SF-006: queued web steer accepts item before background old-process wait', () => {
    const routeSrc = fs.readFileSync(join(__dirname, '../../src/routes/orchestrate.ts'), 'utf8');
    const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');

    const routeIdx = routeSrc.indexOf("app.post('/api/orchestrate/queue/:id/steer'");
    assert.ok(routeIdx > 0, 'queued steer route should exist');
    const routeBlock = routeSrc.slice(routeIdx, routeIdx + 3200);

    const waitConfigIdx = routeBlock.indexOf('const steerWaitMs = getSteerWaitMsForActiveAgent()');
    const busyCaptureIdx = routeBlock.indexOf('const wasBusyBeforeSteer = isAgentBusy()');
    const holdIdx = routeBlock.indexOf('setQueueHold(id, Math.max(10_000, steerWaitMs + 5_000))');
    const setBusyIdx = routeBlock.indexOf('setSteerInProgress(true)');
    const removeIdx = routeBlock.indexOf('removeQueuedMessage(id)');
    const responseIdx = routeBlock.indexOf('res.json({ ok: true');
    const backgroundIdx = routeBlock.indexOf('void (async () =>');
    const killIdx = routeBlock.indexOf("killActiveAgent('steer')", backgroundIdx);
    const waitIdx = routeBlock.indexOf('await waitForProcessEnd(steerWaitMs)', backgroundIdx);
    const finalClearIdx = routeBlock.indexOf('setSteerInProgress(false)', backgroundIdx);

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
        routeBlock.slice(0, responseIdx).indexOf('waitForProcessEnd(steerWaitMs)') === -1,
        'route must not block the button response on waitForProcessEnd',
    );
    assert.ok(routeBlock.includes('isSteerInProgress()'), 'route should reject concurrent queued steer attempts');
    assert.ok(spawnSrc.includes('export function isSteerInProgress()'), 'spawn.ts should expose steer-in-progress state for route gating');
    const queueSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn/queue.ts'), 'utf8');
    assert.ok(
        queueSrc.includes('function setQueueHold(id: string, timeoutMs = QUEUE_HOLD_TIMEOUT_MS)'),
        'queue hold should accept an extended timeout for long provider steer waits',
    );
});
