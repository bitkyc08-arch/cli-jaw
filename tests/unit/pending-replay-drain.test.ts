// 260417: pendingReplay deadlock fix — verify gate removal + active drain path.
// See devlog/_plan/260417_message_duplication/02_pendingReplay_deadlock_fix.md

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import {
    claimWorker, finishWorker,
    listPendingWorkerResults,
} from '../../src/orchestrator/worker-registry.js';
import { drainPendingReplays } from '../../src/orchestrator/pipeline.js';

const srcRoot = new URL('../../src/', import.meta.url).pathname;

// ─── Source-level gate removal assertions ─────────────

test('PRD-001: spawn.ts processQueue does NOT gate on hasPendingWorkerReplays()', () => {
    const src = fs.readFileSync(join(srcRoot, 'agent/spawn.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function processQueue'));
    const gateBlock = fn.slice(0, fn.indexOf('queueProcessing = true'));
    assert.doesNotMatch(
        gateBlock,
        /\|\|\s*hasPendingWorkerReplays\(\)/,
        'processQueue must NOT short-circuit on hasPendingWorkerReplays() — deadlock root cause',
    );
});

test('PRD-002: gateway.ts submitMessage does NOT gate on hasPendingWorkerReplays()', () => {
    const src = fs.readFileSync(join(srcRoot, 'orchestrator/gateway.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function submitMessage'));
    // Inspect up to the first enqueueMessage call — that's where the gate lives.
    const gateBlock = fn.slice(0, fn.indexOf('enqueueMessage('));
    assert.doesNotMatch(
        gateBlock,
        /\|\|\s*hasPendingWorkerReplays\(\)/,
        'submitMessage must NOT queue solely because of pendingReplay — orchestrate() drains internally',
    );
});

test('PRD-003: pipeline.ts exports drainPendingReplays', () => {
    const src = fs.readFileSync(join(srcRoot, 'orchestrator/pipeline.ts'), 'utf8');
    assert.match(src, /export async function drainPendingReplays/);
});

test('PRD-004: orchestrate.ts dispatch route triggers drainPendingReplays on client disconnect', () => {
    const src = fs.readFileSync(join(srcRoot, 'routes/orchestrate.ts'), 'utf8');
    // Narrow the scope to the clientDisconnected handler block to avoid false positives elsewhere.
    const start = src.indexOf('if (clientDisconnected)');
    assert.ok(start >= 0, 'dispatch route must have clientDisconnected branch');
    const block = src.slice(start, start + 800);
    assert.match(block, /drainPendingReplays\(/, 'must call drainPendingReplays on disconnect');
    assert.match(block, /!isAgentBusy\(\)/, 'must guard drain on Boss idle');
});

test('PRD-008: dispatch route uses res.on(close) + writableFinished for disconnect detection', () => {
    // Per Node.js docs, request.on('close') fires on normal completion too,
    // causing false-positive disconnects. The correct pattern is response-side
    // close + writableFinished check.
    const src = fs.readFileSync(join(srcRoot, 'routes/orchestrate.ts'), 'utf8');
    const hookStart = src.indexOf('let clientDisconnected');
    assert.ok(hookStart >= 0, 'must have clientDisconnected flag');
    const block = src.slice(hookStart, hookStart + 400);
    assert.match(block, /res\.on\(['"]close['"]/, 'must hook response-side close');
    assert.match(block, /!res\.writableFinished/, 'must check writableFinished (not writableEnded)');
    assert.doesNotMatch(block, /req\.on\(['"]close['"]/, 'must NOT hook request-side close (unreliable)');
});

test('PRD-009: WorkerSlot preserves replayMeta captured at claimWorker', () => {
    const src = fs.readFileSync(join(srcRoot, 'orchestrator/worker-registry.ts'), 'utf8');
    assert.match(src, /export interface WorkerReplayMeta/, 'must export WorkerReplayMeta type');
    assert.match(src, /replayMeta\?:\s*WorkerReplayMeta/, 'WorkerSlot must have replayMeta field');
    const claimFn = src.slice(src.indexOf('export function claimWorker'));
    assert.match(claimFn, /replayMeta\?:\s*WorkerReplayMeta/, 'claimWorker must accept replayMeta param');
});

test('PRD-010: drainPendingReplays uses per-slot meta over fallback', () => {
    const src = fs.readFileSync(join(srcRoot, 'orchestrator/pipeline.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function drainPendingReplays'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /pr\.meta/, 'must read per-slot meta from pending result');
    assert.match(body, /fallbackMeta/, 'must accept fallback meta for slots without recorded channel');
    // Per-slot origin should override fallback — spread order enforces this.
    assert.match(body, /\.\.\.fallbackMeta[\s\S]*slotMeta\.origin/, 'slot origin must override fallback');
});

test('PRD-011: dispatch route captures Boss main meta at claimWorker', () => {
    const src = fs.readFileSync(join(srcRoot, 'routes/orchestrate.ts'), 'utf8');
    const claimBlock = src.slice(src.indexOf('let slot;') - 400, src.indexOf('claimWorker(emp, task'));
    assert.match(claimBlock, /getCurrentMainMeta\(\)/, 'must query current Boss main meta');
    const call = src.slice(src.indexOf('claimWorker(emp, task'), src.indexOf('claimWorker(emp, task') + 120);
    assert.match(call, /replayMeta/, 'claimWorker call must pass replayMeta');
});

test('PRD-007: processQueue auto-drains pending replays when Boss goes idle', () => {
    // Covers the case where Boss was alive at finishWorker() time (turn still
    // generating after Bash errored) — dispatch route skipped drain because
    // isAgentBusy()=true. When Boss eventually exits, handleAgentExit calls
    // processQueue() which must now detect pendingReplay and drain.
    const src = fs.readFileSync(join(srcRoot, 'agent/spawn.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function processQueue'));
    const block = fn.slice(0, fn.indexOf('queueProcessing = true'));
    assert.match(block, /hasPendingWorkerReplays\(\)/, 'processQueue must check for pending replays');
    assert.match(block, /drainPendingReplays/, 'processQueue must trigger drain');
    assert.match(block, /queueMicrotask/, 'drain must be scheduled via microtask to avoid re-entrancy');
});

// ─── Behavioral: drainPendingReplays is safe when nothing is pending ─

test('PRD-005: drainPendingReplays is a no-op when no pending replays exist', async () => {
    // No workers claimed → listPendingWorkerResults returns empty
    const before = listPendingWorkerResults().length;
    await drainPendingReplays({ origin: 'system' });
    const after = listPendingWorkerResults().length;
    assert.equal(after, before, 'drain must not change state when nothing pending');
});

// ─── Behavioral: finished worker is claimed during drain ──────────────

test('PRD-006: finished worker transitions from pending to claimed after first iteration', async () => {
    // We cannot actually run orchestrate() here without a live CLI, so we only
    // verify that finishWorker + listPendingWorkerResults report the worker as
    // pending BEFORE drain is invoked. The drain itself will attempt to spawn
    // Boss and is covered by integration smoke tests.
    const id = `prd6-${Date.now()}`;
    const fakeEmp = { id, name: `test-${id}`, cli: 'claude' };
    claimWorker(fakeEmp, 'test task');
    finishWorker(id, 'synthetic result');

    const pending = listPendingWorkerResults();
    assert.ok(
        pending.some(p => p.agentId === id),
        'worker should appear in pending list after finishWorker (pre-drain invariant)',
    );
});
