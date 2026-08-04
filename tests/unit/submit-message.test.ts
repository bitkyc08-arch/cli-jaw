import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const gatewaySrc = fs.readFileSync(join(__dirname, '../../src/orchestrator/gateway.ts'), 'utf8');

// ─── SM-001: empty text → rejected/empty ───

test('SM-001: empty text returns rejected/empty', () => {
    assert.ok(
        gatewaySrc.includes("if (!trimmed) return { action: 'rejected', reason: 'empty' }"),
        'should reject empty input',
    );
});

// ─── SM-002: idle + normal → started ───

test('SM-002: idle + normal message calls insertMessage and orchestrate', () => {
    // The idle path should insert, broadcast, orchestrate, and return started
    const idlePath = gatewaySrc.slice(gatewaySrc.indexOf('// ── idle'));
    assert.ok(idlePath.includes("insertMessage.run('user'"), 'idle path inserts message');
    assert.ok(idlePath.includes("broadcast('new_message'"), 'idle path broadcasts');
    assert.ok(idlePath.includes('orchestrate(trimmed'), 'idle path calls orchestrate');
    assert.ok(idlePath.includes("action: 'started'"), 'idle returns started');
});

// ─── SM-003: busy + normal → queued (NO insertMessage) ───

test('SM-003: busy path enqueues only, does NOT call insertMessage', () => {
    // Extract the busy block
    const busyStart = gatewaySrc.indexOf('// ── busy');
    const busyEnd = gatewaySrc.indexOf('// ── idle');
    const busyBlock = gatewaySrc.slice(busyStart, busyEnd);

    assert.ok(busyBlock.includes('enqueueMessage(trimmed'), 'busy path enqueues');
    assert.ok(
        !busyBlock.includes("insertMessage.run("),
        'busy path must NOT call insertMessage (processQueue handles it)',
    );
    assert.ok(busyBlock.includes("action: 'queued'"), 'busy returns queued');
    assert.ok(busyBlock.includes('pending: messageQueue.length'), 'queued includes pending count');
});

// ─── SM-004: continue intent idle → no pending continue ───

test('SM-004: continue intent when idle → noPendingContinue + orchestrateContinue', () => {
    const continueBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── continue'),
        gatewaySrc.indexOf('// ── reset'),
    );
    assert.ok(continueBlock.includes('isContinueIntent(trimmed)'), 'checks continue intent');
    assert.ok(continueBlock.includes('orchestrateContinue('), 'calls orchestrateContinue');
    assert.ok(continueBlock.includes("action: 'started'"), 'returns started');
    assert.ok(continueBlock.includes('noPendingContinue: true'), 'idle continue returns no-pending contract');
    assert.ok(!continueBlock.includes('continued: true'), 'idle continue must not trigger worklog continue UI copy');
});

// ─── SM-005: continue intent busy → rejected/busy ───

test('SM-005: continue intent when busy → rejected/busy', () => {
    const continueBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── continue'),
        gatewaySrc.indexOf('// ── reset'),
    );
    assert.ok(
        continueBlock.includes("if (isAgentBusy(scope)) return { action: 'rejected', reason: 'busy' }"),
        'continue intent rejects when busy (429 retry-aware)',
    );
});

// ─── SM-006: reset intent idle → started ───

test('SM-006: reset intent when idle → started + orchestrateReset', () => {
    const resetBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── reset'),
        gatewaySrc.indexOf('// ── busy'),
    );
    assert.ok(resetBlock.includes('isResetIntent(trimmed)'), 'checks reset intent');
    assert.ok(resetBlock.includes('orchestrateReset('), 'calls orchestrateReset');
    assert.ok(resetBlock.includes("action: 'started'"), 'returns started');
});

// ─── SM-007: reset intent bypasses busy rejection ───

test('SM-007: reset intent when busy still starts reset flow', () => {
    const resetBlock = gatewaySrc.slice(
        gatewaySrc.indexOf('// ── reset'),
        gatewaySrc.indexOf('// ── busy'),
    );
    assert.ok(
        !resetBlock.includes("if (isAgentBusy()) return { action: 'rejected', reason: 'busy' }"),
        'reset intent should bypass busy rejection so reset remains available during retries',
    );
    assert.ok(resetBlock.includes('orchestrateReset('), 'reset path still calls orchestrateReset');
    assert.ok(resetBlock.includes("action: 'started'"), 'reset path still returns started');
});

// ─── SM-008: displayText is used for insertMessage and broadcast ───

test('SM-008: displayText is used for insert and broadcast when provided', () => {
    assert.ok(
        gatewaySrc.includes('const display = meta.displayText || trimmed'),
        'display falls back to trimmed',
    );
    // All insertMessage and broadcast calls use display
    const insertCalls = gatewaySrc.match(/insertMessage\.run\('user', display/g);
    assert.ok(insertCalls && insertCalls.length >= 3, 'all insert calls use display variable');
});

// ─── SM-009: SubmitResult type has pending field ───

test('SM-009: SubmitResult type includes pending field', () => {
    assert.ok(gatewaySrc.includes('pending?: number'), 'SubmitResult has pending field');
});

// ─── SM-010: origin is passed through to broadcast ───

test('SM-010: origin from meta is used in broadcast and orchestrate', () => {
    assert.ok(
        gatewaySrc.includes('source: meta.origin'),
        'broadcast uses meta.origin as source',
    );
    assert.ok(
        gatewaySrc.includes('origin: meta.origin'),
        'orchestrate receives meta.origin',
    );
});

test('SM-011: detached orchestration calls are rejection-safe', () => {
    assert.ok(
        gatewaySrc.includes('function runDetached('),
        'gateway should wrap detached orchestrate calls',
    );
    assert.ok(
        gatewaySrc.includes('.catch((err: unknown) =>'),
        'detached orchestrate calls should handle rejections',
    );
});

test('SM-012: admission and continue busy checks use the resolved scope', () => {
    const continueBlock = gatewaySrc.slice(gatewaySrc.indexOf('// ── continue'), gatewaySrc.indexOf('// ── reset'));
    const busyBlock = gatewaySrc.slice(gatewaySrc.indexOf('// ── busy'), gatewaySrc.indexOf('// ── idle'));
    assert.ok(continueBlock.includes('isAgentBusy(scope)'));
    assert.ok(busyBlock.includes('isAgentBusy(scope)'));
    assert.ok(busyBlock.includes('hasBlockingWorkers(scope)'));
    assert.ok(!gatewaySrc.includes('isAgentBusy()'));
});

test('SM-013: continue, reset, and idle starts all enter the captured session lane', () => {
    const starts = gatewaySrc.match(/sessionLanes\.run\(scope,/g) || [];
    assert.equal(starts.length, 3, 'continue/reset/idle must each use sessionLanes.run(scope, ...)');
    assert.ok(gatewaySrc.includes('chatSessionId'));
    assert.ok(gatewaySrc.includes('withSessionScope(sessionScope'));
});

test('SM-014: dedup admission happens only after persistent scope resolution', () => {
    const scopeResolved = gatewaySrc.indexOf('const sessionScope: SessionScope = { scope, chatSessionId }');
    const dedupAdmission = gatewaySrc.indexOf('const key = dedupKey(scope,');
    assert.ok(scopeResolved >= 0 && dedupAdmission > scopeResolved);
});
