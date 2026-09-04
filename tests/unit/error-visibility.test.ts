import test from 'node:test';
import assert from 'node:assert/strict';

import { renderAgentErrorBlock, isRenderableError } from '../../src/messaging/error-block.ts';
import { classifyExitError, parseRetryAfterMs } from '../../src/agent/error-classifier.ts';
import {
    noteRuntimeCooldown,
    isRuntimeCoolingDown,
    clearRuntimeCooldown,
    resetRuntimeCooldowns,
} from '../../src/agent/error-cooldown.ts';

// #519: a runtime failure used to reach the user as whatever prose the model had
// produced before it died. One clause in each forwarder dropped every payload
// carrying `error: true`, so a 429 or an expired login arrived as an apology
// with no cause — 20 minutes burned, then "I can't access that."
//
// The fix is opt-in rather than "stop dropping", because most error broadcasts
// carry raw exception text, a slice of the model's own output, or an internal
// employee diagnostic. These tests pin BOTH directions: the classified failure
// arrives, and the unclassified one still does not.

test('EV-001: a classified failure renders a block naming the next action', () => {
    const block = renderAgentErrorBlock({
        error: true, errorKind: 'rate_limit', text: '⚡ API 용량 초과 (429)', cli: 'codex',
    });
    assert.ok(block, 'a 429 must reach the user at all');
    assert.match(block, /429/);
    assert.match(block, /재시도/, 'the block says what happens next, which the prose never did');
    assert.match(block, /codex/, 'and which runtime it was');
});

test('EV-002: an UNCLASSIFIED error payload is still not rendered', () => {
    // The reason this is opt-in. Removing the drop outright would post raw
    // exception text, a 200-char slice of the model's own output, and unbounded
    // vendor notices into the conversation.
    assert.equal(renderAgentErrorBlock({
        error: true, text: '❌ Pi AppServer acquire failed: ENOENT /Users/someone/.pi/socket',
    }), null);
    assert.equal(isRenderableError({ error: true, text: 'raw stack frame' }), false);
});

test('EV-003: an internal-audience failure never reaches the conversation', () => {
    // broadcast(..., 'internal') suppresses only the SSE publish; the forwarder
    // listeners still run. Without this check an employee-lane error posts into
    // the user's channel.
    assert.equal(isRenderableError({
        error: true, errorKind: 'auth', audience: 'internal', text: '🔐 인증 오류',
    }), false);
    assert.equal(isRenderableError({
        error: true, errorKind: 'auth', isEmployee: true, text: '🔐 인증 오류',
    }), false);
});

test('EV-004: a successful agent_done is untouched by any of this', () => {
    assert.equal(isRenderableError({ text: 'the answer' }), false);
    assert.equal(renderAgentErrorBlock({ text: 'the answer' }), null);
});

test('EV-005: the classifier tags each failure with the kind a forwarder acts on', () => {
    assert.equal(classifyExitError('codex', 1, 'HTTP 429 too many requests').errorKind, 'rate_limit');
    assert.equal(classifyExitError('codex', 1, 'invalid credentials').errorKind, 'auth');
    assert.equal(classifyExitError('codex', 1, '', 'no output for 900s').errorKind, 'stall');
    assert.equal(classifyExitError('codex', 1, 'ECONNRESET').errorKind, 'connection');
    assert.equal(classifyExitError('codex', 1, 'something else entirely').errorKind, 'exit');
});

test('EV-006: raw child output leaves the user-facing message and stays in detail', () => {
    // The message used to BE the stderr slice. It is unbounded, carries paths,
    // and the user cannot act on it.
    const cls = classifyExitError('codex', 1, 'Traceback: /Users/someone/secret/path.py line 4');
    assert.ok(!cls.message.includes('/Users/someone'), 'a path must not be the channel message');
    assert.match(cls.message, /exit 1/, 'the message still says what happened');
    assert.match(cls.detail, /Traceback/, 'and the evidence is kept for the trace');
});

test('EV-007: retry_after_ms is milliseconds and retry-after is seconds', () => {
    // Alternation order is the whole test. Matching the second-based pattern
    // first swallows `ms` as part of the key, so a 1.5-second wait becomes 25
    // minutes and the turn parks until the cap.
    assert.equal(parseRetryAfterMs('retry_after_ms: 1500'), 1500);
    assert.equal(parseRetryAfterMs('"retry_after_ms":1500'), 1500);
    assert.equal(parseRetryAfterMs('Retry-After: 30'), 30_000);
    assert.equal(parseRetryAfterMs('retry_after: 2'), 2000);
    assert.equal(parseRetryAfterMs('nothing here'), undefined);
});

test('EV-008: an absurd retry-after is capped rather than obeyed', () => {
    assert.equal(parseRetryAfterMs('Retry-After: 86400'), 600_000);
});

test('EV-009: a parked runtime is skipped until it expires', () => {
    resetRuntimeCooldowns();
    assert.equal(isRuntimeCoolingDown('codex'), false);
    noteRuntimeCooldown('codex', 5000);
    assert.equal(isRuntimeCoolingDown('codex'), true, 'the fallback search must skip an exhausted runtime');
    assert.equal(isRuntimeCoolingDown('claude'), false, 'and only that one');
    clearRuntimeCooldown('codex');
    assert.equal(isRuntimeCoolingDown('codex'), false, 'a successful run is what proves capacity returned');
});

test('EV-010: an expired cooldown lapses on read, with no sweeper', () => {
    resetRuntimeCooldowns();
    noteRuntimeCooldown('codex', 1);
    const until = Date.now() + 30;
    while (Date.now() < until) { /* spin briefly past the expiry */ }
    assert.equal(isRuntimeCoolingDown('codex'), false, 'nothing should have to own a timer for this');
});
