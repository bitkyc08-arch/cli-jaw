// The CLI and model belong to the instance, not to a session, and the instance web
// owns them (devlog 074). These tests drive the paths that could quietly move that
// shared choice from somewhere else.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { db, getSession, updateSession } from '../../src/core/db.ts';
import { setActiveChatSession } from '../../src/core/chat-sessions.ts';
import {
    clearMainSessionState,
    resetSessionPreservingHistory,
    syncMainSessionToSettings,
    writeMainSessionRow,
} from '../../src/core/main-session.ts';

type SessionRow = {
    active_cli?: string | null;
    model?: string | null;
    session_id?: string | null;
};

const readRow = () => (getSession() ?? {}) as SessionRow;

function seedRow(cli: string, model: string, sessionId: string | null = 'seeded-thread'): void {
    updateSession.run(cli, sessionId, model, 'auto', '~', 'medium');
}

function ensureSession(id: string): void {
    db.prepare('INSERT OR IGNORE INTO chat_sessions (id, seq) VALUES (?, ?)')
        .run(id, id === 'default' ? 0 : 91);
    if (id !== 'default') {
        db.prepare(
            'INSERT OR IGNORE INTO remote_session_bindings (remote_key, chat_session_id) VALUES (?, ?)',
        ).run('jaw:slack:channel:CSHARED', id);
    }
}

// ─── SR-6: a remote session's dead resume drops its own bucket, not the shared row ───

test('SR-7: clearing history from a non-default session leaves the shared runtime choice alone', () => {
    ensureSession('default');
    ensureSession('shared-runtime-remote');
    seedRow('codex-app', 'gpt-5.5');

    setActiveChatSession('shared-runtime-remote');
    try {
        clearMainSessionState();
    } finally {
        setActiveChatSession('default');
    }

    const row = readRow();
    assert.equal(row.active_cli, 'codex-app', 'the shared CLI survives a remote clear');
    assert.equal(row.model, 'gpt-5.5', 'the shared model survives a remote clear');
    assert.equal(row.session_id, 'seeded-thread', 'and so does the default thread');
});

test('SR-7b: clearing history from the default session still resets the shared row', () => {
    ensureSession('default');
    seedRow('codex-app', 'gpt-5.5');

    setActiveChatSession('default');
    clearMainSessionState();

    assert.equal(readRow().session_id, null, 'the owning session still clears the thread');
});

test('SR-7c: /reset from a non-default session does not clear the shared thread', () => {
    ensureSession('default');
    ensureSession('shared-runtime-remote');
    seedRow('codex-app', 'gpt-5.5');

    setActiveChatSession('shared-runtime-remote');
    try {
        resetSessionPreservingHistory();
    } finally {
        setActiveChatSession('default');
    }

    assert.equal(readRow().session_id, 'seeded-thread', 'a remote reset leaves the shared thread');
});

test('SR-7d: /reset from the default session clears the shared thread', () => {
    ensureSession('default');
    seedRow('codex-app', 'gpt-5.5');

    setActiveChatSession('default');
    resetSessionPreservingHistory();

    assert.equal(readRow().session_id, null);
});

// ─── SR-9/SR-10: instance-wide writers are NOT gated ───

test('SR-9: an instance-wide settings sync writes the shared row from any session', () => {
    ensureSession('default');
    ensureSession('shared-runtime-remote');
    seedRow('claude', 'stale-model');

    setActiveChatSession('shared-runtime-remote');
    try {
        syncMainSessionToSettings();
    } finally {
        setActiveChatSession('default');
    }

    assert.notEqual(readRow().model, 'stale-model',
        'a settings change speaks for the instance, so it writes even from a second tab');
});

test('SR-10: writeMainSessionRow writes by default and only skips when told to', () => {
    seedRow('claude', 'before');

    writeMainSessionRow({
        cli: 'codex-app', sessionId: 'after-thread', model: 'after',
        permissions: 'auto', workingDir: '~', effort: 'medium',
    });
    assert.equal(readRow().model, 'after', 'the default is to write');

    writeMainSessionRow({
        cli: 'gemini', sessionId: 'ignored', model: 'never',
        permissions: 'auto', workingDir: '~', effort: 'medium',
    }, false);
    assert.equal(readRow().model, 'after', 'a non-owning caller writes nothing');
});
