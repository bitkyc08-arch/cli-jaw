import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.ts';
import { settings } from '../../src/core/config.ts';
import { clearSessionState, resetSessionOnly } from '../../src/core/session-ops.ts';
import { withSessionScope } from '../../src/core/session-context.ts';
import {
    getSessionOwnershipGeneration,
    isCurrentSessionOwner,
    resetSessionOwnershipGenerationForTest,
} from '../../src/agent/session-persistence.ts';

// 073 §2.2a — the helper that narrows a reset to its own scope is not enough on its own.
// clearSessionState() compacts first, and that compact bumps the GLOBAL generation when
// it is given no scope, which happens before the helper ever runs. Testing the helper in
// isolation cannot see that; these go through the exported reset entry points, which is
// what every caller actually reaches.

afterEach(() => {
    settings.multiSession.enabled = false;
    db.prepare("UPDATE session SET session_id = NULL WHERE id = 'default'").run();
    resetSessionOwnershipGenerationForTest();
});

test('a full reset in one session leaves another session able to save its turn', async () => {
    resetSessionOwnershipGenerationForTest();
    settings.multiSession.enabled = true;

    // B is mid-turn: it captured its ownership token when it started.
    const bToken = getSessionOwnershipGeneration('local:b');

    await withSessionScope({ scope: 'local:a', chatSessionId: 'a' }, () => clearSessionState());

    assert.equal(isCurrentSessionOwner(bToken, 'local:b'), true,
        'B must still own its run after A resets — otherwise B silently discards what it just produced');
});

test('a full reset still invalidates the session that asked for it', async () => {
    resetSessionOwnershipGenerationForTest();
    settings.multiSession.enabled = true;

    const aToken = getSessionOwnershipGeneration('local:a');
    await withSessionScope({ scope: 'local:a', chatSessionId: 'a' }, () => clearSessionState());

    assert.equal(isCurrentSessionOwner(aToken, 'local:a'), false);
});

// A reset that reaches the server without a session behind it is instance-wide, and
// there is nothing narrower to invalidate.
test('a full reset with no session context invalidates every session', async () => {
    resetSessionOwnershipGenerationForTest();
    const bToken = getSessionOwnershipGeneration('local:b');

    await clearSessionState();

    assert.equal(isCurrentSessionOwner(bToken, 'local:b'), false);
});

test('a soft reset in one session leaves another session able to save its turn', () => {
    resetSessionOwnershipGenerationForTest();
    settings.multiSession.enabled = true;

    const bToken = getSessionOwnershipGeneration('local:b');
    withSessionScope({ scope: 'local:a', chatSessionId: 'a' }, () => resetSessionOnly());

    assert.equal(isCurrentSessionOwner(bToken, 'local:b'), true);
});
