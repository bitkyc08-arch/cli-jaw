import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, getSessionBucket, upsertSessionBucket } from '../../src/core/db.ts';
import { autoCompactRefresh } from '../../src/core/compact.ts';
import { compactHandler } from '../../src/cli/compact.ts';
import { settings } from '../../src/core/config.ts';
import { createChatSession, setActiveChatSession } from '../../src/core/chat-sessions.ts';
import type { CliCommandContext } from '../../src/cli/command-context.ts';

// 072 §1.2b — a `local:` scope shares the default session's bucket and singleton row on
// every runtime whose bucket key has no scope in it. A compact triggered by that scope
// must not throw away the conversation the default session is still using.

function defaultSessionId(): string | null {
    const row = db.prepare("SELECT session_id FROM session WHERE id = 'default'").get() as { session_id?: string } | undefined;
    return row?.session_id ?? null;
}

function seedSharedState(): void {
    upsertSessionBucket.run('claude', 'vendor-thread-of-default', 'default', null, 0);
    db.prepare("UPDATE session SET session_id = 'vendor-thread-of-default', active_cli = 'claude' WHERE id = 'default'").run();
}

afterEach(() => {
    db.prepare("DELETE FROM session_buckets WHERE bucket = 'claude'").run();
    db.prepare("DELETE FROM session_buckets WHERE bucket = ?").run(settings["cli"] || 'claude');
    db.prepare("UPDATE session SET session_id = NULL WHERE id = 'default'").run();
    db.prepare("DELETE FROM chat_sessions WHERE label LIKE 'compact-iso%'").run();
    db.prepare("UPDATE session SET active_chat_session = 'default' WHERE id = 'default'").run();
    db.prepare("DELETE FROM messages WHERE content LIKE '%compact%' AND session_id LIKE '%'").run();
    settings.multiSession.enabled = false;
});

function compactCtx(): CliCommandContext {
    return {
        interface: 'web',
        locale: 'en',
        getSettings: () => settings,
        getSession: () => db.prepare("SELECT * FROM session WHERE id = 'default'").get(),
        getRuntime: () => ({ activeAgent: false }),
    } as unknown as CliCommandContext;
}

// The /compact command writes its marker and bootstrap into the session the user is
// looking at. If it cleared the shared bucket and singleton row as well, the visible
// half would land on one session and the destructive half on another.
test('an explicit compact from a local session does not clear the default session state', async () => {
    settings.multiSession.enabled = true;
    seedSharedState();
    const local = createChatSession('compact-iso-local');
    setActiveChatSession(local.id);
    db.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', 'something to compact', ?)").run(local.id);

    const result = await compactHandler([], compactCtx());
    assert.equal(result.ok, true, `compact should run: ${result.text}`);

    const bucket = getSessionBucket.get('claude') as { session_id?: string } | undefined;
    assert.equal(bucket?.session_id, 'vendor-thread-of-default', 'the default session bucket must survive');
    assert.equal(defaultSessionId(), 'vendor-thread-of-default', 'the default session row must survive');
});

test('an explicit compact from the default session still resets its own state', async () => {
    settings.multiSession.enabled = true;
    seedSharedState();
    setActiveChatSession('default');
    db.prepare("INSERT INTO messages (role, content, session_id) VALUES ('user', 'something to compact', 'default')").run();

    // The command resolves its bucket from the configured CLI, so pin it to the one
    // seedSharedState() wrote rather than depending on this environment's default.
    const previousCli = settings["cli"];
    settings["cli"] = 'claude';
    let result;
    try {
        result = await compactHandler([], compactCtx());
    } finally {
        settings["cli"] = previousCli;
    }
    assert.equal(result.ok, true, `compact should run: ${result.text}`);

    assert.equal(getSessionBucket.get('claude'), undefined, 'its own bucket is cleared');
    assert.equal(defaultSessionId(), null, 'its own session row is cleared');
});

test('a compact in a local scope leaves the shared bucket and session row alone', async () => {
    seedSharedState();

    await autoCompactRefresh({
        workDir: '/tmp', instructions: '', cli: 'claude', model: 'default',
        scopeKey: 'local:sess-2',
    });

    const bucket = getSessionBucket.get('claude') as { session_id?: string } | undefined;
    assert.equal(bucket?.session_id, 'vendor-thread-of-default', 'the shared bucket must survive');
    assert.equal(defaultSessionId(), 'vendor-thread-of-default', 'the shared session row must survive');
});

test('a compact in the default scope still clears the shared state', async () => {
    seedSharedState();

    await autoCompactRefresh({
        workDir: '/tmp', instructions: '', cli: 'claude', model: 'default',
        scopeKey: 'default',
    });

    assert.equal(getSessionBucket.get('claude'), undefined, 'its own bucket must be cleared');
    assert.equal(defaultSessionId(), null, 'its own session row must be cleared');
});

// codex-app multiplex puts the scope inside the bucket key, so it owns real per-scope
// state and a compact there is a normal refresh of that scope's own bucket.
test('a local scope with its own scoped bucket still compacts that bucket', async () => {
    seedSharedState();
    upsertSessionBucket.run('codex-app:local:sess-2', 'thread-2', 'gpt-5.5', null, 0);

    await autoCompactRefresh({
        workDir: '/tmp', instructions: '', cli: 'codex-app', model: 'gpt-5.5',
        scopeKey: 'local:sess-2', sessionBucket: 'codex-app:local:sess-2',
    });

    assert.equal(getSessionBucket.get('codex-app:local:sess-2'), undefined, 'its own scoped bucket is cleared');
    const shared = getSessionBucket.get('claude') as { session_id?: string } | undefined;
    assert.equal(shared?.session_id, 'vendor-thread-of-default', 'another runtime bucket is untouched');
});
