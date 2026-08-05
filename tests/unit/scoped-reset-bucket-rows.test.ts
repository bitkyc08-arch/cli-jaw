import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, upsertSessionBucket } from '../../src/core/db.ts';
import { settings } from '../../src/core/config.ts';
import { clearSessionState } from '../../src/core/session-ops.ts';
import { withSessionScope } from '../../src/core/session-context.ts';

// 073 §2.2a — the mocked reset test cannot see whether the key it builds matches a row
// that exists. codex-app folds lane mode, model and effort into its bucket key, so a key
// rebuilt with those blank matches nothing and the vendor thread stays resumable after a
// reset that claimed to discard it. These go against the real table.

function buckets(): string[] {
    return (db.prepare('SELECT bucket FROM session_buckets ORDER BY bucket').all() as Array<{ bucket: string }>)
        .map(row => row.bucket);
}

function seedCodexAppLanes(): void {
    db.prepare('DELETE FROM session_buckets').run();
    // The shapes a real multiplex run produces: fallback folds model and effort in,
    // native stops at the scope. Plus the bare legacy name a pre-073 session resumes from.
    upsertSessionBucket.run('codex-app', 'thread-legacy', 'default', null, 0);
    upsertSessionBucket.run('codex-app:default', 'thread-default-native', 'default', null, 0);
    upsertSessionBucket.run('codex-app:default:gpt-5.5:high', 'thread-default-fallback', 'default', null, 0);
    upsertSessionBucket.run('codex-app:local:a', 'thread-a-native', 'default', null, 0);
    upsertSessionBucket.run('codex-app:local:a:gpt-5.5:high', 'thread-a-fallback', 'default', null, 0);
    upsertSessionBucket.run('codex-app:local:ab', 'thread-ab', 'default', null, 0);
    upsertSessionBucket.run('codex-app:jaw:slack:T1:C1', 'thread-slack', 'default', null, 0);
}

afterEach(() => {
    db.prepare('DELETE FROM session_buckets').run();
    settings.multiSession.enabled = false;
    settings.cli = 'claude';
});

test('a scoped reset removes every bucket shape of its own scope', async () => {
    settings.multiSession.enabled = true;
    settings.cli = 'codex-app';
    seedCodexAppLanes();

    await withSessionScope({ scope: 'local:a', chatSessionId: 'a' }, () => clearSessionState());

    const left = buckets();
    assert.ok(!left.includes('codex-app:local:a'), 'the native-mode row goes');
    assert.ok(!left.includes('codex-app:local:a:gpt-5.5:high'),
        'and so does the fallback row, whose effort this path cannot know');
    assert.ok(left.includes('codex-app:local:ab'),
        'a scope whose name merely starts the same keeps its conversation');
    assert.ok(left.includes('codex-app:jaw:slack:T1:C1'), 'the Slack session is untouched');
    assert.ok(left.includes('codex-app'), 'and so is the default session');
});

// The audit's case: treating the default scope as "no session" let a reset of the default
// chat take every other scope's lanes with it.
test('a reset of the default session leaves the other scopes alone', async () => {
    settings.multiSession.enabled = true;
    settings.cli = 'codex-app';
    seedCodexAppLanes();

    await withSessionScope({ scope: 'default', chatSessionId: 'default' }, () => clearSessionState());

    const left = buckets();
    assert.ok(!left.includes('codex-app'), 'the legacy name belongs to the default session');
    assert.ok(!left.includes('codex-app:default'), 'as do its scoped rows');
    assert.ok(!left.includes('codex-app:default:gpt-5.5:high'));
    assert.deepEqual(
        left,
        ['codex-app:jaw:slack:T1:C1', 'codex-app:local:a', 'codex-app:local:a:gpt-5.5:high', 'codex-app:local:ab'],
        'every other scope keeps what it was using',
    );
});

// A reset that arrives with no session behind it is instance-wide and still sweeps.
test('an unscoped reset still clears every lane', async () => {
    settings.multiSession.enabled = true;
    settings.cli = 'codex-app';
    seedCodexAppLanes();

    await clearSessionState();

    assert.deepEqual(buckets(), []);
});

// A remote binding key is percent-encoded, so a Slack channel named with a space or an
// underscore puts a LIKE wildcard straight into the scope. Unescaped, one channel's reset
// matched every other channel's bucket and deleted conversations nobody touched.
test('a scope carrying LIKE wildcards deletes only its own rows', async () => {
    settings.multiSession.enabled = true;
    settings.cli = 'codex-app';
    db.prepare('DELETE FROM session_buckets').run();
    // buildRemoteBindingKey percent-encodes, so "C 1" becomes "C%201".
    upsertSessionBucket.run('codex-app:jaw:slack:T1:C%201', 'thread-encoded', 'default', null, 0);
    upsertSessionBucket.run('codex-app:jaw:slack:T1:C%201:gpt-5.5:high', 'thread-encoded-lane', 'default', null, 0);
    upsertSessionBucket.run('codex-app:jaw:slack:T1:CZZZZ', 'thread-other-channel', 'default', null, 0);
    upsertSessionBucket.run('codex-app:jaw:slack:T1:C_1', 'thread-underscore', 'default', null, 0);

    await withSessionScope(
        { scope: 'jaw:slack:T1:C%201', chatSessionId: 'slack-1' },
        () => clearSessionState(),
    );

    assert.deepEqual(
        buckets(),
        ['codex-app:jaw:slack:T1:CZZZZ', 'codex-app:jaw:slack:T1:C_1'],
        'the other channels keep their conversations',
    );
});

test('an underscore in a scope is not a single-character wildcard', async () => {
    settings.multiSession.enabled = true;
    settings.cli = 'codex-app';
    db.prepare('DELETE FROM session_buckets').run();
    upsertSessionBucket.run('codex-app:local:a_b:lane', 'thread-underscore-lane', 'default', null, 0);
    upsertSessionBucket.run('codex-app:local:axb:lane', 'thread-lookalike', 'default', null, 0);

    await withSessionScope({ scope: 'local:a_b', chatSessionId: 'ab' }, () => clearSessionState());

    assert.deepEqual(buckets(), ['codex-app:local:axb:lane']);
});
