import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, insertMessage } from '../../src/core/db.ts';
import { harvestBootstrapSlots } from '../../src/core/compact.ts';
import { setActiveChatSession } from '../../src/core/chat-sessions.ts';
import { settings } from '../../src/core/config.ts';

// 073 §2.5a — a compact builds its bootstrap from a conversation, and which one has to
// be said out loud. Reading the globally active session is right only while the
// async-local context that sets it survives, and a bootstrap built from the wrong
// conversation is handed to the next turn as if it were its own history.

const WD = '/tmp/harvest-binding';

function seed(sessionId: string, text: string): void {
    db.prepare("INSERT OR IGNORE INTO chat_sessions (id, label, created_at) VALUES (?, ?, ?)")
        .run(sessionId, `harvest-${sessionId}`, Date.now());
    insertMessage.run('user', text, 'web', '', WD, sessionId);
    insertMessage.run('assistant', `answer about ${text}`, 'claude', 'default', WD, sessionId);
}

afterEach(() => {
    db.prepare("DELETE FROM messages WHERE working_dir = ?").run(WD);
    db.prepare("DELETE FROM chat_sessions WHERE label LIKE 'harvest-%'").run();
    db.prepare("UPDATE session SET active_chat_session = 'default' WHERE id = 'default'").run();
    settings.multiSession.enabled = false;
});

test('the harvest reads the session it was told to, not the active one', () => {
    settings.multiSession.enabled = true;
    seed('harv-a', 'peregrine falcon migration');
    seed('harv-b', 'sourdough hydration ratio');
    setActiveChatSession('harv-a');

    const slots = harvestBootstrapSlots({
        workingDir: WD, instructions: '', chatSessionId: 'harv-b',
    });
    const body = `${slots.goal}\n${slots.recent_turns}`;

    assert.match(body, /sourdough/, "B's compact must carry B's conversation");
    assert.doesNotMatch(body, /peregrine/, "and must not carry A's");
});

// Callers that predate the argument keep working: no session named means the active one,
// which is what every one of them relied on.
test('the harvest falls back to the active session when none is named', () => {
    settings.multiSession.enabled = true;
    seed('harv-a', 'peregrine falcon migration');
    setActiveChatSession('harv-a');

    const slots = harvestBootstrapSlots({ workingDir: WD, instructions: '' });

    assert.match(`${slots.goal}\n${slots.recent_turns}`, /peregrine/);
});
