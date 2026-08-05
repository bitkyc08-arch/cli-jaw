import test from 'node:test';
import assert from 'node:assert/strict';
import { configureSessionView, currentEventScope, withCurrentSessionBody } from '../../public/js/features/session-hub.ts';

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

// The client mirrors the server's scope rule but does NOT read the multi-session gate.
// It does not need to, and the reason is worth pinning because it is a coupling between
// two files: with the gate off the server omits the navigation fields from the session
// list, which turns the session view off, which makes both the scope and the write
// payload empty. If that field ever became unconditional, a tab would subscribe to
// `local:<id>` while the server published everything under `default`, and the tab would
// go silent while looking perfectly healthy.
test('a session list without navigation fields yields no scope and no session payload', () => {
    const gateOff = {
        active: 'sess-1',
        sessions: [{ id: 'sess-1', seq: 1, label: null }, { id: 'sess-2', seq: 2, label: null }],
    } as Parameters<typeof configureSessionView>[0];

    configureSessionView(gateOff, '/2');
    assert.equal(currentEventScope(), null, 'an unfiltered connection receives everything, as before');
    assert.deepEqual(withCurrentSessionBody({ prompt: 'hello' }), { prompt: 'hello' });
});

// And with the fields present the two agree on every shape the server can produce.
test('the client scope mirror agrees with the server rule for default, local and remote', () => {
    const sessions = [
        session({ id: 'default', seq: 1 }),
        session({ id: 'sess-local', seq: 2 }),
        session({ id: 'sess-remote', seq: 3, remoteKey: 'jaw:slack:channel:C1' }),
    ];

    configureSessionView(list('default', sessions), '/1');
    assert.equal(currentEventScope(), 'default');

    configureSessionView(list('default', sessions), '/2');
    assert.equal(currentEventScope(), 'local:sess-local');

    configureSessionView(list('default', sessions), '/3');
    assert.equal(currentEventScope(), 'jaw:slack:channel:C1');

    configureSessionView(list('default', sessions), '/');
    assert.equal(currentEventScope(), null, 'the hub stays unfiltered');
});
