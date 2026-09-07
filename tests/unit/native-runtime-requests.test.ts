import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRequests, type RuntimeRequestBinding } from '../../src/agent/runtime/requests.ts';
import { RUNTIME_BODY_BYTES } from '../../src/trace/runtime-body-codec.ts';
import { preparePermissionRequest, permissionOptions } from '../../src/agent/runtime/acp/permissions.ts';

const binding: RuntimeRequestBinding = { runId: 'run', sessionId: 'chat', scope: 'mention-watch:scope', turnId: 'turn' };
const cancelled = { outcome: { outcome: 'cancelled' } };
function view() {
    return { title: 'Decision', fields: [{ id: 'field', label: 'Choose', multiSelect: false, allowFreeform: false,
        options: [{ id: 'choice', label: 'Yes' }] }] };
}
function fixture(t: TestContext) {
    const registry = new RuntimeRequests();
    t.after(() => { registry.cancelRun('run'); registry.cancelRun('other'); });
    return registry;
}
function input(overrides: Partial<Parameters<RuntimeRequests['open']>[0]> = {}) {
    return { ...binding, requestType: 'question' as const, view: view(), cancelled, isCurrent: () => true,
        validate: (response: unknown) => response, ...overrides };
}

test('exact binding is required and invalid answers remain correctable', async t => {
    const registry = fixture(t);
    const pending = registry.open(input({ validate: response => {
        if (response !== 'yes') throw new Error('invalid_option');
        return { accepted: true };
    } }));
    for (const key of ['runId', 'sessionId', 'scope', 'turnId'] as const) {
        assert.throws(() => registry.respond(pending.requestId, { ...binding, [key]: 'foreign' }, 'yes'), /request_not_current/);
        assert.equal(registry.list('chat').length, 1);
    }
    assert.throws(() => registry.respond(pending.requestId, binding, 'no'), /invalid_option/);
    registry.respond(pending.requestId, binding, 'yes');
    assert.deepEqual(await pending.answer, { accepted: true });
    assert.throws(() => registry.respond(pending.requestId, binding, 'yes'), /request_not_current/);
    assert.deepEqual(registry.list('chat'), []);
});

test('20 respond/cancel rounds remove owned requests while a different-run sentinel stays answerable', { timeout: 10_000 }, async t => {
    const registry = fixture(t);
    const before = registry.list('chat');
    assert.deepEqual(before, []);
    const notices: string[] = [];
    registry.setChangeObserver(sessionId => { notices.push(sessionId); });
    const sentinelBinding = { ...binding, runId: 'other', turnId: 'sentinel-turn', scope: 'sentinel-scope' };
    const sentinel = registry.open(input(sentinelBinding));
    const sentinelView = registry.list('chat');
    let sentinelSettlements = 0;
    void sentinel.answer.then(() => { sentinelSettlements++; });
    const ids = new Set<string>();
    try {
        for (let round = 0; round < 20; round++) {
            const ownedBinding = { ...binding, turnId: `cycle-turn-${round}` };
            const startNotices = notices.length;
            const pending = registry.open(input(ownedBinding));
            assert.equal(ids.has(pending.requestId), false); ids.add(pending.requestId);
            assert.equal(notices.length, startNotices + 1);
            assert.equal(registry.list('chat').length, 2);
            assert.throws(() => registry.respond(pending.requestId, sentinelBinding, 'foreign'), /request_not_current/);
            let settlements = 0;
            const answer = pending.answer.then(value => { settlements++; return value; });
            const expected = round % 2 === 0 ? `answer-${round}` : cancelled;
            if (round % 2 === 0) registry.respond(pending.requestId, ownedBinding, expected);
            else pending.cancel();
            assert.deepEqual(await answer, expected);
            assert.equal(settlements, 1); assert.equal(notices.length, startNotices + 2);
            pending.cancel(); registry.cancelRun('run');
            assert.throws(() => registry.respond(pending.requestId, ownedBinding, 'late'), /request_not_current/);
            assert.equal(notices.length, startNotices + 2, 'repeat cancellation must not publish another settlement');
            assert.deepEqual(registry.list('chat'), sentinelView);
            assert.equal(sentinelSettlements, 0);
        }
        registry.respond(sentinel.requestId, sentinelBinding, 'sentinel-answer');
        assert.equal(await sentinel.answer, 'sentinel-answer');
        assert.equal(sentinelSettlements, 1);
        assert.equal(ids.size, 20);
    } finally {
        registry.cancelRun('run'); sentinel.cancel();
        await sentinel.answer;
        registry.setChangeObserver(undefined);
        assert.deepEqual(registry.list('chat'), before);
    }
});

test('128 entries fit, overflow rejects, and cancellation releases admission', async t => {
    const registry = fixture(t);
    const requests = Array.from({ length: 128 }, () => registry.open(input()));
    assert.equal(registry.list('chat').length, 128);
    assert.throws(() => registry.open(input()), /request_capacity/);
    registry.cancelRun('run');
    assert.deepEqual(await Promise.all(requests.map(p => p.answer)), requests.map(() => cancelled));
    const next = registry.open(input());
    next.cancel();
    assert.deepEqual(await next.answer, cancelled);
});
test('a nested admission cannot push the commit point above128 entries', t => {
    const registry = fixture(t);
    for (let i = 0; i < 127; i++) registry.open(input());
    let inserted = false;
    const nestedView = { ...view(), get title() {
        if (!inserted) { inserted = true; registry.open(input({ runId: 'other' })); }
        return 'Nested admission';
    } };
    assert.throws(() => registry.open(input({ view: nestedView })), /request_capacity/);
    assert.equal(registry.list('chat').length, 128);
});

test('expiry settles once at120 seconds and rejects late responses', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const registry = fixture(t);
    const pending = registry.open(input());
    assert.equal(pending.expiresAt, 121_000);
    t.mock.timers.tick(119_999);
    assert.equal(registry.list('chat').length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await pending.answer, cancelled);
    pending.cancel(); registry.cancelRun('run');
    assert.deepEqual(registry.list('chat'), []);
    assert.throws(() => registry.respond(pending.requestId, binding, 'yes'), /request_not_current/);
});

test('ownership loss or predicate failure prunes and cancels without granting', async t => {
    const registry = fixture(t);
    let current = true;
    const first = registry.open(input({ isCurrent: () => current }));
    current = false;
    assert.throws(() => registry.respond(first.requestId, binding, 'yes'), /request_not_current/);
    assert.deepEqual(await first.answer, cancelled);
    let fail = false;
    const second = registry.open(input({ isCurrent: () => { if (fail) throw new Error('private'); return true; } }));
    fail = true;
    assert.deepEqual(registry.list('chat'), []);
    assert.deepEqual(await second.answer, cancelled);
    assert.throws(() => registry.open(input({ isCurrent: () => false })), /request_not_current/);
});

for (const timed of [false, true]) test(`cancelled data is independently frozen for ${timed ? 'timeout' : 'explicit cancel'}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const registry = fixture(t);
    const original = { outcome: { outcome: 'cancelled' } };
    const pending = registry.open(input({ cancelled: original }));
    original.outcome.outcome = 'selected';
    assert.equal(Object.isFrozen(original), false);
    if (timed) t.mock.timers.tick(120_000); else pending.cancel();
    const answer = await pending.answer as typeof original;
    assert.deepEqual(answer, cancelled);
    assert.notEqual(answer, original);
    assert.ok(Object.isFrozen(answer.outcome));
    assert.throws(() => { answer.outcome.outcome = 'selected'; }, TypeError);
});

test('timeout captures cancellation once and never re-reads the input object', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const registry = fixture(t);
    let reads = 0;
    const source = { ...input(), get cancelled() { reads++; return cancelled; } };
    const pending = registry.open(source);
    Object.defineProperty(source, 'cancelled', { get: () => { throw new Error('raw input retained'); } });
    t.mock.timers.tick(120_000);
    assert.equal(reads, 1);
    assert.deepEqual(await pending.answer, cancelled);
});

test('unsupported and oversized cancellation values never allocate a timer or entry', t => {
    const registry = fixture(t);
    const timer = t.mock.method(globalThis, 'setTimeout');
    const cycle: unknown[] = []; cycle.push(cycle);
    for (const value of [undefined, 1n, NaN, () => {}, Promise.resolve(null), { then() {} },
        [Promise.resolve(null)], cycle, new Date(), new Map(), [undefined], 'x'.repeat(RUNTIME_BODY_BYTES + 1)]) {
        assert.throws(() => registry.open(input({ cancelled: value })), /invalid_cancellation/);
    }
    assert.equal(timer.mock.callCount(), 0);
    assert.deepEqual(registry.list('chat'), []);
});
test('shared-reference cancellation expansion is rejected before whole-object serialization', t => {
    const registry = fixture(t);
    let graph: object = { text: 'x'.repeat(32) };
    for (let i = 0; i < 12; i++) graph = { left: graph, right: graph };
    const stringify = t.mock.method(JSON, 'stringify');
    assert.throws(() => registry.open(input({ cancelled: graph })), /invalid_cancellation/);
    assert.ok(stringify.mock.calls.every(call => {
        const value: unknown = call.arguments[0];
        return !value || typeof value !== 'object' || !Object.hasOwn(value, 'left');
    }), 'must reject the shared graph before expanding its serialized tree');
    assert.deepEqual(registry.list('chat'), []);
});
test('cancellation byte and depth limits apply before copying, with no accessor execution', async t => {
    const registry = fixture(t);
    const exact = 'x'.repeat(RUNTIME_BODY_BYTES - 2);
    const pending = registry.open(input({ cancelled: exact }));
    pending.cancel();
    assert.equal(await pending.answer, exact);
    assert.throws(() => registry.open(input({ cancelled: exact + 'x' })), /invalid_cancellation/);
    assert.throws(() => registry.open(input({ cancelled: '\u0000'.repeat(6000) })), /invalid_cancellation/);
    let deep: unknown = null;
    for (let i = 0; i < 33; i++) deep = [deep];
    assert.throws(() => registry.open(input({ cancelled: deep })), /invalid_cancellation/);
    let reads = 0;
    assert.throws(() => registry.open(input({ cancelled: { get outcome() { reads++; return 'cancelled'; } } })), /invalid_cancellation/);
    assert.equal(reads, 0);
});
test('optional parent identity is included in the actual event byte budget', t => {
    const registry = fixture(t);
    const nearLimit = { title: 'Decision', fields: Array.from({ length: 4 }, (_, i) => ({
        id: 'field-' + i, label: 'Field', multiSelect: false, allowFreeform: false,
        options: Array.from({ length: 17 }, (_, j) => ({ id: 'option-' + j, label: 'x'.repeat(360) })),
    })) };
    const pending = registry.open(input({ view: nearLimit }));
    pending.cancel();
    assert.throws(() => registry.open(input({ view: nearLimit, parentItemId: '\u0000'.repeat(240) })), /request_view_limit/);
});

test('validator cancellation or ownership-side cancellation cannot return accepted', async t => {
    const registry = fixture(t);
    let pending = registry.open(input({ validate: () => { pending.cancel(); return 'yes'; } }));
    assert.throws(() => registry.respond(pending.requestId, binding, 'yes'), /request_not_current/);
    assert.deepEqual(await pending.answer, cancelled);
    let cancelInPredicate = false;
    pending = registry.open(input({ isCurrent: () => { if (cancelInPredicate) pending.cancel(); return true; } }));
    cancelInPredicate = true;
    assert.throws(() => registry.respond(pending.requestId, binding, 'yes'), /request_not_current/);
    assert.deepEqual(await pending.answer, cancelled);
});

test('asynchronous validators reject admission without unhandled rejected promises', async t => {
    const registry = fixture(t);
    for (const validate of [() => Promise.reject(new Error('private-validator-error')),
        () => ({ then: (_yes: unknown, no: (error: Error) => void) => no(new Error('thenable-error')) })]) {
        const pending = registry.open(input({ validate }));
        assert.throws(() => registry.respond(pending.requestId, binding, 'yes'), /invalid_response/);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(registry.list('chat').length, 1);
        pending.cancel();
        assert.deepEqual(await pending.answer, cancelled);
    }
});

test('sanitization, byte budget and owner recheck precede entry/timer creation', t => {
    const registry = fixture(t);
    const timer = t.mock.method(globalThis, 'setTimeout');
    const huge = { title: 'Decision', fields: Array.from({ length: 8 }, (_, i) => ({
        id: 'f' + i, label: 'Field', multiSelect: false, allowFreeform: false,
        options: Array.from({ length: 20 }, (_, j) => ({ id: 'o' + j, label: '한'.repeat(500) })),
    })) };
    for (const bad of [null, { ...view(), fields: [view().fields[0], view().fields[0]] }]) {
        assert.throws(() => registry.open(input({ view: bad })), /invalid_request_view/);
    }
    assert.throws(() => registry.open(input({ view: huge })), /request_view_limit/);
    assert.throws(() => registry.open(input({ view: { get title() { throw new Error('sanitizer fixture'); } } })), /sanitizer fixture/);
    let current = true;
    const source = { ...view(), get title() { current = false; return 'changed owner'; } };
    assert.throws(() => registry.open(input({ view: source, isCurrent: () => current })), /request_not_current/);
    assert.equal(timer.mock.callCount(), 0);
    assert.deepEqual(registry.list('chat'), []);
});

test('stored and returned views are immutable snapshots with redaction before clipping', t => {
    const registry = fixture(t);
    const original = view();
    original.title = '{"password":"CANARY_TITLE"}';
    original.fields[0]!.options[0]!.label = 'x'.repeat(485) + ' Bearer CANARY_LABEL_SECRET_LONG';
    const pending = registry.open(input({ view: original }));
    const publicText = JSON.stringify(registry.list('chat'));
    assert.ok(!publicText.includes('CANARY'));
    assert.ok(pending.view.fields[0]!.options[0]!.label.length <= 500);
    original.title = 'forged'; original.fields[0]!.options[0]!.label = 'forged';
    assert.throws(() => { pending.view.title = 'forged'; }, TypeError);
    assert.throws(() => { pending.view.fields[0]!.options[0]!.label = 'forged'; }, TypeError);
    const listed = registry.list('chat');
    listed[0]!.view.title = 'list mutation';
    assert.deepEqual(registry.list('chat')[0]!.view, pending.view);
    assert.deepEqual(registry.list('foreign'), []);
    assert.deepEqual(Object.keys(listed[0]!).sort(), ['expiresAt', 'requestId', 'requestType', 'runId', 'scope', 'sessionId', 'turnId', 'view']);
});

test('raw native IDs and foreign handles cannot answer an opaque permission request', async t => {
    const registry = fixture(t);
    const options = permissionOptions([{ optionId: 'CANARY_NATIVE_ID', name: 'Allow', kind: 'allow_once' }]);
    const prepared = preparePermissionRequest('[ -f file ]', options);
    const other = preparePermissionRequest('[docs](url)', options);
    t.after(() => { prepared.dispose(); other.dispose(); });
    const pending = registry.open(input({ view: prepared.view, validate: prepared.validate, requestType: 'approval' }));
    assert.ok(!JSON.stringify(registry.list('chat')).includes('CANARY_NATIVE_ID'));
    assert.equal(pending.view.title, '[ -f file ]');
    for (const optionId of ['CANARY_NATIVE_ID', other.view.fields[0]!.options[0]!.id, 'altered-handle']) {
        assert.throws(() => registry.respond(pending.requestId, binding, { optionId }), /invalid_option/);
    }
    registry.respond(pending.requestId, binding, { optionId: pending.view.fields[0]!.options[0]!.id });
    assert.deepEqual(await pending.answer, { outcome: { outcome: 'selected', optionId: 'CANARY_NATIVE_ID' } });
});

test('wrong identity and request type cannot bypass the shared event boundary', t => {
    const registry = fixture(t);
    for (const key of ['runId', 'sessionId', 'scope', 'turnId'] as const) {
        assert.throws(() => registry.open(input({ [key]: '' })), /invalid_runtime_event/);
    }
    assert.throws(() => registry.open(input({ parentItemId: '' })), /invalid_runtime_event/);
    assert.throws(() => registry.open(input({ requestType: 'other' as 'approval' })), /invalid_runtime_event/);
    assert.deepEqual(registry.list('chat'), []);
});
