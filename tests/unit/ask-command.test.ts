import test from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeForOutcome, isSettlementFrame, renderOutcome } from '../../bin/commands/ask.ts';

// #276: `jaw ask` is the non-interactive prompt path for headless hosts. Two
// details decide whether it works at all, and both were wrong in a first pass.

test('settlement frames are recognized on both transports', () => {
    // The SSE serializer names the kind in `event`; the WebSocket fallback uses
    // `type`. Matching only `type` made the command hang until timeout even
    // though the server had already answered.
    assert.equal(isSettlementFrame({ event: 'request_settled' }), true);
    assert.equal(isSettlementFrame({ type: 'request_settled' }), true);
    assert.equal(isSettlementFrame({ event: 'agent_done' }), false);
    assert.equal(isSettlementFrame({ event: 'new_message' }), false);
    assert.equal(isSettlementFrame({}), false);
});

test('steered counts as success, because nothing failed', () => {
    // A busy server injects the prompt into the running turn. There is no
    // separate answer to wait for, but the prompt was delivered.
    assert.equal(exitCodeForOutcome('completed'), 0);
    assert.equal(exitCodeForOutcome('steered'), 0);
});

test('every non-delivery outcome exits nonzero', () => {
    for (const outcome of ['failed', 'cancelled', 'dropped', 'skipped', 'merged', undefined]) {
        assert.equal(exitCodeForOutcome(outcome), 1, `${outcome} must not report success`);
    }
});

test('--json emits one parseable object per outcome', () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => { lines.push(String(msg)); };
    try {
        renderOutcome({ requestId: 'r1', outcome: 'completed', text: 'hello' }, true);
        renderOutcome({ requestId: 'r2', outcome: 'failed', error: 'boom' }, true);
    } finally {
        console.log = origLog;
    }
    assert.equal(lines.length, 2);
    const ok = JSON.parse(lines[0]!);
    assert.deepEqual(ok, { ok: true, requestId: 'r1', outcome: 'completed', text: 'hello' });
    const bad = JSON.parse(lines[1]!);
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'boom');
});

test('plain mode prints only the answer to stdout', () => {
    // A script does `answer=$(jaw ask ...)`, so anything else on stdout is
    // corruption. Status lines belong on stderr.
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg?: unknown) => { out.push(String(msg)); };
    console.error = (msg?: unknown) => { err.push(String(msg)); };
    try {
        renderOutcome({ requestId: 'r1', outcome: 'completed', text: 'the answer' }, false);
        renderOutcome({ requestId: 'r2', outcome: 'steered' }, false);
    } finally {
        console.log = origLog;
        console.error = origErr;
    }
    assert.deepEqual(out, ['the answer'], 'stdout carries the answer and nothing else');
    assert.equal(err.length, 1, 'the steered notice goes to stderr');
    assert.match(err[0]!, /in-progress turn/);
});
