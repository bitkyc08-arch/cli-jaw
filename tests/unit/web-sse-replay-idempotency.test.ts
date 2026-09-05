// ── SSE replay idempotency contracts (devlog 260612 manager_stream_hidden_state_audit 06-08) ──
// Root cause being guarded: SSE reconnect replays (event-channel ?lastEventId=
// → routes/events replaySince) were applied by the web dispatcher as if live.
// A replayed agent_done from a FINISHED turn ran finalizeAgent() mid-turn —
// freezing the in-flight live block as a collapsed VS item — and the replayed
// agent_output/agent_tool stream rebuilt the same turn into a second block
// (duplicate-block screenshot, instance 3466, 2026-06-12 11:04).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wsSrc = readFileSync(join(__dirname, '../../public/js/ws.ts'), 'utf8');
const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
const claudeEventsSrc = readFileSync(join(__dirname, '../../src/agent/events/claude.ts'), 'utf8');

// ─── Server: run identity + cumulative cursor ride on the agent stream ───

// RID-001 is exercised through real lifecycle terminals in web-replay-behavior.test.ts.

test('RID-002: agent_output flows through the single broadcastAgentOutput choke point with traceRunId + textLen', () => {
    assert.ok(spawnSrc.includes('function broadcastAgentOutput('), 'spawn.ts should own the agent_output choke point');
    assert.ok(spawnSrc.includes("...(ctx.traceRunId ? { traceRunId: ctx.traceRunId } : {})"), 'agent_output should carry the run id');
    assert.ok(spawnSrc.includes('...(textLen !== null ? { textLen } : {})'), 'agent_output should carry the cumulative text cursor');
    const inlineOutputs = (spawnSrc.match(/broadcast\('agent_output'/g) || []).length;
    assert.equal(inlineOutputs, 1, 'only broadcastAgentOutput may emit agent_output directly');
});

test('RID-003: live-run accumulation has a single owner (claude events must not double-append)', () => {
    assert.ok(!claudeEventsSrc.includes('appendLiveRunText'),
        'events/claude.ts must not append to the live run — broadcastAgentOutput owns it (07 F-T4 double-snapshot-text)');
});

test('RID-004: live run snapshot exposes traceRunId for client cursor sync', () => {
    const liveRunSrc = readFileSync(join(__dirname, '../../src/agent/live-run-state.ts'), 'utf8');
    assert.ok(liveRunSrc.includes('traceRunId?: string'), 'LiveRunEntry should carry traceRunId');
    assert.ok(liveRunSrc.includes('export function setLiveRunTraceId'), 'trace id binds after startTraceRun');
    assert.match(liveRunSrc, /appendLiveRunText\(scope: string, text: string\): number \| null/,
        'appendLiveRunText should return the cumulative cursor');
    assert.ok(spawnSrc.includes('setLiveRunTraceId(liveScope, traceRunId)'), 'spawn paths must bind the trace id to the live run');
});

// ─── Client: replayed events must not corrupt the in-flight turn ───

// RID-005 is exercised through actual event dispatch and owned A/B DOM hosts in
// web-print-activity-settlement.test.ts; helper placement is not a behavior contract.

test('RID-006: replayed agent_output chunks dedupe on the cumulative textLen cursor', () => {
    const outBlock = wsSrc.slice(wsSrc.indexOf("msg.type === 'agent_output'"), wsSrc.indexOf("msg.type === 'agent_retry'"));
    assert.ok(outBlock.includes('if (isFinalizedRun(outputRunId)) return'), 'chunks of finalized runs must be dropped');
    assert.ok(outBlock.includes('if (msg.textLen <= liveAppliedTextLen) {'), 'chunks at/below the applied cursor must not append');
    assert.ok(outBlock.includes('outputText.slice(-missing)'), 'partial overlaps must append only the unseen tail');
});

test('RID-012: live agent_output behind the cursor resyncs instead of freezing the stream (260613 10 P1-b)', () => {
    const outBlock = wsSrc.slice(wsSrc.indexOf("msg.type === 'agent_output'"), wsSrc.indexOf("msg.type === 'agent_retry'"));
    assert.ok(outBlock.includes("msg.sseReplay !== true && msg.textLen < liveAppliedTextLen"),
        'only live (non-replay) chunks strictly behind the cursor trigger the resync path');
    const resyncIdx = outBlock.indexOf('msg.sseReplay !== true');
    const resyncBlock = outBlock.slice(resyncIdx, outBlock.indexOf('}', resyncIdx + 200));
    assert.ok(resyncBlock.includes('liveAppliedTextLen = msg.textLen'),
        'a live chunk behind the cursor must re-base the cursor to the server cumulative length');
});

test('RID-013: bgtask-origin new_message renders in the web UI (260613 10 P1-a)', () => {
    const nmIdx = wsSrc.indexOf("msg.type === 'new_message'");
    const nmCond = wsSrc.slice(nmIdx, wsSrc.indexOf('{', nmIdx));
    assert.ok(nmCond.includes("msg.source === 'bgtask'"), 'bgtask completion turns must not be filtered out');
    assert.ok(nmCond.includes("msg.source === 'telegram'") && nmCond.includes("msg.source === 'discord'"),
        'existing remote-origin rendering must stay intact');
});

test('RID-014: identical active-run snapshots are a hydration no-op (260613 10 P1-c)', () => {
    const uiSrc = readFileSync(join(__dirname, '../../public/js/ui.ts'), 'utf8');
    assert.ok(uiSrc.includes('function hydrationSignature('), 'hydration signature helper should exist');
    assert.ok(uiSrc.includes('signature === lastHydrationSignature && currentAgentDivForActiveRun()) return'),
        'unchanged snapshots with a live hydrated block must skip the merge + stream reset');
    assert.ok(uiSrc.includes('lastHydrationSignature = signature'),
        'a real hydration must record its signature');
    const finalizeBlock = uiSrc.slice(uiSrc.indexOf('export function finalizeAgent('));
    assert.ok(finalizeBlock.includes("lastHydrationSignature = ''"),
        'finalize must reset the signature so the next run hydrates fresh');
});

test('RID-007: replayed agent_tool events of finalized runs are dropped', () => {
    const toolBlock = wsSrc.slice(wsSrc.indexOf("msg.type === 'agent_tool'"), wsSrc.indexOf("msg.type === 'agent_output'"));
    assert.ok(toolBlock.includes('if (isFinalizedRun(toolRunId)) return'), 'steps of finalized runs must not rebuild a second process block');
});

test('RID-008: replayed same-run agent_tool events already covered by snapshot hydration are dropped', () => {
    const toolBlock = wsSrc.slice(wsSrc.indexOf("msg.type === 'agent_tool'"), wsSrc.indexOf("msg.type === 'agent_output'"));
    assert.ok(wsSrc.includes('const liveAppliedToolSeqByRun = new Map'), 'tool replay guard should track applied traceSeq by run');
    assert.ok(wsSrc.includes('function shouldDropReplayedTool('), 'tool replay guard helper should exist');
    assert.ok(toolBlock.includes('const toolSeq = positiveSeq(msg.traceSeq)'), 'agent_tool should normalize traceSeq');
    assert.ok(toolBlock.includes('shouldDropReplayedTool(toolRunId, toolSeq, msg.sseReplay === true)'), 'only SSE replayed tool events at/below cursor should be dropped');
    assert.ok(toolBlock.indexOf('shouldDropReplayedTool(') < toolBlock.indexOf('showProcessStep({'),
        'replayed hydrated tools must be dropped before rendering');
    assert.ok(toolBlock.includes('rememberAppliedToolSeq(toolRunId, toolSeq)'), 'accepted tool events should advance the cursor for later replay suppression');
});

test('RID-009: snapshot hydration moves the replay cursors to the hydrated state', () => {
    assert.ok(wsSrc.includes('function syncLiveRunCursor('), 'cursor sync helper should exist');
    assert.ok(wsSrc.includes('syncLiveRunCursor(snap.activeRun)'), 'hydrateRun snapshots must sync the cursors');
    assert.ok(wsSrc.includes("? activeRun.textLen"), 'cursor must prefer the server uncapped cumulative counter');
    assert.ok(wsSrc.includes(": (activeRun.text || '').length"), 'text length stays the fallback for old servers');
    assert.ok(wsSrc.includes('for (const [runId, seq] of appliedToolSeqByRun(activeRun))'),
        'cursors must seed EVERY run id in the hydrated toolLog — employee mirrors carry their own traceRunId (review #7)');
});

test('RID-015: live-run text is tail-capped while textLen reports the uncapped cursor (260613 50 5a)', async () => {
    const { beginLiveRun, appendLiveRunText, getLiveRun, clearLiveRun } =
        await import('../../src/agent/live-run-state.ts');
    const scope = 'unit-text-cap';
    try {
        beginLiveRun(scope, 'claude-e');
        const chunk = 'x'.repeat(60_000);
        let cursor: number | null = 0;
        for (let i = 0; i < 5; i++) cursor = appendLiveRunText(scope, chunk);
        assert.equal(cursor, 300_000, 'textLen must keep the uncapped cumulative length');
        const snap = getLiveRun(scope);
        assert.equal(snap.textLen, 300_000, 'snapshot exposes the uncapped counter');
        assert.ok(snap.text.length <= 200_000, `text must stay tail-capped (got ${snap.text.length})`);
        assert.ok(snap.text.endsWith('x'), 'the retained text is the newest tail');
    } finally {
        clearLiveRun(scope);
    }
});

// RID-010 tagged/legacy completion and steer replay behavior live in web-replay-behavior.test.ts.

// ─── Behavior: live-run-state cursor semantics ───

test('RID-011: appendLiveRunText returns the cumulative cursor and setLiveRunTraceId rides the snapshot', async () => {
    const { beginLiveRun, appendLiveRunText, setLiveRunTraceId, getLiveRun, clearLiveRun } =
        await import('../../src/agent/live-run-state.ts');
    const scope = 'unit-replay-meta';
    try {
        assert.equal(appendLiveRunText(scope, 'before-begin'), null, 'no live run → null cursor');
        beginLiveRun(scope, 'claude-e');
        setLiveRunTraceId(scope, 'tr_unit_replay');
        assert.equal(appendLiveRunText(scope, 'hello '), 6);
        assert.equal(appendLiveRunText(scope, 'world'), 11, 'cursor accumulates across chunks');
        const snap = getLiveRun(scope);
        assert.equal(snap.traceRunId, 'tr_unit_replay', 'snapshot exposes the owning run id');
        assert.equal(snap.text, 'hello world');
    } finally {
        clearLiveRun(scope);
    }
});
