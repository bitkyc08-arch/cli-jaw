import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.ts';
import { settings } from '../../src/core/config.ts';
import {
    createChatSession,
    forkChatSession,
    getActiveChatSession,
    getChatSessionRemoteKey,
    setActiveChatSession,
} from '../../src/core/chat-sessions.ts';
import { withSessionScope } from '../../src/core/session-context.ts';
import { isRemoteBindingScope } from '../../src/orchestrator/scope.ts';

afterEach(() => {
    db.prepare("DELETE FROM remote_session_bindings WHERE chat_session_id LIKE '%'").run();
    db.prepare("DELETE FROM chat_sessions WHERE label LIKE 'nav-cmd%'").run();
    db.prepare("UPDATE session SET active_chat_session = 'default' WHERE id = 'default'").run();
    settings.multiSession.enabled = false;
});

// 072 §1.2a — "not default" used to mean "remote", because remote binding keys were the
// only non-default scopes. Local session scopes broke that assumption, and a /switch run
// inside a tab's own scope would bind that scope to the target instead of switching.

test('a remote binding scope is the only kind that binds', () => {
    assert.equal(isRemoteBindingScope('jaw:slack:channel:C1'), true);
    assert.equal(isRemoteBindingScope('local:sess-2'), false);
    assert.equal(isRemoteBindingScope('default'), false);
    assert.equal(isRemoteBindingScope(undefined), false);
});

test('switching from a local session scope actually switches, and binds nothing', () => {
    settings.multiSession.enabled = true;
    const from = createChatSession('nav-cmd-from');
    const to = createChatSession('nav-cmd-to');
    setActiveChatSession(from.id);

    withSessionScope({ scope: `local:${from.id}`, chatSessionId: from.id }, () => {
        setActiveChatSession(to.id);
    });

    assert.equal(getActiveChatSession(), to.id, 'the switch must take effect');
    assert.equal(getChatSessionRemoteKey(to.id), null, 'the target must not look remotely bound');
    assert.equal(getChatSessionRemoteKey(from.id), null);
});

test('switching from a remote scope still binds that conversation to the session', () => {
    settings.multiSession.enabled = true;
    const target = createChatSession('nav-cmd-remote');
    setActiveChatSession('default');

    withSessionScope({ scope: 'jaw:slack:channel:C1', chatSessionId: 'default' }, () => {
        setActiveChatSession(target.id);
    });

    assert.equal(getChatSessionRemoteKey(target.id), 'jaw:slack:channel:C1', 'a remote scope still binds');
    assert.equal(getActiveChatSession(), 'default', 'and it does not move the global pointer');
});

test('with multi-session off the ambient scope is ignored entirely', () => {
    const target = createChatSession('nav-cmd-gateoff');
    setActiveChatSession('default');
    settings.multiSession.enabled = false;

    withSessionScope({ scope: 'jaw:slack:channel:C1', chatSessionId: 'default' }, () => {
        setActiveChatSession(target.id);
    });

    assert.equal(getActiveChatSession(), target.id);
    assert.equal(getChatSessionRemoteKey(target.id), null);
});

// /switch is not the only command that reaches the setter. /new and /fork create a
// session and switch to it, so they carried the same defect.
test('creating a session from a local scope switches to it without binding', () => {
    settings.multiSession.enabled = true;
    const from = createChatSession('nav-cmd-create-from');
    setActiveChatSession(from.id);

    const created = withSessionScope(
        { scope: `local:${from.id}`, chatSessionId: from.id },
        () => createChatSession('nav-cmd-created'),
    );

    assert.equal(getActiveChatSession(), created.id, 'creating a session switches to it');
    assert.equal(getChatSessionRemoteKey(created.id), null, 'and it is not remotely bound');
});

test('forking from a local scope switches to the fork without binding', () => {
    settings.multiSession.enabled = true;
    const source = createChatSession('nav-cmd-fork-source');
    setActiveChatSession(source.id);

    const forked = withSessionScope(
        { scope: `local:${source.id}`, chatSessionId: source.id },
        () => forkChatSession(source.id),
    );

    assert.equal(getActiveChatSession(), forked.id, 'forking switches to the fork');
    assert.equal(getChatSessionRemoteKey(forked.id), null, 'and the fork is not remotely bound');
});
