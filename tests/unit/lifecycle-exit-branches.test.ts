import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    classifyExitError,
    shouldAnnounceStallTruncation,
    STALL_TRUNCATION_NOTICE,
} from '../../src/agent/error-classifier.ts';

// The exit handler's else-if chain decides which explanation a reader gets:
//
//   output present                      → output branch   ← the gap (#405)
//   code!==0 && wasKilled && stallReason → stall branch    ← unreachable for the watchdog
//   code!==0 && !wasKilled               → error branch    ← where a silent stall goes
//
// A watchdog kill that produced partial output stops at the first branch, which
// said nothing about being cut short. The turn just ended mid-thought.

test('LEB-001: a watchdog kill with output is announced — without wasKilled', () => {
    // wasKilled is deliberately absent from the input. The watchdog never writes
    // killReasons, so requiring it would make this branch unreachable — which is
    // the failure mode this exists to prevent.
    assert.equal(shouldAnnounceStallTruncation({
        stallReason: 'absolute timeout 933s; lastProgress=output x302',
        wasSteer: false, mainManaged: true, internal: false,
    }), true);
});

test('LEB-002: a user stop is not a timeout', () => {
    assert.equal(shouldAnnounceStallTruncation({
        stallReason: 'absolute timeout 933s', wasSteer: true, mainManaged: true, internal: false,
    }), false);
});

test('LEB-003: a turn that simply finished says nothing', () => {
    for (const stallReason of [undefined, null, '']) {
        assert.equal(shouldAnnounceStallTruncation({
            stallReason, wasSteer: false, mainManaged: true, internal: false,
        }), false, `no stall reason means no notice: ${JSON.stringify(stallReason)}`);
    }
});

test('LEB-004: runs with no reader stay quiet', () => {
    const stallReason = 'absolute timeout 933s';
    assert.equal(shouldAnnounceStallTruncation({
        stallReason, wasSteer: false, mainManaged: false, internal: false,
    }), false, 'a sub-agent run has no channel to explain itself to');
    assert.equal(shouldAnnounceStallTruncation({
        stallReason, wasSteer: false, mainManaged: true, internal: true,
    }), false, 'an internal run has no reader either');
});

test('LEB-005: a silent stall is still explained, by the other branch', () => {
    // No output means the error branch, which passes stallReason into
    // classifyExitError. So the user is told either way, and the two messages
    // are different — the output branch cannot double up on this one.
    const classified = classifyExitError(
        'cursor', 1, '', 'absolute timeout 933s; lastProgress=output x302',
    );
    assert.equal(classified.isStall, true);
    assert.match(classified.message, /응답 없음/);
    assert.notEqual(classified.message, STALL_TRUNCATION_NOTICE);
});

test('LEB-006: the output branch uses the shared decision, not its own condition', () => {
    // Guards the wiring the pure tests above cannot see: a copy of the condition
    // inlined here would drift from what LEB-001..004 verify.
    const src = readFileSync(
        join(import.meta.dirname, '..', '..', 'src/agent/lifecycle-handler.ts'), 'utf8',
    );
    const outputBranch = src.slice(
        src.indexOf('// ─── Output handling ───'),
        src.indexOf('const { message: errMsg } = classifyExitError('),
    );
    assert.match(outputBranch, /shouldAnnounceStallTruncation\(\{/);
    assert.match(outputBranch, /STALL_TRUNCATION_NOTICE/);
});
