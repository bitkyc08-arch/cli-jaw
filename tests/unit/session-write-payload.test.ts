import test from 'node:test';
import assert from 'node:assert/strict';
import { configureSessionView, withCurrentSessionBody } from '../../public/js/features/session-hub.ts';

// 072 §1.1 — a tab on /:seq must name the session it is viewing on every write, or
// the message lands on whatever session is globally active instead.

type Session = Parameters<typeof configureSessionView>[0]['sessions'][number];

function session(overrides: Partial<Session> & { id: string; seq: number }): Session {
    return {
        label: null,
        source: 'local',
        remoteKey: null,
        ...overrides,
    } as Session;
}

function list(active: string, sessions: Session[]) {
    return { active, sessions } as Parameters<typeof configureSessionView>[0];
}

test('a tab on a session route names that session even when another one is active', () => {
    configureSessionView(
        list('sess-1', [session({ id: 'sess-1', seq: 1 }), session({ id: 'sess-2', seq: 2 })]),
        '/2',
    );
    assert.deepEqual(withCurrentSessionBody({ prompt: 'hello' }), { prompt: 'hello', sessionId: 'sess-2' });
});

test('the hub sends no session so the server keeps using the active one', () => {
    configureSessionView(list('sess-1', [session({ id: 'sess-1', seq: 1 })]), '/');
    assert.deepEqual(withCurrentSessionBody({ prompt: 'hello' }), { prompt: 'hello' });
});

// A build without the navigation fields is an older server; sending a session id it
// does not understand would be worse than sending nothing.
test('an older server without navigation fields gets no session id', () => {
    const legacy = { active: 'sess-1', sessions: [{ id: 'sess-1', seq: 1, label: null }] };
    configureSessionView(legacy as Parameters<typeof configureSessionView>[0], '/2');
    assert.deepEqual(withCurrentSessionBody({ prompt: 'hello' }), { prompt: 'hello' });
});

test('a stop with no other fields still carries the session on a session route', () => {
    configureSessionView(
        list('sess-1', [session({ id: 'sess-1', seq: 1 }), session({ id: 'sess-2', seq: 2 })]),
        '/2',
    );
    assert.deepEqual(withCurrentSessionBody({}), { sessionId: 'sess-2' });

    // Off a session route the body stays empty, which the server reads as "stop
    // everything" — the behaviour the single-session view has always had.
    configureSessionView(list('sess-1', [session({ id: 'sess-1', seq: 1 })]), '/');
    assert.deepEqual(withCurrentSessionBody({}), {});
});
