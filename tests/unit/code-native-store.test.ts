import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
    CodeStore, CodeStoreError, toCodeSessionInfo,
    type CodeSessionCreate, type CodeSessionRecord, type CodeStoreOwner,
} from '../../src/code-mode/store.js';
import type { CodeItem, CodeSessionInfo } from '../../src/code-mode/wire.js';

const capabilities = {
    resume: true, interrupt: true, permissions: true, setModelMidSession: false,
    efforts: ['low', 'high'], permissionModes: ['ask', 'auto'] as Array<'ask' | 'auto'>,
};
const creation: CodeSessionCreate = {
    sessionId: 'session-a', provider: 'claude', cwd: '/workspace/a', title: null,
    model: 'model-a', effort: 'high', permissionMode: 'ask', capabilities,
};
const dtoKeys = [
    'sessionId', 'provider', 'cwd', 'title', 'model', 'effort', 'permissionMode', 'status',
    'turnId', 'archivedAt', 'error', 'resume', 'capabilities', 'epoch', 'sequence', 'revision',
    'createdAt', 'lastUsedAt',
].sort();

function fixture(t: { after(fn: () => void): void }) {
    const db = new Database(':memory:');
    t.after(() => db.close());
    let id = 0;
    const store = new CodeStore(db, { now: () => 1234, newId: () => `turn-${++id}` });
    store.create(creation);
    return { db, store };
}

function admit(store: CodeStore, key = 'key-a', sessionId = 'session-a', text = 'hello') {
    return store.admitTurn({ sessionId, clientTurnKey: key, text });
}

function owner(session: CodeSessionInfo): CodeStoreOwner {
    return { sessionId: session.sessionId, turnId: session.turnId, epoch: session.epoch };
}

function message(turnId: string, itemId = 'answer', text = 'retained answer'): CodeItem {
    return { itemId, turnId, kind: 'assistant_message', status: 'running', text, createdAt: 1234, updatedAt: 1234 };
}

function expectError(fn: () => unknown, code: string, statusCode = 409) {
    assert.throws(fn, (error: unknown) => error instanceof CodeStoreError && error.code === code && error.statusCode === statusCode);
}

test('constructor adds only Code schema and repeated initialization preserves records', t => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec("CREATE TABLE messages (content TEXT); INSERT INTO messages VALUES ('existing history')");
    const store = new CodeStore(db);
    const created = store.create(creation);
    const reopened = new CodeStore(db);
    assert.deepEqual(reopened.read(creation.sessionId!), created.session);
    assert.deepEqual(db.prepare('SELECT content FROM messages').all(), [{ content: 'existing history' }]);
    assert.deepEqual(reopened.snapshot('session-a').items, []);
    assert.deepEqual(reopened.readEvents('session-a').events, created.events);
});

test('full row mapping includes every field and public surfaces exclude private native metadata', t => {
    const { store, db } = fixture(t);
    db.prepare(`UPDATE code_sessions SET title = ?, model = ?, effort = ?, permission_mode = ?,
        status = ?, active_turn_id = ?, archived_at = ?, error_json = ?, native_cursor = ?, native_started = ?,
        native_policy_json = ?, epoch = ?, revision = ?, created_at = ?, last_used_at = ? WHERE session_id = ?`)
        .run('Stored title', 'stored-model', 'low', 'auto', 'suspended', null, null,
            JSON.stringify({ code: 'stored_error', message: 'diagnostic', at: 56, recoverable: true, nativeCursor: 'nested-private' }),
            'private-native-id', 1, JSON.stringify({ model: 'old-model', effort: null, permissionMode: 'ask' }),
            7, 8, 111, 222, 'session-a');
    const expected: CodeSessionInfo = {
        sessionId: 'session-a', provider: 'claude', cwd: '/workspace/a', title: 'Stored title',
        model: 'stored-model', effort: 'low', permissionMode: 'auto', status: 'suspended', turnId: null,
        archivedAt: null, error: { code: 'stored_error', message: 'diagnostic', at: 56, recoverable: true },
        resume: { available: true, reason: null }, capabilities, epoch: 7, sequence: 1, revision: 8,
        createdAt: 111, lastUsedAt: 222,
    };
    assert.deepEqual(store.read('session-a'), expected);
    const record = store.readRecord('session-a')!;
    assert.equal(record.nativeCursor, 'private-native-id');
    assert.equal(record.nativeStarted, true);
    assert.deepEqual(record.nativePolicy, { model: 'old-model', effort: null, permissionMode: 'ask' });
    assert.deepEqual(store.list(), [expected]);
    assert.deepEqual(store.snapshot('session-a').session, expected);
    const patched = store.patchSession('session-a', { expectedRevision: 8, title: 'Renamed' });
    assert.deepEqual(Object.keys(patched.session).sort(), dtoKeys);
    for (const value of [store.read('session-a'), store.list(), store.snapshot('session-a'), patched, store.readEvents('session-a')]) {
        assert.doesNotMatch(JSON.stringify(value), /nativeCursor|nativeStarted|nativePolicy|private-native-id|nested-private|old-model/);
    }
});

test('public mapper also strips future private properties nested in capabilities', () => {
    const record: CodeSessionRecord = {
        ...creation, sessionId: 's', title: null, status: 'idle', turnId: null,
        archivedAt: null, error: null, epoch: 0, sequence: 0, revision: 0, createdAt: 1, lastUsedAt: 2,
        nativeCursor: 'secret', nativeStarted: true, nativePolicy: null,
    };
    const extra = { ...record, privateFutureField: 'private', capabilities: { ...capabilities, nativeCursor: 'hidden' } };
    assert.deepEqual(Object.keys(toCodeSessionInfo(extra)).sort(), dtoKeys);
    assert.doesNotMatch(JSON.stringify(toCodeSessionInfo(extra)), /private|secret|hidden|nativeCursor/);
});

test('admission commits turn, complete user text, start item, receipt and consecutive events before return', t => {
    const { store, db } = fixture(t);
    const text = '  exact prompt\n' + 'x'.repeat(4000);
    const result = admit(store, 'key-a', 'session-a', text);
    assert.equal(db.inTransaction, false);
    assert.equal(result.duplicate, false);
    assert.deepEqual(result.receipt, { turnId: 'turn-1', clientTurnKey: 'key-a', sequence: 4, status: 'accepted' });
    assert.deepEqual(result.events.map(event => event.sequence), [2, 3, 4]);
    assert.equal(result.session.status, 'starting');
    assert.equal(result.session.epoch, 1);
    assert.equal(store.snapshot('session-a').items[0]?.text, text);
    assert.deepEqual(store.readEvents('session-a', 1).events, result.events);
    assert.deepEqual(store.readTurn('session-a', 'key-a'), result.receipt);
    assert.equal(store.readRecord('session-a')?.nativeStarted, false);
    assert.deepEqual(store.readRecord('session-a')?.nativePolicy, { model: 'model-a', effort: 'high', permissionMode: 'ask' });
});

test('matching key wins over busy; mismatching content and competing keys cannot alter admitted work', t => {
    const { store } = fixture(t);
    const first = admit(store);
    const duplicate = admit(store);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.receipt, first.receipt);
    assert.deepEqual(duplicate.events, []);
    expectError(() => admit(store, 'key-a', 'session-a', 'hello '), 'turn_key_conflict');
    expectError(() => admit(store, 'key-b'), 'session_busy');
    assert.equal(store.read('session-a')?.sequence, 4);
    assert.equal(store.readTurn('session-a', 'key-b'), null);
    assert.equal(store.snapshot('session-a').items.length, 2);
});

test('a second store instance observes the durable admission before any native open', t => {
    const { store, db } = fixture(t);
    const accepted = admit(store);
    const other = new CodeStore(db);
    assert.deepEqual(admit(other).receipt, accepted.receipt);
    expectError(() => admit(other, 'competing-key'), 'session_busy');
    assert.equal(other.read('session-a')?.status, 'starting');
    assert.equal(other.readRecord('session-a')?.nativeCursor, null);
});

test('session/client key uniqueness is enforced in SQLite and keys are independent across sessions', t => {
    const { store, db } = fixture(t);
    admit(store);
    store.create({ ...creation, sessionId: 'session-b' });
    assert.equal(admit(store, 'key-a', 'session-b').duplicate, false);
    assert.throws(() => db.prepare(`INSERT INTO code_turns
        (session_id, turn_id, client_turn_key, prompt_hash, status, accepted_sequence)
        VALUES ('session-a', 'another-turn', 'key-a', 'hash', 'accepted', 99)`).run(), /UNIQUE/);
});

test('failed admission rolls back all rows, watermark and key consumption', t => {
    const { store, db } = fixture(t);
    db.exec(`CREATE TRIGGER reject_code_start BEFORE INSERT ON code_events
        WHEN NEW.sequence = 3 BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`);
    assert.throws(() => admit(store), /injected event failure/);
    assert.equal(store.read('session-a')?.status, 'idle');
    assert.equal(store.read('session-a')?.sequence, 1);
    assert.equal(store.readTurn('session-a', 'key-a'), null);
    assert.deepEqual(store.snapshot('session-a').items, []);
    assert.equal(store.readEvents('session-a').events.length, 1);
    db.exec('DROP TRIGGER reject_code_start');
    assert.equal(admit(store).duplicate, false);
});

test('old tool updates retain firstSequence and first-appearance order while events advance', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    store.commitItem(current, { ...message(admitted.receipt.turnId, 'first', 'first value'), kind: 'tool_call', tool: { name: 'tool' } });
    store.commitItem(current, message(admitted.receipt.turnId, 'second', 'second value'));
    const longText = 'whole retained value '.repeat(2000);
    store.commitItem(current, { ...message(admitted.receipt.turnId, 'first', longText), kind: 'tool_call', tool: { name: 'tool', output: longText }, status: 'done' });
    const snapshot = store.snapshot('session-a');
    assert.deepEqual(snapshot.items.map(item => item.itemId), ['turn-1:user', 'turn-1:started', 'first', 'second']);
    assert.equal(snapshot.items[2]?.text, longText);
    assert.deepEqual(snapshot.items.map(item => item.firstSequence), [2, 3, 5, 6]);
    assert.equal(snapshot.sequence, 7);
    assert.deepEqual(store.readEvents('session-a', 4).events.map(event => event.sequence), [5, 6, 7]);
    assert.deepEqual(store.readEvents('session-a', 4).events.map(event => event.item?.firstSequence), [5, 6, 5]);
    assert.deepEqual(store.snapshot('session-a', { limit: 1 }).items.map(item => item.itemId), ['second']);
});

test('snapshot retains the newest 1000 items in ascending firstSequence order', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    for (let index = 0; index < 1005; index++) {
        store.commitItem(owner(admitted.session), message(admitted.receipt.turnId, `item-${index}`, `message ${index}`));
    }
    const snapshot = store.snapshot('session-a');
    assert.equal(snapshot.items.length, 1000);
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.items.map(item => item.itemId), Array.from({ length: 1000 }, (_, index) => `item-${index + 5}`));
    assert.deepEqual(snapshot.items.map(item => item.firstSequence), Array.from({ length: 1000 }, (_, index) => index + 10));
    assert.equal(snapshot.items.at(-1)?.text, 'message 1004');
    assert.equal(snapshot.sequence, 1009);
    assert.equal(snapshot.session.sequence, 1009);
});

test('caller firstSequence is ignored on insertion and update; projected row owns snapshot and replay order', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    const first = store.commitItem(current, { ...message(admitted.receipt.turnId), firstSequence: -999 });
    assert.equal(first.events[0]?.item?.firstSequence, 5);
    const update = store.commitItem(current, { ...message(admitted.receipt.turnId, 'answer', 'updated'), firstSequence: 999999 });
    assert.equal(update.events[0]?.sequence, 6);
    assert.equal(update.events[0]?.item?.firstSequence, 5);
    assert.deepEqual(db.prepare('SELECT first_sequence FROM code_items WHERE session_id = ? AND item_id = ?')
        .get('session-a', 'answer'), { first_sequence: 5 });
    // Old or inconsistent JSON metadata cannot override the retained relational identity.
    db.prepare(`UPDATE code_items SET item_json = json_set(item_json, '$.firstSequence', 999999)
        WHERE session_id = ? AND item_id = ?`).run('session-a', 'answer');
    db.prepare(`UPDATE code_events SET event_json = json_remove(event_json, '$.item.firstSequence')
        WHERE session_id = ? AND sequence = ?`).run('session-a', 5);
    assert.equal(store.snapshot('session-a').items.at(-1)?.firstSequence, 5);
    assert.deepEqual(store.readEvents('session-a', 4).events.map(event => event.item?.firstSequence), [5, 5]);
    assert.deepEqual(store.readEvents('session-a', 4).events.map(event => event.item?.text), ['retained answer', 'updated']);
});

test('item write failure rolls back projection and event sequence', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    db.exec(`CREATE TRIGGER reject_item BEFORE INSERT ON code_items
        WHEN NEW.item_id = 'answer' BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END`);
    assert.throws(() => store.commitItem(owner(admitted.session), message(admitted.receipt.turnId)), /injected projection failure/);
    assert.equal(store.read('session-a')?.sequence, 4);
    assert.equal(store.readEvents('session-a', 4).events.length, 0);
    assert.equal(store.snapshot('session-a').items.length, 2);
});

test('all item fields round-trip and retained events are detached from mutable input', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const input = {
        ...message(admitted.receipt.turnId), status: 'done' as const, phase: 'final' as const, text: '', clientTurnKey: 'key-a', parentItemId: 'parent',
        tool: { name: 'tool', input: '{"a":1}', detail: 'detail', output: 'result', nativeCursor: 'tool-private' },
        truncation: { storedChars: 10, sourceChars: 100, reason: 'field_limit', privatePolicy: 'hidden' },
        nativeCursor: 'item-private',
    };
    const expected: CodeItem = {
        itemId: 'answer', firstSequence: 5, turnId: admitted.receipt.turnId, kind: 'assistant_message', status: 'done', phase: 'final',
        text: '', clientTurnKey: 'key-a', parentItemId: 'parent', createdAt: 1234, updatedAt: 1234,
        tool: { name: 'tool', input: '{"a":1}', detail: 'detail', output: 'result' },
        truncation: { storedChars: 10, sourceChars: 100, reason: 'field_limit' },
    };
    const committed = store.commitItem(owner(admitted.session), input);
    input.tool.output = 'later mutation';
    input.text = 'later text';
    assert.deepEqual(committed.events[0]?.item, expected);
    assert.deepEqual(store.readEvents('session-a', 4).events[0]?.item, expected);
    assert.deepEqual(store.snapshot('session-a').items.at(-1), expected);
    assert.doesNotMatch(JSON.stringify(committed), /nativeCursor|privatePolicy|hidden|private/);
});

test('replay advances only to last returned sequence and bounded snapshot reports truncation', t => {
    const { store } = fixture(t);
    admit(store);
    const first = store.readEvents('session-a', 0, 2);
    assert.deepEqual([first.nextSequence, first.throughSequence, first.hasMore], [2, 4, true]);
    const next = store.readEvents('session-a', first.nextSequence, 2);
    assert.deepEqual(next.events.map(event => event.sequence), [3, 4]);
    assert.deepEqual([next.nextSequence, next.throughSequence, next.hasMore], [4, 4, false]);
    assert.deepEqual(store.readEvents('session-a', 4), { events: [], nextSequence: 4, throughSequence: 4, hasMore: false });
    const snapshot = store.snapshot('session-a', { limit: 1 });
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0]?.itemId, 'turn-1:started');
    assert.equal(snapshot.items[0]?.firstSequence, 3);
    assert.equal(snapshot.sequence, 4);
    assert.equal(snapshot.session.sequence, 4);
    expectError(() => store.readEvents('session-a', 5), 'invalid_sequence');
    expectError(() => store.readEvents('session-a', -1), 'invalid_sequence', 400);
});

test('event page size is capped at 500 even when a larger limit is requested', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    for (let index = 0; index < 500; index++) {
        store.commitItem(owner(admitted.session), message(admitted.receipt.turnId, 'answer', String(index)));
    }
    const page = store.readEvents('session-a', 0, 5000);
    assert.equal(page.events.length, 500);
    assert.equal(page.nextSequence, 500);
    assert.equal(page.throughSequence, 504);
    assert.equal(page.hasMore, true);
    assert.deepEqual(store.readEvents('session-a', page.nextSequence).events.map(event => event.sequence), [501, 502, 503, 504]);
});

test('permission mapping retains full public fields and rejects another owner before storage', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    const permission = {
        permissionId: 'p', sessionId: 'session-a', turnId: admitted.receipt.turnId, epoch: current.epoch,
        title: 'Allow tool', detail: 'Full detail', requestedAt: 4321, nativeCursor: 'hidden-permission',
        options: [{ optionId: 'yes', label: 'Allow once', kind: 'allow_once', nativeCursor: 'hidden-option' }],
    };
    const item: CodeItem = {
        itemId: 'permission', turnId: admitted.receipt.turnId, kind: 'permission_request', status: 'pending',
        permission, createdAt: 1234, updatedAt: 4321,
    };
    expectError(() => store.commitItem(current, { ...item, permission: { ...permission, epoch: current.epoch + 1 } }), 'stale_owner');
    expectError(() => store.commitItem(current, { ...item, permission: { ...permission, sessionId: 'other-session' } }), 'stale_owner');
    assert.equal(store.read('session-a')?.sequence, 4);
    const committed = store.commitItem(current, item);
    const expected = {
        permissionId: 'p', sessionId: 'session-a', turnId: admitted.receipt.turnId, epoch: current.epoch,
        title: 'Allow tool', detail: 'Full detail', requestedAt: 4321,
        options: [{ optionId: 'yes', label: 'Allow once', kind: 'allow_once' }],
    };
    assert.deepEqual(committed.events[0]?.item?.permission, expected);
    assert.deepEqual(store.snapshot('session-a').pendingPermissions, [expected]);
    assert.doesNotMatch(JSON.stringify(store.readEvents('session-a')), /nativeCursor|hidden-option|hidden-permission/);
});

test('metadata revision prevents lost edits; busy rename works and busy archive/policy fail', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const renamed = store.patchSession('session-a', { expectedRevision: 0, title: 'User title' });
    assert.equal(renamed.session.revision, 1);
    assert.equal(renamed.session.turnId, admitted.receipt.turnId);
    assert.equal(renamed.session.epoch, admitted.session.epoch);
    expectError(() => store.patchSession('session-a', { expectedRevision: 0, title: 'Stale title' }), 'revision_conflict');
    expectError(() => store.patchSession('session-a', { expectedRevision: 1, archived: true }), 'session_busy');
    expectError(() => store.patchSession('session-a', { expectedRevision: 1, model: 'other-model' }), 'session_busy');
    expectError(() => store.admitTurn({ sessionId: 'session-a', text: 'new', clientTurnKey: 'new', expectedRevision: 0 }), 'revision_conflict');
    assert.equal(store.read('session-a')?.title, 'User title');
    assert.equal(store.read('session-a')?.revision, 1);
});

test('terminal settlement is atomic and preserves accepted receipt sequence', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    store.setRuntimeState(owner(admitted.session), 'streaming');
    assert.equal(store.readTurn('session-a', 'key-a')?.status, 'running');
    db.exec(`CREATE TRIGGER reject_terminal BEFORE UPDATE ON code_turns
        WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END`);
    const before = store.snapshot('session-a');
    assert.throws(() => store.settleTurn(owner(admitted.session), { status: 'completed' }), /injected terminal failure/);
    assert.deepEqual(store.snapshot('session-a'), before);
    db.exec('DROP TRIGGER reject_terminal');
    const result = store.settleTurn(owner(admitted.session), { status: 'completed' });
    assert.equal(result.session.status, 'idle');
    assert.equal(result.session.turnId, null);
    assert.equal(result.receipt.status, 'completed');
    assert.equal(result.receipt.sequence, 4);
    const repeated = store.settleTurn(owner(admitted.session), { status: 'cancelled' });
    assert.equal(repeated.receipt.status, 'completed');
    assert.deepEqual(repeated.events, []);
    assert.deepEqual(admit(store).receipt, result.receipt);
    assert.equal(store.snapshot('session-a').items.filter(item => item.kind === 'turn_completed').length, 1);
});

test('old epoch/turn callbacks cannot mutate a newer turn or reuse another turn item identity', t => {
    const { store } = fixture(t);
    const first = admit(store);
    store.commitItem(owner(first.session), message(first.receipt.turnId));
    store.settleTurn(owner(first.session), { status: 'completed' });
    const next = admit(store, 'key-b');
    const before = store.snapshot('session-a');
    expectError(() => store.commitItem(owner(first.session), message(first.receipt.turnId)), 'stale_owner');
    expectError(() => store.writeNativeCursor(owner(first.session), 'late-cursor'), 'stale_owner');
    expectError(() => store.settleTurn(owner(first.session), { status: 'failed' }), 'stale_owner');
    expectError(() => store.setRuntimeState(owner(first.session), 'stopping'), 'stale_owner');
    expectError(() => store.commitItem(owner(next.session), message(next.receipt.turnId)), 'item_owner_conflict');
    assert.deepEqual(store.snapshot('session-a'), before);
});

test('only settlement can commit a terminal turn and unfinished tools are not reported as successful', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    expectError(() => store.commitItem(current, { ...message(admitted.receipt.turnId), kind: 'turn_completed', status: 'done' }), 'terminal_item_owned');
    store.commitItem(current, { ...message(admitted.receipt.turnId), kind: 'tool_call', tool: { name: 'unfinished' } });
    const settled = store.settleTurn(current, { status: 'completed' });
    assert.equal(settled.receipt.status, 'completed');
    assert.equal(store.snapshot('session-a').items.find(item => item.itemId === 'answer')?.status, 'cancelled');
    assert.equal(store.snapshot('session-a').items.filter(item => item.kind === 'turn_completed').length, 1);
});

test('archive is non-destructive, rejects sends and fences idle native callbacks', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    store.writeNativeCursor(owner(admitted.session), 'stored-cursor');
    const finished = store.settleTurn(owner(admitted.session), { status: 'completed' });
    const archived = store.patchSession('session-a', { expectedRevision: 0, archived: true });
    assert.equal(archived.session.archivedAt, 1234);
    assert.equal(archived.session.resume.reason, 'archived');
    assert.equal(store.readRecord('session-a')?.nativeCursor, 'stored-cursor');
    assert.equal(store.snapshot('session-a').items.length, 3);
    assert.equal(store.list({ archived: true }).length, 1);
    assert.equal(store.list({ archived: false }).length, 0);
    expectError(() => admit(store, 'key-b'), 'session_archived');
    expectError(() => store.writeNativeCursor(owner(finished.session), 'late'), 'stale_owner');
    store.patchSession('session-a', { expectedRevision: 1, archived: false });
    assert.equal(store.read('session-a')?.resume.available, true);
    assert.equal(store.list({ cwd: '/another/workspace' }).length, 0);
});

test('restart expires approvals, fails orphaned work, fences callbacks and preserves consumed keys', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    const current = owner(admitted.session);
    store.writeNativeCursor(current, 'durable-native-cursor');
    store.commitItem(current, {
        itemId: 'permission', turnId: admitted.receipt.turnId, kind: 'permission_request', status: 'pending',
        createdAt: 1234, updatedAt: 1234,
        permission: { permissionId: 'p', sessionId: 'session-a', turnId: admitted.receipt.turnId, epoch: current.epoch,
            title: 'Run command', detail: 'tool detail', options: [{ optionId: 'allow', label: 'Allow', kind: 'allow_once' }], requestedAt: 1234 },
    });
    store.commitItem(current, message(admitted.receipt.turnId, 'after-permission'));
    const recent = store.snapshot('session-a', { limit: 1 });
    assert.deepEqual(recent.items.map(item => item.itemId), ['after-permission']);
    assert.equal(recent.pendingPermissions.length, 1);
    assert.equal(recent.pendingPermissions[0]?.permissionId, 'p');
    store.create({ ...creation, sessionId: 'session-b' });
    const unaffected = store.snapshot('session-b');
    const restarted = new CodeStore(db, { now: () => 5678 });
    const events = restarted.recoverInterrupted();
    assert.ok(events.length > 0);
    assert.ok(events.every(event => event.sessionId === 'session-a'));
    const snapshot = restarted.snapshot('session-a');
    assert.equal(snapshot.session.status, 'failed');
    assert.equal(snapshot.session.turnId, null);
    assert.equal(snapshot.session.epoch, current.epoch + 1);
    assert.equal(snapshot.session.error?.code, 'orphaned_turn');
    assert.equal(snapshot.items.find(item => item.itemId === 'permission')?.status, 'cancelled');
    assert.deepEqual(snapshot.pendingPermissions, []);
    assert.equal(snapshot.items.filter(item => item.kind === 'turn_failed').length, 1);
    const duplicate = admit(restarted);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.receipt.status, 'failed');
    assert.deepEqual(duplicate.events, []);
    expectError(() => restarted.writeNativeCursor(current, 'stale'), 'stale_owner');
    assert.deepEqual(restarted.recoverInterrupted(), []);
    assert.deepEqual(restarted.snapshot('session-b'), unaffected);
    assert.equal(admit(restarted, 'new-key').duplicate, false);
});

test('missing native identity after actual start cannot silently start fresh, but receipt is still consumed', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    store.writeNativeCursor(owner(admitted.session), null);
    assert.equal(store.read('session-a')?.resume.reason, 'resume_unavailable');
    store.recoverInterrupted();
    assert.equal(admit(store).duplicate, true);
    expectError(() => admit(store, 'new-key'), 'resume_unavailable');
    assert.equal(store.readTurn('session-a', 'new-key'), null);
});

test('never-started metadata can first-open after recovery and cursor cannot regress to null', t => {
    const { store } = fixture(t);
    assert.equal(store.read('session-a')?.resume.reason, 'not_started');
    assert.deepEqual(store.recoverInterrupted(), []);
    const admitted = admit(store);
    store.writeNativeCursor(owner(admitted.session), 'real-native-id');
    store.writeNativeCursor(owner(admitted.session), null);
    assert.equal(store.readRecord('session-a')?.nativeCursor, 'real-native-id');
    expectError(() => store.writeNativeCursor(owner(admitted.session), ' '), 'invalid_cursor', 400);
    store.setRuntimeState(owner(admitted.session), 'stopping');
    expectError(() => store.writeNativeCursor(owner(admitted.session), 'late'), 'stale_owner');
    expectError(() => store.setRuntimeState(owner(admitted.session), 'streaming'), 'stale_owner');
});

test('explicit attach reserves a fresh epoch, blocks new prompts, and stores resume failure without losing history', t => {
    const { store } = fixture(t);
    expectError(() => store.beginAttach('session-a'), 'resume_unavailable');
    const admitted = admit(store);
    store.writeNativeCursor(owner(admitted.session), 'durable-id');
    const finished = store.settleTurn(owner(admitted.session), { status: 'completed' });
    const attached = store.beginAttach('session-a', 0);
    assert.equal(attached.session.turnId, null);
    assert.equal(attached.session.status, 'starting');
    assert.equal(attached.session.epoch, finished.session.epoch + 1);
    expectError(() => admit(store, 'new-key'), 'session_busy');
    expectError(() => store.beginAttach('session-a'), 'session_busy');
    expectError(() => store.writeNativeCursor(owner(finished.session), 'late'), 'stale_owner');
    const failed = store.setRuntimeState(owner(attached.session), 'failed', {
        code: 'resume_failed', message: 'Native resume failed', at: 1234, recoverable: true,
    });
    assert.equal(failed.session.error?.code, 'resume_failed');
    assert.equal(store.snapshot('session-a').items.length, 3);
    assert.equal(store.readRecord('session-a')?.nativeCursor, 'durable-id');
    assert.equal(store.readTurn('session-a', 'new-key'), null);
    const retried = store.beginAttach('session-a');
    assert.equal(store.setRuntimeState(owner(retried.session), 'idle').session.status, 'idle');
});

test('restart during attach fails residency without inventing a turn or erasing transcript', t => {
    const { store } = fixture(t);
    const admitted = admit(store);
    store.writeNativeCursor(owner(admitted.session), 'durable-id');
    store.settleTurn(owner(admitted.session), { status: 'completed' });
    const before = store.snapshot('session-a').items;
    const attached = store.beginAttach('session-a');
    store.recoverInterrupted();
    const after = store.snapshot('session-a');
    assert.equal(after.session.epoch, attached.session.epoch + 1);
    assert.equal(after.session.status, 'failed');
    assert.deepEqual(after.items, before);
    assert.equal(store.readTurn('session-a', 'key-a')?.status, 'completed');
});

test('independent backend connections recover only their own sessions even with identical IDs', t => {
    const first = fixture(t);
    const second = fixture(t);
    admit(first.store);
    admit(second.store);
    const before = second.store.snapshot('session-a');
    first.store.recoverInterrupted();
    assert.equal(first.store.read('session-a')?.status, 'failed');
    assert.deepEqual(second.store.snapshot('session-a'), before);
    assert.equal(second.store.read('session-a')?.status, 'starting');
});

test('metadata and cursor event failures cannot commit private or public state ahead of publication', t => {
    const { store, db } = fixture(t);
    const admitted = admit(store);
    const before = store.readRecord('session-a');
    db.exec(`CREATE TRIGGER reject_session_event BEFORE INSERT ON code_events
        WHEN json_extract(NEW.event_json, '$.event') = 'code_session'
        BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END`);
    assert.throws(() => store.patchSession('session-a', { expectedRevision: 0, title: 'Uncommitted' }), /injected metadata failure/);
    assert.throws(() => store.writeNativeCursor(owner(admitted.session), 'uncommitted-cursor'), /injected metadata failure/);
    assert.deepEqual(store.readRecord('session-a'), before);
    assert.deepEqual(store.readEvents('session-a', 4).events, []);
});

test('writes cannot hand out uncommitted events from an outer transaction', t => {
    const { store, db } = fixture(t);
    db.transaction(() => expectError(() => admit(store), 'nested_transaction'))();
    assert.equal(store.read('session-a')?.sequence, 1);
    assert.equal(store.readTurn('session-a', 'key-a'), null);
});

test('missing sessions and invalid prompts do not allocate durable work', t => {
    const { store } = fixture(t);
    assert.equal(store.read('missing'), null);
    expectError(() => store.snapshot('missing'), 'session_not_found', 404);
    expectError(() => admit(store, 'key', 'missing'), 'session_not_found', 404);
    expectError(() => admit(store, 'key', 'session-a', '  '), 'invalid_prompt', 400);
    expectError(() => admit(store, ' '), 'invalid_prompt', 400);
    assert.equal(store.read('session-a')?.sequence, 1);
});
