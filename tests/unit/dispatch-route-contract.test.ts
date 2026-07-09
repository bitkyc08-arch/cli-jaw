import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { readSource } from './source-normalize.js';

const projectRoot = join(import.meta.dirname, '../..');
const serverSrc = readSource(join(projectRoot, 'server.ts'), 'utf8');
const orchestrateSrc = readSource(join(projectRoot, 'src/routes/orchestrate.ts'), 'utf8');

test('dispatch route clears pending replay only after response is flushed (phase 7)', () => {
    const routeStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch'");
    assert.ok(routeStart >= 0, 'dispatch route should exist');

    // Window must cover both POST dispatch body + GET result polling route.
    const routeBlock = orchestrateSrc.slice(routeStart, routeStart + 14000);
    const finishIdx = routeBlock.search(/finishWorker\(slot\.agentId,\s*(?:String\()?result\.text \|\| ''/);
    const finishHookIdx = routeBlock.indexOf("res.on('finish', () => markWorkerReplayed(slot.agentId))", finishIdx);
    const responseIdx = routeBlock.indexOf('res.json({', finishHookIdx);

    assert.ok(finishIdx >= 0, 'dispatch route should call finishWorker on success');
    assert.ok(finishHookIdx > finishIdx, 'markWorkerReplayed should appear after finishWorker');
    assert.ok(responseIdx > finishIdx, 'dispatch route should respond after finishWorker');
    assert.ok(routeBlock.includes('statusPersisted'), 'dispatch response should include verdict persistence diagnostics');
    assert.ok(routeBlock.includes('persistedField'), 'dispatch response should name the persisted verdict field');
    assert.ok(routeBlock.includes('progress: getWorkerProgressSnapshot(slot.agentId)'), 'dispatch response should include worker progress diagnostics');

    // Phase 7: markWorkerReplayed must be scheduled via res.on('finish') so that
    // a client disconnecting before the flush keeps pendingReplay=true.
    assert.ok(finishHookIdx >= 0,
        'markWorkerReplayed must be wrapped in res.on(\'finish\') in the dispatch success path');
});

test('dispatch route supports async wait:false progress start', () => {
    const routeStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch'");
    assert.ok(routeStart >= 0, 'dispatch route should exist');
    const routeBlock = orchestrateSrc.slice(routeStart, routeStart + 16000);

    assert.ok(routeBlock.includes('const wait = req.body?.wait !== false'), 'dispatch route should parse wait:false');
    assert.ok(routeBlock.includes('void runDispatch(false)'), 'wait:false should start worker asynchronously');
    // Opus review FINDING 3: single wait:false must proactively drain on
    // completion (parity with async batch), not wait for an organic idle event.
    assert.ok(
        routeBlock.match(/if \(!reply\) \{[\s\S]*?drainPendingReplays/),
        'single wait:false completion must trigger a proactive drainPendingReplays',
    );
    assert.ok(routeBlock.includes('res.status(202).json'), 'wait:false should return 202');
    assert.ok(routeBlock.includes('worker: {'), 'wait:false should include worker metadata');
    assert.ok(routeBlock.includes('runId: slot.runId'), 'wait:false should include runId metadata');
    assert.ok(routeBlock.includes('progress: getWorkerProgressSnapshot(slot.agentId)'), 'wait:false should include progress snapshot');
});

test('dispatch route exposes runId in busy and result polling contracts', () => {
    const routeStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch'");
    assert.ok(routeStart >= 0, 'dispatch route should exist');
    const dispatchBlock = orchestrateSrc.slice(routeStart, routeStart + 18000);
    const resultStart = orchestrateSrc.indexOf("app.get('/api/orchestrate/worker/:agentId/result'");
    assert.ok(resultStart >= 0, 'worker result route should exist');
    const resultBlock = orchestrateSrc.slice(resultStart, resultStart + 3000);

    assert.ok(dispatchBlock.includes('runId: err.existing.runId'), '409 worker_busy should include active runId');
    assert.ok(dispatchBlock.includes('runId: slot.runId'), '202 dispatch response should include active runId');
    assert.ok(resultBlock.includes('runId: slot.runId'), 'result polling should include runId');
    assert.ok(resultBlock.includes('agentId: slot.agentId'), 'result polling should keep agentId');
});

test('dispatch route reports verdict persistence diagnostics', () => {
    const routeStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch'");
    assert.ok(routeStart >= 0, 'dispatch route should exist');
    const routeBlock = orchestrateSrc.slice(routeStart, routeStart + 12000);

    assert.ok(routeBlock.includes('const orchestration = {'), 'dispatch route should build orchestration diagnostics');
    assert.ok(routeBlock.includes('verdict: verdict || null'), 'diagnostics should include parsed verdict');
    assert.ok(routeBlock.includes('currentState: currentOrcState'), 'diagnostics should include current PABCD state');
    assert.ok(routeBlock.includes('stateAtDispatch'), 'diagnostics should include state at dispatch start');
    assert.ok(routeBlock.includes('stateAtCompletion'), 'diagnostics should include state after worker completion');
    assert.ok(routeBlock.includes('ctxPresent: Boolean(dispatchCtx)'), 'diagnostics should include ctx presence');
    assert.ok(routeBlock.includes('statusPersistReason'), 'diagnostics should include verdict persistence reason');
    assert.ok(routeBlock.includes("statusPersistReason = 'state_changed'"), 'state changes during dispatch should be reported');
    assert.ok(routeBlock.includes("persistedField = 'auditStatus'"), 'PASS/FAIL in A should persist to auditStatus');
    assert.ok(routeBlock.includes("persistedField = 'verificationStatus'"), 'DONE/NEEDS_FIX in B should persist to verificationStatus');
});

test('dispatch route maps PABCD phase from state-machine', () => {
    const routeStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch'");
    assert.ok(routeStart >= 0, 'dispatch route should exist');
    const routeBlock = orchestrateSrc.slice(routeStart, routeStart + 12000);

    // Phase map must exist in dispatch route
    assert.ok(
        routeBlock.includes('PABCD_PHASE_MAP'),
        'dispatch route should contain PABCD_PHASE_MAP for phase auto-mapping',
    );
    // Must call getState to read current orchestration phase
    assert.ok(
        routeBlock.includes('getState('),
        'dispatch route should call getState() to read current PABCD phase',
    );
    // Must call resolveOrcScope for proper scope resolution
    assert.ok(
        routeBlock.includes('resolveOrcScope('),
        'dispatch route should call resolveOrcScope() for scope resolution',
    );
    // resolvedPhase must be used in ap object (not hardcoded 3)
    assert.ok(
        routeBlock.includes('currentPhase: resolvedPhase'),
        'dispatch route should use resolvedPhase (not hardcoded phase 3)',
    );
});

test('dispatch route accepts optional phase override in request body', () => {
    const routeStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch'");
    const routeBlock = orchestrateSrc.slice(routeStart, routeStart + 12000);

    // Must destructure phase from req.body
    assert.ok(
        routeBlock.includes('phase') && routeBlock.includes('req.body'),
        'dispatch route should accept phase from request body',
    );
    // resolvedPhase should fallback: explicit phase → PABCD map → default 3
    assert.ok(
        routeBlock.includes('phase ??'),
        'dispatch route should use nullish coalescing for phase fallback',
    );
});

test('batch dispatch route returns safe run summaries instead of full employee text', () => {
    const batchStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch/batch'");
    assert.ok(batchStart >= 0, 'batch dispatch route should exist');
    const batchBlock = orchestrateSrc.slice(batchStart, batchStart + 9000);

    assert.ok(batchBlock.includes('runId: slot.runId'), 'batch summaries must include runId');
    assert.ok(batchBlock.includes('preview: previewText(text, 600)'), 'batch summaries must include bounded preview');
    assert.ok(batchBlock.includes('recoveryCommand: `cli-jaw worker read ${slot.runId} --tail 120`'), 'batch summaries must include worker read recovery command');
    assert.ok(batchBlock.includes('outputBytes: run?.outputBytes || 0'), 'batch summaries must include durable output size');
    assert.equal(batchBlock.includes('ok: true, text'), false, 'batch success response must not expose full text field by default');
});

test('dispatch route resolves virtual employees through shared dispatch target helper', () => {
    assert.ok(
        orchestrateSrc.includes('async function resolveDispatchTarget'),
        'dispatch route should centralize employee/static/virtual target resolution',
    );
    assert.ok(
        orchestrateSrc.includes('buildVirtualEmployeeRow'),
        'dispatch route should build ephemeral virtual employees',
    );
    assert.ok(
        orchestrateSrc.includes("Specify exactly one of agent or virtual"),
        'dispatch route should reject ambiguous agent+virtual requests',
    );
    assert.ok(
        orchestrateSrc.includes('resolveVirtualDefaults'),
        'dispatch route should use shared virtual cli/model defaults',
    );
    assert.ok(
        orchestrateSrc.includes('await resolveCliDefaultModel(cli)'),
        'virtual employee defaults must use the ocx-aware model resolver',
    );
    assert.ok(
        orchestrateSrc.includes('await resolveDispatchTarget(req.body || {}, emps)'),
        'single dispatch route must await async target resolution',
    );
    assert.ok(
        orchestrateSrc.includes('staticSpec: Awaited<ReturnType<typeof resolveDispatchableEmployee>> | null'),
        'static employee resolution type must unwrap async resolveDispatchableEmployee',
    );
});

test('batch dispatch route accepts virtual employees', () => {
    const batchStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch/batch'");
    assert.ok(batchStart >= 0, 'batch dispatch route should exist');
    const batchBlock = orchestrateSrc.slice(batchStart, batchStart + 8000);

    assert.ok(batchBlock.includes('await resolveDispatchTarget(item || {}, emps)'), 'batch route should use shared target resolver');
    assert.ok(batchBlock.includes('agentName: target.targetName'), 'batch results should label resolved target name');
    assert.ok(batchBlock.includes('emp: target.emp'), 'batch entries should execute resolved virtual/static/db row');
});

test('dispatch mutable scope validation uses projectDirs before Jaw workingDir', () => {
    assert.ok(
        orchestrateSrc.includes('function resolveDispatchProjectRoot'),
        'dispatch route should centralize project root resolution',
    );
    assert.ok(
        orchestrateSrc.includes('firstProjectDir(dispatchCtx?.projectDirs)'),
        'dispatch route should prefer orchestration projectDirs for scope sandboxing',
    );
    assert.ok(
        orchestrateSrc.includes('firstProjectDir(settings.projectDirs)'),
        'dispatch route should fall back to persisted projectDirs for scope sandboxing',
    );
    assert.ok(
        orchestrateSrc.includes('normalizeScope(dispatchProjectRoot, scope)'),
        'single dispatch should validate mutable scope against the resolved project root',
    );
    assert.ok(
        orchestrateSrc.includes('postDispatchDiffCheck(dispatchProjectRoot, scope)'),
        'single dispatch post-check should use the same project root as preflight',
    );
    assert.ok(
        orchestrateSrc.includes('normalizeScope(resolveDispatchProjectRoot(dispatchCtx), scope)'),
        'batch dispatch should validate mutable scope against the resolved project root',
    );
    assert.ok(
        !orchestrateSrc.includes('normalizeScope(settings["workingDir"] || process.cwd(), scope)'),
        'dispatch routes must not validate mutable scope against the Jaw identity workingDir',
    );
});

test('pipeline.ts no longer contains parseSubtasks worker dispatch', () => {
    const pipelineSrc = readSource(join(projectRoot, 'src/orchestrator/pipeline.ts'), 'utf8');

    // Worker JSON dispatch block must be removed
    assert.ok(
        !pipelineSrc.includes('worker JSON detected'),
        'pipeline.ts should not contain worker JSON dispatch block after patch3',
    );
    assert.ok(
        !pipelineSrc.includes('parseSubtasks(result.text)'),
        'pipeline.ts should not call parseSubtasks on boss result',
    );
    // stripSubtaskJSON should still exist for plan saving
    assert.ok(
        pipelineSrc.includes('stripSubtaskJSON'),
        'pipeline.ts should still use stripSubtaskJSON for plan saving',
    );
});

test('server boot does not import or start token keep-alive', () => {
    assert.ok(
        !serverSrc.includes("from './lib/token-keepalive.js'"),
        'server.ts should not import token keep-alive',
    );
    assert.ok(
        !serverSrc.includes('startTokenKeepAlive();'),
        'server.ts should not start token keep-alive at boot',
    );
});

// ─── Phase 56.1: Shared Plan auto-injection contract ──

test('dispatch route auto-injects full ctx.plan without truncation or file reference', () => {
    const routeStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch'");
    assert.ok(routeStart >= 0, 'dispatch route should exist');
    const routeBlock = orchestrateSrc.slice(routeStart, routeStart + 9000);

    // sharedPlanPath branch must be gone.
    assert.ok(
        !routeBlock.includes('dispatchCtx?.sharedPlanPath'),
        'dispatch route must not reference dispatchCtx.sharedPlanPath after Phase 56.1',
    );
    assert.ok(
        !routeBlock.includes('First read the approved plan at:'),
        'dispatch must not instruct worker to read an external plan file',
    );

    // Truncation removed.
    assert.ok(
        !routeBlock.includes('plan.slice(0, 3000)') && !routeBlock.includes("slice(0, 3000)"),
        'dispatch route must not truncate ctx.plan to 3000 chars after Phase 56.1',
    );

    // New inline prepend header must be present.
    assert.ok(
        routeBlock.includes('## Approved Plan'),
        'dispatch route must prepend "## Approved Plan" header when ctx.plan exists',
    );

    // Must still guard on ctx.plan existing.
    assert.ok(
        routeBlock.includes('dispatchCtx?.plan'),
        'dispatch route must still guard the prepend on dispatchCtx?.plan',
    );
});

test('dispatch routes forward task_tags end-to-end (260703 dispatch affordance)', () => {
    const singleStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch'");
    const singleBlock = orchestrateSrc.slice(singleStart, singleStart + 16000);
    assert.ok(
        singleBlock.includes('normalizeTaskTags(req.body?.task_tags)'),
        'single dispatch must extract task_tags from the request body',
    );
    assert.ok(
        singleBlock.includes('task_tags: taskTags'),
        'single dispatch ap must carry the extracted task_tags',
    );

    const batchStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch/batch'");
    assert.ok(batchStart >= 0, 'batch dispatch route should exist');
    const batchBlock = orchestrateSrc.slice(batchStart, batchStart + 20000);
    assert.ok(
        batchBlock.includes('normalizeTaskTags(item?.task_tags)'),
        'batch dispatch must extract per-entry task_tags',
    );
    assert.ok(
        batchBlock.includes('task_tags: entry.taskTags'),
        'batch ap must carry the entry task_tags',
    );
});

test('batch dispatch pre-claims slots and supports wait:false 202 (260703)', () => {
    const batchStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch/batch'");
    const batchBlock = orchestrateSrc.slice(batchStart, batchStart + 20000);

    assert.ok(
        batchBlock.includes('const batchWait = req.body?.wait !== false'),
        'batch route must parse wait:false',
    );
    // Pre-claim: claims happen in the claimedEntries map, before executeBatch —
    // the 202 body must carry real runIds (fail-fast WorkerBusyError parity).
    const claimIdx = batchBlock.indexOf('claimedEntries');
    const executeIdx = batchBlock.indexOf('const executeBatch');
    assert.ok(claimIdx >= 0 && executeIdx > claimIdx, 'slots must be claimed before execution is defined');
    assert.ok(
        batchBlock.includes('res.status(202)'),
        'wait:false must answer 202 before execution',
    );
    assert.ok(
        batchBlock.match(/202[\s\S]*runId: c\.slot\.runId/),
        '202 body must carry pre-claimed runIds',
    );
    // Proactive drain mirrors the single-dispatch disconnect branch.
    const drainIdx = batchBlock.indexOf('drainPendingReplays', batchBlock.indexOf('res.status(202)'));
    assert.ok(drainIdx >= 0, 'detached batch execution must trigger a proactive drainPendingReplays');
});

test('batch dispatch aggregates verdicts and persists gate status (260703)', () => {
    const batchStart = orchestrateSrc.indexOf("app.post('/api/orchestrate/dispatch/batch'");
    const batchBlock = orchestrateSrc.slice(batchStart, batchStart + 20000);

    assert.ok(
        batchBlock.includes('aggregateBatchVerdicts(currentOrcState'),
        'batch route must aggregate worker verdicts via the pure function',
    );
    assert.ok(
        batchBlock.includes('parseWorkerVerdict(text)'),
        'batch runOne must parse each worker verdict',
    );
    // Same race guard as single dispatch (Phase 58).
    assert.ok(
        batchBlock.includes('stateAtCompletion === currentOrcState'),
        'batch persistence must keep the state-race guard',
    );
    assert.ok(
        batchBlock.includes('auditStatus: aggregate') && batchBlock.includes('verificationStatus: aggregate'),
        'batch persistence must write auditStatus (A) / verificationStatus (B)',
    );
    // Opus correctness review FINDING 2: a crashed/busy worker (ok:false) must
    // never be absorbed into a POSITIVE gate verdict.
    assert.ok(
        batchBlock.includes('anyExecutionFailure') &&
        batchBlock.match(/anyExecutionFailure\s*&&\s*\(aggregate === 'pass' \|\| aggregate === 'done'\)/),
        'a positive aggregate must be suppressed when any batch worker failed to execute',
    );
    assert.ok(
        batchBlock.includes('res.json({ ok: true, results, orchestration })'),
        'synchronous batch response must include orchestration diagnostics',
    );
});

test('dead buildPlanPrompt stays deleted from distribute.ts (260703)', () => {
    const distributeSrc = readSource(join(projectRoot, 'src/orchestrator/distribute.ts'), 'utf8');
    assert.ok(
        !distributeSrc.includes('buildPlanPrompt'),
        'buildPlanPrompt was dead code carrying an abandoned subtasks schema — must not return',
    );
});

test('snapshot endpoint sanitizes ctx and does not expose sharedPlanPath', () => {
    const snapStart = orchestrateSrc.indexOf("app.get('/api/orchestrate/snapshot'");
    assert.ok(snapStart >= 0, 'snapshot route should exist');
    const snapBlock = orchestrateSrc.slice(snapStart, snapStart + 3000);

    // Whitelist builder must be present.
    assert.ok(
        snapBlock.includes('const safeCtx'),
        'snapshot route must build a whitelisted safeCtx',
    );

    // Top-level sharedPlanPath field must be removed from the response body.
    // (We only care about assignments like `sharedPlanPath: ctx?.sharedPlanPath`.)
    assert.ok(
        !snapBlock.match(/sharedPlanPath:\s*ctx\?\.sharedPlanPath/),
        'snapshot must not expose top-level sharedPlanPath field',
    );

    // Response must use safeCtx, not the raw ctx.
    assert.ok(
        snapBlock.match(/ctx:\s*safeCtx/),
        'snapshot response must use safeCtx instead of raw ctx',
    );
});
