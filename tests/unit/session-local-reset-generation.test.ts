import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bumpGenerationForSessionLocalReset,
    bumpSessionOwnershipGeneration,
    getSessionOwnershipGeneration,
    isCurrentSessionOwner,
    resetSessionOwnershipGenerationForTest,
} from '../../src/agent/session-persistence.ts';
import { withSessionScope } from '../../src/core/session-context.ts';

// 073 §2.2 — a run captures both generations when it starts and must match both when it
// saves. Resetting ONE session used to bump the global counter, so a turn running in a
// different session failed that check on the way out and threw away the conversation it
// had just created. The user sees a tab they never touched forget what was said.

test('resetting one session does not invalidate another session in flight', () => {
    resetSessionOwnershipGenerationForTest();

    // B starts a turn.
    const bToken = getSessionOwnershipGeneration('local:b');

    // A resets itself while B is still running.
    withSessionScope({ scope: 'local:a', chatSessionId: 'a' }, () => {
        bumpGenerationForSessionLocalReset();
    });

    assert.equal(isCurrentSessionOwner(bToken, 'local:b'), true,
        'B must still be able to save what it just produced');
});

test('resetting a session does invalidate that same session', () => {
    resetSessionOwnershipGenerationForTest();
    const aToken = getSessionOwnershipGeneration('local:a');

    withSessionScope({ scope: 'local:a', chatSessionId: 'a' }, () => {
        bumpGenerationForSessionLocalReset();
    });

    assert.equal(isCurrentSessionOwner(aToken, 'local:a'), false,
        'the session that asked to be reset is the one that loses its run');
});

// Outside any session context there is nothing narrower to invalidate, so it falls back
// to the global bump rather than silently doing nothing.
test('a reset with no session context still invalidates globally', () => {
    resetSessionOwnershipGenerationForTest();
    const token = getSessionOwnershipGeneration('local:b');

    bumpGenerationForSessionLocalReset();

    assert.equal(isCurrentSessionOwner(token, 'local:b'), false);
});

// A settings change really does affect every run, so that path keeps the global bump.
test('a global bump still invalidates every session', () => {
    resetSessionOwnershipGenerationForTest();
    const aToken = getSessionOwnershipGeneration('local:a');
    const bToken = getSessionOwnershipGeneration('local:b');

    bumpSessionOwnershipGeneration();

    assert.equal(isCurrentSessionOwner(aToken, 'local:a'), false);
    assert.equal(isCurrentSessionOwner(bToken, 'local:b'), false);
});
