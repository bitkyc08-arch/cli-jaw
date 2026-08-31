// Where a mention-watch answer RUNS. Two separate decisions that an earlier
// version conflated: the chat session (whose history the turn reads and writes)
// and the execution scope (which lane runs it, and therefore whether an inbound
// message can steer it).
//
// Driven through the real exported helpers against the isolated test home, because
// the failure this guards against is a metadata value, and a source-regex test
// would pass while the value was wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mentionThreadPlacement, mentionThreadYield } from '../../src/memory/heartbeat.ts';
import type { MentionHit } from '../../src/slack/mention-watch.ts';
import { settings } from '../../src/core/config.ts';
import { getRemoteBoundSessionId } from '../../src/core/chat-sessions.ts';

const CHANNEL = 'C0BMYE33J0P';
const PARENT = '1788132495.567709';

function hit(overrides: Partial<MentionHit> = {}): MentionHit {
    return {
        channelId: CHANNEL,
        ts: '1788132532.971819',
        threadTs: PARENT,
        authorId: 'U08PYEQACDN',
        text: 'mention body',
        ...overrides,
    };
}

/** Run with the per-conversation session gate in a known state, then restore it.
 *  The gate is read from live settings, so a test that left it flipped would
 *  change the meaning of every later test in this process. */
function withGate<T>(enabled: boolean, run: () => T): T {
    const previous = settings["multiSession"];
    settings["multiSession"] = enabled
        ? { enabled: true, channels: { slack: true } }
        : { enabled: false };
    try {
        return run();
    } finally {
        if (previous === undefined) delete settings["multiSession"];
        else settings["multiSession"] = previous;
    }
}

test('the answer scope is never the thread scope an inbound message would use', () => {
    withGate(true, () => {
        const placement = mentionThreadPlacement(hit(), 'mint');
        // The inbound path runs in the bare remote key. Sharing it is what let a
        // later human message be steered into this background turn.
        assert.notEqual(placement.scope, placement.remoteKey);
        assert.ok(placement.scope.endsWith(placement.remoteKey));
        assert.ok(placement.scope.startsWith('mention-watch:'));
    });
});

test('the answer is bound to the session of the thread that carried the mention', () => {
    withGate(true, () => {
        const placement = mentionThreadPlacement(hit(), 'mint');
        assert.notEqual(placement.chatSessionId, 'default');
        // Same thread, same session: a second mention in it continues the same
        // conversation rather than starting a parallel one.
        assert.equal(mentionThreadPlacement(hit({ ts: '1788132999.000100' }), 'mint').chatSessionId, placement.chatSessionId);
        // A reply is addressed to the thread PARENT, so two messages inside one
        // thread must not produce two sessions.
        assert.ok(placement.remoteKey.includes(PARENT));
    });
});

test('a lookup does not mint a session for a thread that never gets answered', () => {
    withGate(true, () => {
        const unanswered = hit({ threadTs: '1788100000.000100' });
        const placement = mentionThreadPlacement(unanswered, 'lookup');
        assert.equal(placement.chatSessionId, 'default');
        assert.equal(getRemoteBoundSessionId(placement.remoteKey), null);
    });
});

test('with the gate off the shared session is used but the scope stays separate', () => {
    withGate(false, () => {
        const placement = mentionThreadPlacement(hit(), 'mint');
        assert.equal(placement.chatSessionId, 'default');
        assert.equal(placement.scope, 'mention-watch:' + placement.remoteKey);
        assert.notEqual(placement.scope, 'default');
    });
});

test('an idle thread mid-PABCD is left alone', () => {
    withGate(true, () => {
        // Nothing is running, but the thread is in P. Answering into it would let
        // the pipeline save this background reply as that thread's plan.
        const yielded = mentionThreadYield(hit(), { state: () => 'P', sessionWork: () => false, lanePending: () => false });
        assert.equal(yielded, 'yielded');
    });
});

test('a turn in flight for that thread outranks the mention', () => {
    withGate(true, () => {
        mentionThreadPlacement(hit(), 'mint');
        const yielded = mentionThreadYield(hit(), { state: () => 'IDLE', sessionWork: () => true, lanePending: () => false });
        assert.equal(yielded, 'yielded');
    });
});

test('a pending lane yields instead of queueing behind it', () => {
    withGate(true, () => {
        // Checked, never awaited: a lane wait is unbounded and the whole heartbeat
        // is held across this tick.
        const yielded = mentionThreadYield(hit(), { state: () => 'IDLE', sessionWork: () => false, lanePending: () => true });
        assert.equal(yielded, 'yielded');
    });
});

test('an idle, unoccupied thread is answered', () => {
    withGate(true, () => {
        const proceed = mentionThreadYield(hit(), { state: () => 'IDLE', sessionWork: () => false, lanePending: () => false });
        assert.equal(proceed, null);
    });
});

test('work in an unrelated session does not block this thread', () => {
    withGate(true, () => {
        const placement = mentionThreadPlacement(hit(), 'mint');
        const seen: string[] = [];
        const proceed = mentionThreadYield(hit(), {
            state: () => 'IDLE',
            sessionWork: (sessionId) => { seen.push(sessionId); return false; },
            lanePending: () => false,
        });
        assert.equal(proceed, null);
        // The probe must be asked about THIS thread's session, not the shared one.
        assert.deepEqual(seen, [placement.chatSessionId]);
    });
});

