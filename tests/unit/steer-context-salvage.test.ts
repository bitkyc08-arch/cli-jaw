// wp1 (devlog/_plan/260903_steer_default_context/010): kill-path steer must
// deliver the interrupted turn's partial output to the follow-up run.
// Behavioral tests only — no source scanning.
// Must be the FIRST import: config.ts binds DB_PATH at module evaluation.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withSteerContext, STEER_SALVAGE_MAX_CHARS } from '../../src/agent/prompt-context.ts';
import { db, insertMessage, getMaxMessageId, getSteerSalvageAfter } from '../../src/core/db.ts';
import { armExitSettle, settleExit, waitForExitSettled } from '../../src/agent/spawn.ts';
import { orchestrate } from '../../src/orchestrator/pipeline.ts';
import { resetState } from '../../src/orchestrator/state-machine.ts';

// ─── SC-001..003: withSteerContext pure prompt assembly ───

test('SC-001: no salvage leaves the prompt byte-identical', () => {
    assert.equal(withSteerContext('do X'), 'do X');
    assert.equal(withSteerContext('do X', ''), 'do X');
    assert.equal(withSteerContext('do X', '   '), 'do X');
    assert.equal(withSteerContext('do X', null), 'do X');
    assert.equal(withSteerContext('do X', undefined), 'do X');
});

test('SC-002: salvage block precedes the prompt and marks it incomplete', () => {
    const out = withSteerContext('NEW INSTRUCTION', 'partial work output');
    assert.ok(out.includes('partial work output'), 'contains salvage');
    assert.ok(out.includes('NEW INSTRUCTION'), 'contains prompt');
    assert.ok(out.indexOf('partial work output') < out.indexOf('NEW INSTRUCTION'), 'salvage first');
    assert.ok(out.includes('<partial_output>'), 'structured fence');
    assert.ok(/INCOMPLETE/.test(out), 'marks the salvage as incomplete');
    assert.ok(!out.includes('[truncated]'), 'no truncation marker under the cap');
});

test('SC-003: salvage longer than the cap keeps the TAIL with a truncation marker', () => {
    const head = 'H'.repeat(100);
    const tail = 'T'.repeat(100);
    const salvage = head + 'M'.repeat(STEER_SALVAGE_MAX_CHARS) + tail;
    const out = withSteerContext('p', salvage);
    assert.ok(out.includes('[truncated]'), 'truncation marker');
    assert.ok(out.includes(tail), 'tail preserved (recent context matters most)');
    assert.ok(!out.includes(head), 'oldest content dropped first');
});

// ─── SC-004..006: salvage identity in the messages table ───

const SC_SESSION = 'steer-salvage-test';

test('SC-004: salvage row is the first interrupted assistant row ABOVE the pre-kill mark', () => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(SC_SESSION);
    // A stale interrupted row from an EARLIER steer must not be picked up.
    insertMessage.run('assistant', '⏹️ [interrupted]\n\nold partial', 'codex', '', null, SC_SESSION);
    insertMessage.run('user', 'work on the thing', 'codex', '', null, SC_SESSION);
    const mark = getMaxMessageId(SC_SESSION);
    insertMessage.run('assistant', '⏹️ [interrupted]\n\nfresh partial output', 'codex', '', null, SC_SESSION);
    const salvage = getSteerSalvageAfter(SC_SESSION, mark);
    assert.equal(salvage, '⏹️ [interrupted]\n\nfresh partial output');
});

test('SC-005: no new interrupted row above the mark → null (no salvage attached)', () => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(SC_SESSION);
    insertMessage.run('assistant', '⏹️ [interrupted]\n\nold partial', 'codex', '', null, SC_SESSION);
    const mark = getMaxMessageId(SC_SESSION);
    // New rows that are NOT interrupted output must not qualify.
    insertMessage.run('assistant', 'ordinary answer', 'codex', '', null, SC_SESSION);
    insertMessage.run('user', '⏹️ [interrupted] user-typed text is not salvage', 'codex', '', null, SC_SESSION);
    assert.equal(getSteerSalvageAfter(SC_SESSION, mark), null);
});

test('SC-006: salvage lookup is session-scoped', () => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run('steer-other-session');
    insertMessage.run('assistant', '⏹️ [interrupted]\n\nother session partial', 'codex', '', null, 'steer-other-session');
    const mark = getMaxMessageId(SC_SESSION);
    assert.equal(getSteerSalvageAfter(SC_SESSION, mark), null);
});

// ─── SC-007..009: exit-settle barrier ───

test('SC-007: unarmed scope resolves immediately', async () => {
    const t0 = Date.now();
    await waitForExitSettled('sc007-never-armed', 1000);
    assert.ok(Date.now() - t0 < 500, 'should not wait without an arm');
});

test('SC-008: armed barrier pends until settleExit', async () => {
    const scope = 'sc008-armed';
    armExitSettle(scope);
    let settled = false;
    const waiter = waitForExitSettled(scope, 5000).then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(settled, false, 'must still be waiting before settle');
    settleExit(scope);
    await waiter;
    assert.equal(settled, true, 'settle releases the waiter');
    // Arm is consumed: a later wait must not see the old barrier.
    await waitForExitSettled(scope, 50);
});

test('SC-009: timeout releases and drops the arm (wedged exit handler must not hang steer)', async () => {
    const scope = 'sc009-timeout';
    armExitSettle(scope);
    const t0 = Date.now();
    await waitForExitSettled(scope, 60);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 50 && elapsed < 3000, `bounded wait, got ${elapsed}ms`);
    // Arm dropped after timeout — no stale barrier lingers for the next steer.
    await waitForExitSettled(scope, 20);
});

// ─── SC-010: pipeline passes _steerContext into spawn opts ───

test('SC-010: orchestrate meta._steerContext reaches spawn opts as steerContext', async () => {
    resetState('default');
    let captured: Record<string, unknown> | undefined;
    await orchestrate('steer follow-up', {
        origin: 'test',
        _skipClear: true,
        _skipReplayDrain: true,
        _skipInsert: true,
        _steerContext: 'SALVAGED-PARTIAL',
        _spawnAgent: (_prompt: string, opts: Record<string, unknown>) => {
            captured = opts;
            return { child: null, promise: Promise.resolve({ text: 'ok', code: 0 }) };
        },
    });
    assert.equal(captured?.steerContext, 'SALVAGED-PARTIAL');
    resetState('default');
});

test('SC-011: without _steerContext the spawn opts carry no steerContext', async () => {
    resetState('default');
    let captured: Record<string, unknown> | undefined;
    await orchestrate('plain run', {
        origin: 'test',
        _skipClear: true,
        _skipReplayDrain: true,
        _skipInsert: true,
        _spawnAgent: (_prompt: string, opts: Record<string, unknown>) => {
            captured = opts;
            return { child: null, promise: Promise.resolve({ text: 'ok', code: 0 }) };
        },
    });
    assert.equal(captured?.steerContext, undefined);
    resetState('default');
});
