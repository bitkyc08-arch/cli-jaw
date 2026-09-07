import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { CodeSessionManager, CodeServiceError } from '../../src/code-mode/manager.js';
import { CodeStore, CodeStoreError, type CodeStoreLimits } from '../../src/code-mode/store.js';
import type { CodeOpenOptions, CodeProvider, CodeProviderSession, CodeRuntimeResource } from '../../src/code-mode/provider.js';
import type { RuntimeEventContext } from '../../src/agent/runtime/events.js';
import type { RuntimeTurnOutcome } from '../../src/shared/runtime-contract.js';
import type { CodeCreateSessionRequest, CodeProviderCatalog, CodeProviderId, CodeWireEvent } from '../../src/code-mode/wire.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const done: RuntimeTurnOutcome = { status: 'done', finalText: 'complete answer', partialText: '' };
const prompt = { text: 'hello', clientTurnKey: 'key-one' };

class NativeHandle implements CodeProviderSession {
    alive = true;
    sends: string[] = [];
    cancellations = 0;
    closes = 0;
    readonly sent = deferred<void>();
    readonly closeCalled = deferred<void>();
    closed = false;
    readonly closedEvent = deferred<void>();
    completeClose = true;
    private readonly outcomes = [deferred<RuntimeTurnOutcome>()];
    private readonly sentSignals = new Map([[0, this.sent]]);
    closeGate: Promise<void> | null = null;
    cancelGate: Promise<void> | null = null;
    beforeSend: (() => void) | null = null;
    private closing: Promise<void> | null = null;
    constructor(readonly nativeSessionId = 'private-native-cursor') {}
    get outcome() { return this.outcomes.at(-1)!; }
    waitSent(index: number): Promise<void> {
        if (this.sends.length > index) return Promise.resolve();
        let signal = this.sentSignals.get(index);
        if (!signal) { signal = deferred<void>(); this.sentSignals.set(index, signal); }
        return signal.promise;
    }
    send(text: string): Promise<RuntimeTurnOutcome> {
        assert.equal(this.alive, true, 'closed handles must never receive a new prompt');
        this.beforeSend?.();
        const index = this.sends.length;
        if (!this.outcomes[index]) this.outcomes[index] = deferred<RuntimeTurnOutcome>();
        this.sends.push(text);
        this.sentSignals.get(index)?.resolve();
        return this.outcomes[index]!.promise;
    }
    async cancel(): Promise<void> { this.cancellations++; await this.cancelGate; }
    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closes++;
        this.closeCalled.resolve();
        this.closing = Promise.resolve().then(async () => {
            await this.closeGate;
            this.alive = false;
            if (this.completeClose) { this.closed = true; this.closedEvent.resolve(); }
        });
        return this.closing;
    }
}

class Provider implements CodeProvider {
    readonly calls: CodeOpenOptions[] = [];
    readonly handles: NativeHandle[] = [];
    readonly opens = new Map<number, ReturnType<typeof deferred<CodeOpenOptions>>>();
    gate: Promise<void> | null = null;
    beforeOpen: ((options: CodeOpenOptions) => void) | null = null;
    registerBeforeOpen = true;
    catalog: CodeProviderCatalog;
    constructor(readonly id: CodeProviderId) {
        this.catalog = { id, label: id, available: true, reason: null, models: ['model-a', 'model-b'],
            defaultModel: 'model-a', defaultEffort: 'low', modelSource: 'registry',
            capabilities: { resume: true, interrupt: true, permissions: true, setModelMidSession: false,
                efforts: ['low', 'high'], permissionModes: ['ask', 'auto'] } };
    }
    describe(): CodeProviderCatalog { return structuredClone(this.catalog); }
    opened(index = 0): Promise<CodeOpenOptions> {
        if (this.calls[index]) return Promise.resolve(this.calls[index]);
        let signal = this.opens.get(index);
        if (!signal) { signal = deferred<CodeOpenOptions>(); this.opens.set(index, signal); }
        return signal.promise;
    }
    async open(options: CodeOpenOptions): Promise<CodeProviderSession> {
        const index = this.calls.length;
        this.calls.push(options);
        const handle = this.handles[index] ?? new NativeHandle(options.nativeCursor ?? undefined);
        this.handles[index] = handle;
        if (this.registerBeforeOpen) options.onResource(handle);
        this.opens.get(index)?.resolve(options);
        try {
            this.beforeOpen?.(options);
            await this.gate;
            return handle;
        } catch (error) { await handle.close(); throw error; }
    }
}

function fixture(t: TestContext, config: { capacity?: number; idleReapMs?: number; defaults?: boolean;
    storeLimits?: Partial<CodeStoreLimits>; publish?: (event: CodeWireEvent) => void } = {}) {
    const db = new Database(':memory:');
    let next = 0;
    const store = new CodeStore(db, { newId: () => `local-${++next}`,
        ...(config.storeLimits ? { limits: config.storeLimits } : {}) });
    const providers = { 'codex-app': new Provider('codex-app'), claude: new Provider('claude'),
        cursor: new Provider('cursor'), grok: new Provider('grok') };
    const events: CodeWireEvent[] = [];
    const waiters: Array<{ predicate: (event: CodeWireEvent) => boolean; resolve: (event: CodeWireEvent) => void }> = [];
    const manager = new CodeSessionManager({ store, providers,
        ...(config.defaults ? {} : { maxConcurrentSessions: config.capacity ?? 4, idleReapMs: config.idleReapMs ?? 60_000 }),
        publish(event) {
            events.push(event);
            for (const waiter of [...waiters]) {
                if (!waiter.predicate(event)) continue;
                waiters.splice(waiters.indexOf(waiter), 1);
                waiter.resolve(event);
            }
            config.publish?.(event);
        } });
    t.after(async () => { await manager.dispose(); db.close(); });
    const waitEvent = (predicate: (event: CodeWireEvent) => boolean): Promise<CodeWireEvent> => {
        const existing = events.find(predicate);
        return existing ? Promise.resolve(existing) : new Promise(resolve => { waiters.push({ predicate, resolve }); });
    };
    const create = (provider: CodeProviderId = 'codex-app', overrides: Partial<CodeCreateSessionRequest> = {}) =>
        manager.create({ provider, cwd: '/workspace/a', model: 'model-a', effort: 'low', permissionMode: 'ask', ...overrides });
    const terminal = (id: string, epoch: number) => waitEvent(event => event.sessionId === id && event.epoch === epoch
        && event.event === 'code_session' && event.session?.turnId === null && event.session.status !== 'starting');
    return { db, store, providers, manager, events, waitEvent, create, terminal };
}

function errorCode(code: string, statusCode?: number) {
    return (error: unknown) => (error instanceof CodeStoreError || error instanceof CodeServiceError)
        && error.code === code && (statusCode === undefined || error.statusCode === statusCode);
}

function approval(options: CodeOpenOptions, question = false) {
    const context = options.getTurnContext();
    return options.registry.open({ ...context, requestType: question ? 'question' : 'approval',
        view: { title: 'Allow command?', fields: [{ id: 'decision', label: 'Run the command',
            multiSelect: false, allowFreeform: false,
            options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] }] },
        isCurrent: context.isCurrent, cancelled: { optionId: null as string | null },
        validate(value: unknown) {
            assert.deepEqual(Object.keys(value as object), ['optionId']);
            const answer = value as { optionId: string };
            if (answer.optionId !== 'allow' && answer.optionId !== 'deny') throw new Error('invalid_response');
            return answer;
        } });
}

test('constructor and metadata reads are pure; create snapshots fixed capabilities without native open', async t => {
    const f = fixture(t);
    const row = f.create();
    f.providers['codex-app'].catalog.capabilities.permissionModes = ['auto'];
    assert.deepEqual(f.manager.snapshot(row.sessionId).session.capabilities.permissionModes, ['ask', 'auto']);
    assert.equal(f.manager.list().length, 1);
    assert.equal(f.manager.readEvents(row.sessionId).events.length, 1);
    assert.equal(f.manager.models().providers.length, 4);
    await Promise.resolve();
    assert.equal(f.providers['codex-app'].calls.length, 0);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
});

test('slow open reserves capacity synchronously while matching duplicate returns its durable receipt', async t => {
    const f = fixture(t, { capacity: 1 });
    const gate = deferred<void>();
    f.providers['codex-app'].gate = gate.promise;
    const a = f.create(), b = f.create('claude');
    const first = f.manager.prompt(a.sessionId, prompt);
    assert.equal(first.receipt.status, 'accepted');
    assert.equal(f.store.snapshot(a.sessionId).session.status, 'starting');
    assert.equal(f.store.readTurn(a.sessionId, prompt.clientTurnKey)?.turnId, first.receipt.turnId);
    assert.deepEqual(f.manager.prompt(a.sessionId, prompt), { ...first, duplicate: true });
    assert.throws(() => f.manager.prompt(a.sessionId, { ...prompt, text: 'different' }), errorCode('turn_key_conflict'));
    assert.throws(() => f.manager.prompt(a.sessionId, { ...prompt, clientTurnKey: 'second' }), errorCode('session_busy'));
    assert.throws(() => f.manager.prompt(b.sessionId, prompt), errorCode('session_capacity', 503));
    assert.equal(f.store.readTurn(b.sessionId, prompt.clientTurnKey), null);
    const options = await f.providers['codex-app'].opened();
    assert.equal(options.getTurnContext().audience, 'internal');
    gate.resolve();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(a.sessionId, 1);
    assert.equal(f.manager.prompt(a.sessionId, prompt).receipt.status, 'completed');
    assert.equal(handle.sends.length, 1);
});

test('two providers run independently and one native exit cannot settle or cancel the other', async t => {
    const f = fixture(t);
    const a = f.create(), b = f.create('claude');
    f.manager.prompt(a.sessionId, prompt);
    f.manager.prompt(b.sessionId, prompt);
    const ac = await f.providers['codex-app'].opened(), bc = await f.providers.claude.opened();
    const ah = f.providers['codex-app'].handles[0]!, bh = f.providers.claude.handles[0]!;
    await Promise.all([ah.sent.promise, bh.sent.promise]);
    assert.notEqual(ac.registry, bc.registry);
    ac.onExit(new Error('private protocol failure'));
    await f.terminal(a.sessionId, 1);
    assert.equal(f.manager.snapshot(a.sessionId).session.error?.code, 'native_exit');
    assert.equal(f.manager.snapshot(b.sessionId).session.status, 'streaming');
    assert.equal(bh.cancellations, 0);
    bh.outcome.resolve(done);
    await f.terminal(b.sessionId, 1);
    assert.doesNotMatch(JSON.stringify(f.events), /private protocol failure|private-native-cursor/);
});

test('cancel during slow open is bounded, duplicate cancel is harmless, late handle closes without send', async t => {
    const f = fixture(t, { capacity: 1 });
    const gate = deferred<void>();
    f.providers['codex-app'].gate = gate.promise;
    const row = f.create();
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers['codex-app'].opened();
    const input = { turnId: receipt.turnId, epoch: 1 };
    const [a, b] = await Promise.all([f.manager.cancel(row.sessionId, input), f.manager.cancel(row.sessionId, input)]);
    assert.equal(a.status, 'idle');
    assert.equal(b.status, 'idle');
    assert.equal(options.signal.aborted, true);
    const other = f.create('claude');
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    options.onNativeCursor('late-cursor');
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, null);
    gate.resolve();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.closedEvent.promise;
    assert.deepEqual(handle.sends, []);
    assert.equal(handle.closes, 1);
    assert.equal(f.events.filter(event => event.item?.kind === 'turn_cancelled').length, 1);
});

test('approval answers use current flat options and cancelling a pending approval invalidates eligibility', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    await f.providers.claude.handles[0]!.sent.promise;
    const pending = approval(options);
    const snapshot = f.manager.snapshot(row.sessionId);
    assert.equal(snapshot.pendingPermissions.length, 1);
    assert.equal(snapshot.items.filter(item => item.kind === 'permission_request').length, 1);
    assert.deepEqual(snapshot.pendingPermissions[0]?.options.map(option => option.optionId), ['allow', 'deny']);
    const input = { sessionId: row.sessionId, turnId: receipt.turnId, epoch: 1, optionId: 'allow' };
    assert.throws(() => f.manager.answerPermission(pending.requestId, { ...input, epoch: 2 }), errorCode('request_not_current'));
    assert.throws(() => f.manager.answerPermission(pending.requestId, { ...input, optionId: 'foreign' }), errorCode('invalid_option'));
    f.manager.answerPermission(pending.requestId, input);
    assert.deepEqual(await pending.answer, { optionId: 'allow' });
    assert.deepEqual(f.manager.snapshot(row.sessionId).pendingPermissions, []);
    const pendingTwo = approval(options);
    await f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
    assert.deepEqual(await pendingTwo.answer, { optionId: null });
    assert.deepEqual(options.registry.list(row.sessionId), []);
    assert.throws(() => f.manager.answerPermission(pendingTwo.requestId, input), errorCode('request_not_current'));
});

test('unsupported native questions are cancelled with an explicit failed-turn diagnostic', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    await f.providers.claude.handles[0]!.sent.promise;
    const question = approval(options, true);
    assert.deepEqual(await question.answer, { optionId: null });
    await f.terminal(row.sessionId, 1);
    assert.equal(f.manager.snapshot(row.sessionId).session.error?.code, 'unsupported_request');
    assert.deepEqual(f.manager.snapshot(row.sessionId).pendingPermissions, []);
});

test('two healthy turns reuse one handle and registry while fencing old captured frames', async t => {
    const f = fixture(t);
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    const old = await f.providers['codex-app'].opened();
    const first = f.providers['codex-app'].handles[0]!;
    await first.sent.promise;
    const oldContext = old.getTurnContext();
    const oldObserver = old.transcript(oldContext);
    const oldPending = approval(old);
    oldObserver.tool('parent', { name: 'task', status: 'running' }, {});
    const oldParent = old.resolveTranscriptParent(oldContext, 'parent');
    assert.ok(oldParent);
    first.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    assert.deepEqual(await oldPending.answer, { optionId: null });
    assert.deepEqual(old.registry.list(row.sessionId), []);
    assert.equal(first.closes, 0);
    assert.equal(old.signal.aborted, false);
    f.manager.prompt(row.sessionId, { text: 'new turn', clientTurnKey: 'new-key' });
    await first.waitSent(1);
    const current = old;
    const secondContext = current.getTurnContext();
    assert.equal(f.providers['codex-app'].calls.length, 1);
    assert.deepEqual(first.sends, ['hello', 'new turn']);
    assert.notEqual(secondContext.turnId, oldContext.turnId);
    assert.equal(secondContext.epoch, 2);
    assert.equal(oldContext.isCurrent(), false);
    assert.equal(secondContext.isCurrent(), true);
    const before = f.store.snapshot(row.sessionId).sequence;
    oldObserver.text('message', 'late', 'stale output', 'replace', 'final');
    old.onNativeCursor('stale-cursor');
    current.onNativeCursor('foreign-cursor', oldContext);
    old.record(oldContext, { kind: 'usage', inputTokens: 3 });
    current.transcript(oldContext).text('message', 'also-late', 'stale factory output', 'replace', 'final');
    const wrongEpoch = { ...secondContext, epoch: 1 };
    current.onNativeCursor('wrong-epoch', wrongEpoch);
    assert.equal(current.resolveTranscriptParent(oldContext, 'parent'), null);
    assert.equal(f.store.snapshot(row.sessionId).sequence, before);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'private-native-cursor');
    const { epoch: _epoch, isCurrent: _isCurrent, ...plain } = current.getTurnContext();
    current.onNativeCursor('current-cursor', plain satisfies RuntimeEventContext);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'current-cursor');
    await assert.rejects(f.manager.cancel(row.sessionId, { turnId: oldContext.turnId, epoch: 1 }), errorCode('stale_owner'));
    assert.equal(first.cancellations, 0);
    const secondObserver = current.transcript(secondContext);
    secondObserver.tool('parent', { name: 'task', status: 'running' }, {});
    assert.notEqual(current.resolveTranscriptParent(secondContext, 'parent'), oldParent);
    secondObserver.text('message', 'same-native-ref', 'second turn content', 'replace', 'final');
    const pending = approval(current);
    f.manager.answerPermission(pending.requestId, { sessionId: row.sessionId,
        turnId: secondContext.turnId, epoch: 2, optionId: 'allow' });
    assert.deepEqual(await pending.answer, { optionId: 'allow' });
    first.outcome.resolve({ ...done, finalText: 'second turn content' });
    await f.terminal(row.sessionId, 2);
    assert.equal(first.closes, 0);
    assert.equal(current.signal.aborted, false);
    const snapshot = f.manager.snapshot(row.sessionId);
    assert.equal(snapshot.items.some(item => item.turnId === secondContext.turnId && item.text === 'second turn content'), true);
    assert.equal(snapshot.items.filter(item => item.kind === 'turn_completed').length, 2);
});

test('nativeStarted without a cursor never falls back to fresh open or replays the consumed key', async t => {
    const f = fixture(t);
    f.providers.claude.handles.push(new NativeHandle(''));
    const row = f.create('claude');
    let startedAtSend: boolean | undefined;
    f.providers.claude.beforeOpen = options => {
        assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
        options.onNativeCursor(null, options.getTurnContext());
        assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
    };
    f.providers.claude.handles[0]!.beforeSend = () => {
        startedAtSend = f.store.readRecord(row.sessionId)?.nativeStarted;
    };
    f.manager.prompt(row.sessionId, prompt);
    await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise;
    assert.equal(startedAtSend, true);
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    assert.equal(f.manager.snapshot(row.sessionId).session.resume.reason, 'resume_unavailable');
    assert.equal(f.manager.prompt(row.sessionId, prompt).duplicate, true);
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'new-key' }), errorCode('resume_unavailable'));
    await assert.rejects(f.manager.attach(row.sessionId), errorCode('resume_unavailable'));
    assert.equal(f.providers.claude.calls.length, 1);
});

for (const failure of ['spawn', 'auth', 'model'] as const) {
    test(`${failure} open failure without native input permits a repaired first-open under a new key only`, async t => {
        const f = fixture(t);
        const row = f.create('claude');
        const provider = f.providers.claude;
        provider.handles.push(new NativeHandle(''));
        provider.beforeOpen = options => {
            options.onNativeCursor(null, options.getTurnContext());
            throw new Error(`${failure} opening failure`);
        };
        const first = f.manager.prompt(row.sessionId, prompt);
        await provider.opened();
        await f.terminal(row.sessionId, 1);
        assert.equal(provider.handles[0]!.closes, 1);
        assert.equal(provider.handles[0]!.sends.length, 0);
        assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
        assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, null);
        assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'failed');
        provider.beforeOpen = null;
        const duplicate = f.manager.prompt(row.sessionId, prompt);
        assert.equal(duplicate.duplicate, true);
        assert.equal(duplicate.receipt.turnId, first.receipt.turnId);
        assert.equal(duplicate.receipt.status, 'failed');
        assert.equal(provider.calls.length, 1);
        f.manager.prompt(row.sessionId, { text: 'retry after repair', clientTurnKey: 'repaired-open' });
        const options = await provider.opened(1);
        const repaired = provider.handles[1]!;
        await repaired.sent.promise;
        assert.equal(options.nativeCursor, null);
        assert.deepEqual(repaired.sends, ['retry after repair']);
        repaired.outcome.resolve(done);
        await f.terminal(row.sessionId, 2);
        assert.equal(f.store.readTurn(row.sessionId, 'repaired-open')?.status, 'completed');
        assert.equal(provider.calls.length, 2);
    });
}

test('cancelled unknown-ID opening can first-open again only after its late handle has closed', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    const provider = f.providers.claude;
    const gate = deferred<void>();
    provider.gate = gate.promise;
    provider.handles.push(new NativeHandle(''));
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    await provider.opened();
    await f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
    assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'after-close' }), errorCode('cleanup_pending'));
    gate.resolve();
    await provider.handles[0]!.closedEvent.promise;
    await yieldEventLoop();
    assert.equal(provider.handles[0]!.sends.length, 0);
    assert.equal(provider.handles[0]!.closes, 1);
    assert.equal(f.manager.prompt(row.sessionId, prompt).receipt.status, 'cancelled');
    provider.gate = null;
    f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'after-close' });
    const options = await provider.opened(1);
    const next = provider.handles[1]!;
    await next.sent.promise;
    assert.equal(options.nativeCursor, null);
    next.outcome.resolve(done);
    await f.terminal(row.sessionId, 2);
});

test('an ID-less send that throws still consumes the key and prevents a fresh-history retry', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    const handle = new NativeHandle('');
    let startedAtSend: boolean | undefined;
    handle.beforeSend = () => {
        startedAtSend = f.store.readRecord(row.sessionId)?.nativeStarted;
        throw new Error('dispatch outcome unknown');
    };
    f.providers.claude.handles.push(handle);
    const original = f.manager.prompt(row.sessionId, prompt);
    await f.providers.claude.opened();
    await f.terminal(row.sessionId, 1);
    assert.equal(startedAtSend, true);
    assert.equal(handle.closes, 1);
    const duplicate = f.manager.prompt(row.sessionId, prompt);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.receipt.turnId, original.receipt.turnId);
    assert.equal(duplicate.receipt.status, 'failed');
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'unsafe-retry' }), errorCode('resume_unavailable'));
    assert.equal(f.store.readTurn(row.sessionId, 'unsafe-retry'), null);
    assert.equal(f.providers.claude.calls.length, 1);
});

test('an actual cursor observed before an open failure is preserved and used for the next explicit resume', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    const provider = f.providers.claude;
    provider.handles.push(new NativeHandle(''));
    provider.beforeOpen = options => {
        const context = options.getTurnContext();
        options.onNativeCursor('observed-native-cursor', context);
        options.onNativeCursor(null, context);
        throw new Error('startup failed after receiving thread identity');
    };
    f.manager.prompt(row.sessionId, prompt);
    await provider.opened();
    await f.terminal(row.sessionId, 1);
    assert.equal(provider.handles[0]!.sends.length, 0);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, true);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'observed-native-cursor');
    provider.beforeOpen = null;
    f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'resume-observed' });
    const options = await provider.opened(1);
    const resumed = provider.handles[1]!;
    await resumed.sent.promise;
    assert.equal(options.nativeCursor, 'observed-native-cursor');
    resumed.outcome.resolve(done);
    await f.terminal(row.sessionId, 2);
});

test('constructor never recovers interrupted rows; explicit recover orphans once and never launches native replay', t => {
    const f = fixture(t);
    const row = f.create();
    const admitted = f.store.admitTurn({ ...prompt, sessionId: row.sessionId });
    const second = new CodeSessionManager({ store: f.store, providers: f.providers, publish: () => {} });
    t.after(() => second.dispose());
    assert.equal(f.store.read(row.sessionId)?.status, 'starting');
    second.recover();
    const snapshot = second.snapshot(row.sessionId);
    assert.equal(snapshot.session.status, 'failed');
    assert.equal(snapshot.session.error?.code, 'orphaned_turn');
    assert.equal(snapshot.items.filter(item => item.kind === 'turn_failed').length, 1);
    second.recover();
    assert.equal(second.snapshot(row.sessionId).sequence, snapshot.sequence);
    assert.equal(second.prompt(row.sessionId, prompt).receipt.turnId, admitted.receipt.turnId);
    assert.equal(second.prompt(row.sessionId, prompt).receipt.status, 'failed');
    assert.equal(f.providers['codex-app'].calls.length, 0);
});

test('database admission failure returns 503 before publication or native execution and releases reservation', async t => {
    const f = fixture(t, { capacity: 1 });
    const row = f.create();
    const count = f.events.length;
    f.db.exec("CREATE TRIGGER reject_turn BEFORE INSERT ON code_turns BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END");
    assert.throws(() => f.manager.prompt(row.sessionId, prompt), errorCode('persistence_failed', 503));
    assert.equal(f.events.length, count);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey), null);
    assert.equal(f.providers['codex-app'].calls.length, 0);
    f.db.exec('DROP TRIGGER reject_turn');
    f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
});

for (const callback of ['text', 'tool', 'close', 'child', 'cursor', 'recorder', 'finish'] as const) {
    test(`persistence failure in ${callback} dominates subsequent native success and cancels only its owned handle`, async t => {
        const f = fixture(t);
        const row = f.create('claude'), other = f.create('cursor');
        f.manager.prompt(row.sessionId, prompt);
        f.manager.prompt(other.sessionId, prompt);
        const options = await f.providers.claude.opened();
        await f.providers.cursor.opened();
        const handle = f.providers.claude.handles[0]!, peer = f.providers.cursor.handles[0]!;
        await Promise.all([handle.sent.promise, peer.sent.promise]);
        const context = options.getTurnContext();
        const observer = options.transcript(context);
        observer.tool('parent-tool', { name: 'task', status: 'running' }, {});
        const parentItemId = options.resolveTranscriptParent(context, 'parent-tool');
        assert.ok(parentItemId);
        const child = options.transcript({ ...context, parentItemId });
        const table = callback === 'cursor' ? 'code_sessions' : 'code_items';
        f.db.exec(`CREATE TRIGGER reject_write BEFORE ${callback === 'cursor' ? 'UPDATE' : 'INSERT'} ON ${table}
            WHEN NEW.session_id = '${row.sessionId}' BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END`);
        if (callback === 'text') observer.text('message', 'a', 'answer', 'replace', 'final');
        if (callback === 'tool') observer.tool('a', { name: 'read', status: 'running' }, {});
        if (callback === 'close') observer.close({ kind: 'turn-end', status: 'done', finalText: 'answer' });
        if (callback === 'child') child.text('message', 'a', 'child answer', 'replace', 'final');
        if (callback === 'cursor') options.onNativeCursor('new-native-id', context);
        if (callback === 'recorder') approval(options);
        handle.outcome.resolve(done);
        await handle.closedEvent.promise;
        assert.throws(() => f.manager.snapshot(row.sessionId), errorCode('persistence_failed', 503));
        assert.equal(handle.closes, 1);
        assert.equal(peer.cancellations, 0);
        assert.equal(f.store.snapshot(row.sessionId).items.some(item => item.kind === 'turn_completed'), false);
        assert.equal(f.events.some(event => event.sessionId === row.sessionId && event.item?.kind === 'turn_completed'), false);
        f.db.exec('DROP TRIGGER reject_write');
        peer.outcome.resolve(done);
        await f.terminal(other.sessionId, 1);
    });
}

test('subscriber exceptions never become persistence failures or prevent committed terminal events', async t => {
    const f = fixture(t, { publish: () => { throw new Error('subscriber error'); } });
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    options.transcript(options.getTurnContext()).text('message', 'a', 'stored content', 'replace', 'final');
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    assert.equal(f.manager.snapshot(row.sessionId).session.status, 'idle');
    assert.equal(f.manager.snapshot(row.sessionId).items.some(item => item.text === 'stored content'), true);
});

for (const quotaCode of ['transcript_limit', 'event_too_large'] as const) {
    test(`${quotaCode} from the item commit fails the turn without poisoning reads or the next explicit resume`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
        const f = fixture(t);
        const row = f.create('claude');
        const originalCommit = f.store.commitItem.bind(f.store);
        let exhausted = false;
        // Exercise the service's typed Store boundary; byte accounting belongs to Store tests.
        const fault = t.mock.method(f.store, 'commitItem', (...args: Parameters<CodeStore['commitItem']>) => {
            if (exhausted && args[0].sessionId === row.sessionId && args[1].kind === 'assistant_message') {
                throw new CodeStoreError(quotaCode, 'Ordinary event byte budget exceeded', 409);
            }
            return originalCommit(...args);
        });
        const { receipt } = f.manager.prompt(row.sessionId, prompt);
        const options = await f.providers.claude.opened();
        const handle = f.providers.claude.handles[0]!;
        await handle.sent.promise;
        const observer = options.transcript(options.getTurnContext());
        observer.text('message', 'answer', 'retained answer', 'replace', 'final');
        exhausted = true;
        observer.text('message', 'answer', ' beyond the byte budget', 'append', 'final');
        t.mock.timers.tick(50);
        assert.doesNotThrow(() => f.manager.snapshot(row.sessionId));
        handle.outcome.resolve(done);
        await f.terminal(row.sessionId, 1);
        const failed = f.manager.snapshot(row.sessionId);
        assert.equal(failed.session.status, 'failed');
        assert.equal(failed.session.error?.code, 'transcript_limit');
        assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'failed');
        assert.equal(f.events.some(event => event.item?.turnId === receipt.turnId && event.item.kind === 'turn_completed'), false);
        assert.equal(f.manager.prompt(row.sessionId, prompt).duplicate, true);
        assert.equal(handle.closes, 1);
        exhausted = false;
        fault.mock.restore();
        f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'after-budget-repair' });
        const resumedOptions = await f.providers.claude.opened(1);
        const resumed = f.providers.claude.handles[1]!;
        await resumed.sent.promise;
        assert.equal(resumedOptions.nativeCursor, 'private-native-cursor');
        resumed.outcome.resolve(done);
        await f.terminal(row.sessionId, 2);
        assert.equal(f.manager.snapshot(row.sessionId).session.error, null);
        assert.equal(f.store.readTurn(row.sessionId, 'after-budget-repair')?.status, 'completed');
    });
}

for (const budget of ['event', 'turn'] as const) {
    test(`real ${budget} byte exhaustion uses the terminal reserve and allows a new small turn`, async t => {
        const f = fixture(t, { storeLimits: budget === 'event'
            ? { maxEventBytes: 4096, maxTurnEventBytes: 65536 }
            : { maxEventBytes: 16384, maxTurnEventBytes: 8192 } });
        const row = f.create();
        const { receipt } = f.manager.prompt(row.sessionId, prompt);
        const options = await f.providers['codex-app'].opened();
        const handle = f.providers['codex-app'].handles[0]!;
        await handle.sent.promise;
        options.transcript(options.getTurnContext()).text('message', 'large', 'x'.repeat(12000), 'replace', 'final');
        handle.outcome.resolve(done);
        await f.terminal(row.sessionId, 1);
        const failed = f.manager.snapshot(row.sessionId);
        assert.equal(failed.session.status, 'failed');
        assert.equal(failed.session.error?.code, 'transcript_limit');
        assert.equal(failed.items.some(item => item.turnId === receipt.turnId && item.kind === 'turn_failed'), true);
        assert.equal(f.events.some(event => event.item?.turnId === receipt.turnId && event.item.kind === 'turn_completed'), false);
        f.manager.prompt(row.sessionId, { text: 'small follow-up', clientTurnKey: 'small-turn' });
        const resumedOptions = await f.providers['codex-app'].opened(1);
        const resumed = f.providers['codex-app'].handles[1]!;
        await resumed.sent.promise;
        assert.equal(resumedOptions.nativeCursor, 'private-native-cursor');
        resumed.outcome.resolve(done);
        await f.terminal(row.sessionId, 2);
        assert.equal(f.store.readTurn(row.sessionId, 'small-turn')?.status, 'completed');
    });
}

test('a real DB failure settling a quota failure still poisons the affected session', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    const originalCommit = f.store.commitItem.bind(f.store);
    t.mock.method(f.store, 'commitItem', (...args: Parameters<CodeStore['commitItem']>) => {
        if (args[1].kind === 'assistant_message') throw new CodeStoreError('transcript_limit', 'Byte budget exceeded', 409);
        return originalCommit(...args);
    });
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise;
    f.db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE OF status ON code_turns BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END");
    options.transcript(options.getTurnContext()).text('message', 'answer', 'over budget', 'replace', 'final');
    handle.outcome.resolve(done);
    await assert.rejects(f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 }), errorCode('persistence_failed', 503));
    assert.throws(() => f.manager.snapshot(row.sessionId), errorCode('persistence_failed', 503));
    assert.equal(f.events.some(event => event.item?.kind === 'turn_completed'), false);
});

test('production sessions coalesce updates for 50ms and finish flushes pending text before its terminal commit', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const f = fixture(t);
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    const observer = options.transcript(options.getTurnContext());
    const readText = () => f.manager.snapshot(row.sessionId).items.find(item => item.kind === 'assistant_message')?.text;
    observer.text('message', 'answer', 'A', 'replace', 'final');
    observer.text('message', 'answer', 'B', 'append', 'final');
    observer.text('message', 'answer', 'C', 'append', 'final');
    assert.equal(readText(), 'A');
    t.mock.timers.tick(49);
    assert.equal(readText(), 'A');
    t.mock.timers.tick(1);
    assert.equal(readText(), 'ABC');
    observer.text('message', 'answer', 'D', 'append', 'final');
    assert.equal(readText(), 'ABC');
    handle.outcome.resolve({ ...done, finalText: 'ABCD' });
    await f.terminal(row.sessionId, 1);
    assert.equal(readText(), 'ABCD');
    const lastItem = f.events.findLastIndex(event => event.item?.kind === 'assistant_message');
    const terminal = f.events.findIndex(event => event.item?.kind === 'turn_completed');
    assert.ok(lastItem < terminal);
    const committed = f.events.length;
    t.mock.timers.tick(100);
    assert.equal(f.events.length, committed);
});

test('pending permission labels redact embedded JSON secrets without changing opaque option answers', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    await f.providers.claude.handles[0]!.sent.promise;
    const context = options.getTurnContext();
    const pending = options.registry.open({ ...context, requestType: 'approval', isCurrent: context.isCurrent,
        cancelled: { optionId: null as string | null },
        view: {
            title: 'Review configuration\n```json\n{"token":"title-sensitive-value"}\n```',
            fields: [{ id: 'decision',
                label: 'Details\n```json\n{"password":"detail-sensitive-value"}\n```',
                multiSelect: false, allowFreeform: false,
                options: [{ id: 'opaque-allow',
                    label: 'Allow once\n```json\n{"apiKey":"option-sensitive-value"}\n```' }] }],
        },
        validate(value: unknown) {
            assert.deepEqual(value, { optionId: 'opaque-allow' });
            return { optionId: 'opaque-allow' };
        },
    });
    const snapshot = f.manager.snapshot(row.sessionId);
    assert.equal(snapshot.pendingPermissions.length, 1);
    assert.deepEqual(snapshot.pendingPermissions[0]?.options.map(option => option.optionId), ['opaque-allow']);
    assert.doesNotMatch(JSON.stringify(snapshot.pendingPermissions), /title-sensitive-value|detail-sensitive-value|option-sensitive-value/);
    assert.doesNotMatch(JSON.stringify(snapshot.items), /title-sensitive-value|detail-sensitive-value|option-sensitive-value/);
    assert.doesNotMatch(JSON.stringify(f.events), /title-sensitive-value|detail-sensitive-value|option-sensitive-value/);
    f.manager.answerPermission(pending.requestId, { sessionId: row.sessionId, turnId: context.turnId,
        epoch: context.epoch, optionId: 'opaque-allow' });
    assert.deepEqual(await pending.answer, { optionId: 'opaque-allow' });
});

test('policy patch closes idle runtime and resumes the same cursor with the complete updated tuple', async t => {
    const f = fixture(t);
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, permissionMode: 'auto' }), errorCode('session_busy'));
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const patched = await f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b', effort: 'high', permissionMode: 'auto' });
    assert.equal(handle.closes, 1);
    const attaching = f.manager.attach(row.sessionId);
    const options = await f.providers['codex-app'].opened(1);
    const attached = await attaching;
    assert.equal(attached.status, 'idle');
    assert.equal(options.nativeCursor, 'private-native-cursor');
    assert.equal(options.model, 'model-b');
    assert.equal(options.effort, 'high');
    assert.equal(options.permissionMode, 'auto');
    assert.equal(f.providers['codex-app'].handles[1]?.sends.length, 0);
    assert.equal(attached.revision, patched.revision);
    assert.equal(f.providers['codex-app'].calls.length, 2);
    f.manager.prompt(row.sessionId, { text: 'after policy change', clientTurnKey: 'new-policy' });
    const resumed = f.providers['codex-app'].handles[1]!;
    await resumed.sent.promise;
    assert.equal(f.providers['codex-app'].calls.length, 2);
    resumed.outcome.resolve(done);
    await f.terminal(row.sessionId, 4);
});

test('rename revision race rejects stale metadata and archive preserves history while rejecting prompt/attach', async t => {
    const f = fixture(t);
    const row = f.create();
    const first = f.manager.patch(row.sessionId, { expectedRevision: 0, title: 'chosen title' });
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, title: 'stale title' }), errorCode('revision_conflict'));
    const renamed = await first;
    const archived = await f.manager.patch(row.sessionId, { expectedRevision: renamed.revision, archived: true });
    assert.equal(f.manager.snapshot(row.sessionId).session.title, 'chosen title');
    assert.ok(archived.archivedAt);
    assert.throws(() => f.manager.prompt(row.sessionId, prompt), errorCode('session_archived'));
    await assert.rejects(f.manager.attach(row.sessionId), errorCode('session_archived'));
    assert.equal(f.manager.list({ archived: true }).length, 1);
    assert.equal(f.providers['codex-app'].calls.length, 0);
});

test('unsupported model, effort and permission mode fail before provider open', async t => {
    const f = fixture(t);
    assert.throws(() => f.create('cursor', { model: 'unknown' }), errorCode('unsupported_model', 400));
    assert.throws(() => f.create('cursor', { effort: 'unknown' }), errorCode('unsupported_effort', 400));
    assert.throws(() => f.create('grok', { permissionMode: 'read-only' }), errorCode('unsupported_policy', 400));
    const row = f.create('cursor');
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: 0, permissionMode: 'read-only' }), errorCode('unsupported_policy'));
    assert.equal(f.providers.cursor.calls.length, 0);
});

test('dispose is idempotent during pending open and later closes orphaned startup without replay', async t => {
    const f = fixture(t);
    const gate = deferred<void>();
    f.providers.claude.gate = gate.promise;
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const first = f.manager.dispose();
    assert.equal(f.manager.dispose(), first);
    await first;
    assert.equal(options.signal.aborted, true);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'cancelled');
    assert.throws(() => f.manager.prompt(row.sessionId, prompt), errorCode('manager_disposed'));
    gate.resolve();
    const handle = f.providers.claude.handles[0]!;
    await handle.closedEvent.promise;
    assert.equal(handle.closes, 1);
    assert.deepEqual(handle.sends, []);
});

test('idle reap closes only resident idle handles and retains transcript and cursor', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { idleReapMs: 100 });
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const before = f.manager.snapshot(row.sessionId);
    t.mock.timers.tick(100);
    await handle.closedEvent.promise;
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'private-native-cursor');
    assert.deepEqual(f.manager.snapshot(row.sessionId).items, before.items);
});

test('cleanup timeout retains capacity and prevents overlapping reopen until physical close', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { capacity: 1 });
    const gate = deferred<void>();
    const row = f.create(), other = f.create('claude');
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.closeGate = gate.promise;
    const cancelling = f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
    await handle.closeCalled.promise;
    t.mock.timers.tick(4000);
    await cancelling;
    assert.equal(handle.alive, true);
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'no-overlap' }), errorCode('cleanup_pending'));
    assert.equal(f.store.readTurn(row.sessionId, 'no-overlap'), null);
    gate.resolve();
    await handle.closedEvent.promise;
    assert.equal(handle.closes, 1);
});

for (const reconcileAt of ['snapshot', 'same-session', 'other-session'] as const) {
    test(`late closed proof after a rejected close releases ${reconcileAt} admission without clearing the stored failure`, async t => {
        const f = fixture(t, { capacity: 1 });
        const row = f.create(), other = f.create('claude');
        f.manager.prompt(row.sessionId, prompt);
        await f.providers['codex-app'].opened();
        const handle = f.providers['codex-app'].handles[0]!;
        await handle.sent.promise;
        const close = deferred<void>();
        handle.closeGate = close.promise;
        handle.outcome.resolve({ ...done, status: 'error' });
        await handle.closeCalled.promise;
        handle.alive = false;
        close.reject(new Error('native drain incomplete'));
        await f.terminal(row.sessionId, 1);
        // Keep a disposed owner too: checking `closing` before reconciliation would block forever.
        await f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b' });
        const failed = f.manager.snapshot(row.sessionId);
        assert.equal(failed.session.status, 'failed');
        assert.equal(failed.session.error?.code, 'native_failed');
        assert.equal(handle.closed, false);
        assert.equal(handle.alive, false);
        assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'late-retry' }), errorCode('session_closing'));
        assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
        assert.equal(f.store.readTurn(row.sessionId, 'late-retry'), null);
        assert.equal(f.store.readTurn(other.sessionId, prompt.clientTurnKey), null);
        const eventCount = f.events.length;
        // No callback and no timer: the next existing read/admission observes the native receipt.
        handle.closed = true;
        if (reconcileAt === 'snapshot') {
            assert.deepEqual(f.manager.snapshot(row.sessionId), failed);
            assert.equal(f.events.length, eventCount);
        }
        const target = reconcileAt === 'other-session' ? other : row;
        const provider = reconcileAt === 'other-session' ? f.providers.claude : f.providers['codex-app'];
        const index = reconcileAt === 'other-session' ? 0 : 1;
        f.manager.prompt(target.sessionId, { ...prompt, clientTurnKey: 'late-retry' });
        const options = await provider.opened(index);
        const next = provider.handles[index]!;
        await next.sent.promise;
        assert.equal(options.nativeCursor, reconcileAt === 'other-session' ? null : 'private-native-cursor');
        assert.equal(handle.closes, 1, 'the rejected native close is never retried or relabelled');
        if (reconcileAt === 'other-session') assert.deepEqual(f.manager.snapshot(row.sessionId), failed);
        next.outcome.resolve(done);
        await f.terminal(target.sessionId, reconcileAt === 'other-session' ? 1 : 3);
    });
}

test('a returned handle is registered even without an early callback and requires physical close proof', async t => {
    const f = fixture(t, { capacity: 1 });
    f.providers['codex-app'].registerBeforeOpen = false;
    const row = f.create(), other = f.create('claude');
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.completeClose = false;
    await f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
    assert.equal(handle.alive, false);
    assert.equal(handle.closed, false);
    assert.equal(handle.closes, 1);
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'still-draining' }), errorCode('cleanup_pending'));
    handle.closed = true;
    f.manager.prompt(other.sessionId, prompt);
    await f.providers.claude.opened();
    assert.equal(handle.closes, 1);
});

test('open rejection plus failed cleanup retains its preregistered resource until late physical exit', async t => {
    const f = fixture(t, { capacity: 1 });
    const row = f.create(), other = f.create('claude');
    const provider = f.providers['codex-app'];
    const resource = new NativeHandle('');
    const drain = deferred<void>();
    resource.closeGate = drain.promise;
    provider.handles.push(resource);
    provider.beforeOpen = () => { throw new Error('native initialization failed'); };
    const admitted = f.manager.prompt(row.sessionId, prompt);
    await provider.opened();
    await resource.closeCalled.promise;
    drain.reject(new Error('native cleanup deadline expired'));
    await f.terminal(row.sessionId, 1);
    assert.equal(resource.closed, false);
    assert.equal(resource.sends.length, 0);
    assert.equal(resource.closes, 1);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeStarted, false);
    const failed = f.manager.snapshot(row.sessionId);
    assert.equal(failed.session.status, 'failed');
    const duplicate = f.manager.prompt(row.sessionId, prompt);
    assert.equal(duplicate.receipt.turnId, admitted.receipt.turnId);
    assert.equal(duplicate.receipt.status, 'failed');
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    assert.throws(() => f.manager.prompt(row.sessionId, { ...prompt, clientTurnKey: 'too-early' }), errorCode('cleanup_pending'));
    assert.equal(f.store.readTurn(other.sessionId, prompt.clientTurnKey), null);
    resource.closed = true;
    f.manager.prompt(other.sessionId, prompt);
    await f.providers.claude.opened();
    assert.deepEqual(f.manager.snapshot(row.sessionId), failed);
    assert.equal(resource.closes, 1);
    assert.equal(provider.calls.length, 1);
});

test('late onResource after cancellation closes only the owned resource and waits for all startup receipts', async t => {
    const f = fixture(t, { capacity: 1 });
    const row = f.create(), other = f.create('claude');
    const provider = f.providers['codex-app'];
    const opening = deferred<void>();
    provider.gate = opening.promise;
    const startup = new NativeHandle('');
    startup.completeClose = false;
    provider.handles.push(startup);
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    const options = await provider.opened();
    await f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
    assert.equal(startup.closed, false, 'a pre-start resource is not already drained');
    const late = new NativeHandle('');
    const drain = deferred<void>();
    late.closeGate = drain.promise;
    const registered: CodeRuntimeResource = late;
    options.onResource(registered);
    options.onResource(registered);
    await late.closeCalled.promise;
    assert.equal(late.closes, 1);
    assert.equal(late.sends.length, 0);
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    opening.resolve();
    await yieldEventLoop();
    startup.closed = true;
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    drain.resolve();
    await late.closedEvent.promise;
    await yieldEventLoop();
    f.manager.prompt(other.sessionId, prompt);
    await f.providers.claude.opened();
    assert.equal(startup.closes, 1);
    assert.equal(startup.sends.length, 0);
    assert.equal(late.closes, 1);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'cancelled');
});

test('a closed successful handle cannot release capacity while another registered resource is undrained', async t => {
    const f = fixture(t, { capacity: 1 });
    const row = f.create(), other = f.create('claude');
    const childResource = new NativeHandle('');
    childResource.completeClose = false;
    f.providers['codex-app'].beforeOpen = options => options.onResource(childResource);
    f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve({ ...done, status: 'error' });
    await f.terminal(row.sessionId, 1);
    assert.equal(handle.closed, true);
    assert.equal(childResource.closed, false);
    assert.equal(childResource.closes, 1);
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    childResource.closed = true;
    f.manager.prompt(other.sessionId, prompt);
    await f.providers.claude.opened();
    assert.equal(childResource.closes, 1);
});

test('observer failure during open aborts startup and retires the returned handle without calling send', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.db.exec(`CREATE TRIGGER reject_assistant BEFORE INSERT ON code_items
        WHEN json_extract(NEW.item_json, '$.kind') = 'assistant_message'
        BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END`);
    f.providers.claude.beforeOpen = options => {
        options.transcript(options.getTurnContext()).text('message', 'startup', 'content', 'replace', 'commentary');
    };
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.closedEvent.promise;
    await f.terminal(row.sessionId, 1);
    assert.equal(options.signal.aborted, true);
    assert.equal(handle.sends.length, 0);
    assert.equal(handle.closes, 1);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'failed');
    assert.equal(f.manager.snapshot(row.sessionId).session.error?.code, 'persistence_failed');
});

test('attach reserves capacity before await and rejected resume keeps history without fresh fallback', async t => {
    const f = fixture(t, { capacity: 1 });
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const before = f.manager.snapshot(row.sessionId).items;
    await f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-b' });
    const gate = deferred<void>();
    f.providers['codex-app'].gate = gate.promise;
    const attaching = f.manager.attach(row.sessionId);
    const options = await f.providers['codex-app'].opened(1);
    const other = f.create('claude');
    assert.throws(() => f.manager.prompt(other.sessionId, prompt), errorCode('session_capacity'));
    assert.equal(options.nativeCursor, 'private-native-cursor');
    gate.reject(new Error('resume rejected'));
    const failed = await attaching;
    assert.equal(failed.status, 'failed');
    assert.deepEqual(f.manager.snapshot(row.sessionId).items, before);
    assert.equal(f.providers['codex-app'].calls.length, 2);
    assert.equal(f.providers['codex-app'].handles[1]?.sends.length, 0);
});

test('rename during slow open keeps its revision/title and cannot change the captured native policy', async t => {
    const f = fixture(t);
    const gate = deferred<void>();
    f.providers.cursor.gate = gate.promise;
    const row = f.create('cursor');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.cursor.opened();
    const renamed = await f.manager.patch(row.sessionId, { expectedRevision: 0, title: 'user title' });
    await assert.rejects(f.manager.patch(row.sessionId, { expectedRevision: renamed.revision, model: 'model-b' }), errorCode('session_busy'));
    gate.resolve();
    const handle = f.providers.cursor.handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    assert.equal(options.model, 'model-a');
    assert.equal(options.permissionMode, 'ask');
    assert.equal(f.manager.snapshot(row.sessionId).session.title, 'user title');
    assert.equal(f.manager.snapshot(row.sessionId).session.revision, 1);
});

test('dispose resolves pending approvals and settles despite a native send that never resolves', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise;
    const pending = approval(options);
    await f.manager.dispose();
    assert.deepEqual(await pending.answer, { optionId: null });
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'cancelled');
    assert.equal(handle.closes, 1);
    assert.deepEqual(options.registry.list(row.sessionId), []);
});

test('a cancel requested from final-item publication still cleans up before cancelled terminal commit', async t => {
    let cancelAtFinal: (() => void) | null = null;
    const f = fixture(t, { publish(event) {
        if (event.item?.kind === 'assistant_message') cancelAtFinal?.();
    } });
    const row = f.create();
    const { receipt } = f.manager.prompt(row.sessionId, prompt);
    await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    const cancelled = deferred<void>();
    cancelAtFinal = () => {
        cancelAtFinal = null;
        void f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 }).then(
            () => cancelled.resolve(), error => cancelled.reject(error));
    };
    handle.outcome.resolve(done);
    await cancelled.promise;
    assert.equal(handle.alive, false);
    assert.equal(handle.closes, 1);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'cancelled');
    assert.equal(f.events.some(event => event.item?.kind === 'turn_completed'), false);
});

for (const ending of ['cancel', 'native-error', 'native-stop', 'exit'] as const) {
    test(`${ending} retires the owned handle and the next prompt opens a fresh binding with the same native cursor`, async t => {
        const f = fixture(t);
        const row = f.create();
        const { receipt } = f.manager.prompt(row.sessionId, prompt);
        const old = await f.providers['codex-app'].opened();
        const first = f.providers['codex-app'].handles[0]!;
        await first.sent.promise;
        const captured = old.getTurnContext();
        if (ending === 'cancel') await f.manager.cancel(row.sessionId, { turnId: receipt.turnId, epoch: 1 });
        if (ending === 'native-error') first.outcome.resolve({ ...done, status: 'error' });
        if (ending === 'native-stop') first.outcome.resolve({ ...done, status: 'stopped' });
        if (ending === 'exit') old.onExit(new Error('native exit'));
        await f.terminal(row.sessionId, 1);
        assert.equal(first.closes, 1);
        assert.equal(old.signal.aborted, true);
        f.manager.prompt(row.sessionId, { text: 'continue explicitly', clientTurnKey: 'new-run' });
        const current = await f.providers['codex-app'].opened(1);
        const second = f.providers['codex-app'].handles[1]!;
        await second.sent.promise;
        assert.equal(f.providers['codex-app'].calls.length, 2);
        assert.equal(current.nativeCursor, 'private-native-cursor');
        const currentContext = current.getTurnContext();
        const before = f.store.snapshot(row.sessionId).sequence;
        old.onNativeCursor('old-binding-with-current-context', currentContext);
        old.transcript(currentContext).text('message', 'foreign', 'foreign content', 'replace', 'final');
        assert.equal(old.record(currentContext, { kind: 'usage', inputTokens: 10 }), null);
        assert.equal(old.record(captured, { kind: 'usage', inputTokens: 20 }), null);
        assert.throws(() => old.getTurnContext(), errorCode('stale_owner'));
        old.onExit(new Error('late exit from replaced handle'));
        assert.equal(f.store.snapshot(row.sessionId).sequence, before);
        assert.equal(second.cancellations, 0);
        assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'private-native-cursor');
        second.outcome.resolve(done);
        await f.terminal(row.sessionId, 2);
    });
}

test('native exit on a reused handle fails its current second turn and leaves the first terminal intact', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    f.manager.prompt(row.sessionId, { text: 'second turn', clientTurnKey: 'second-key' });
    await handle.waitSent(1);
    options.onExit(new Error('resident process exited'));
    await f.terminal(row.sessionId, 2);
    assert.equal(f.providers.claude.calls.length, 1);
    assert.equal(handle.closes, 1);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'completed');
    assert.equal(f.store.readTurn(row.sessionId, 'second-key')?.status, 'failed');
    assert.equal(f.manager.snapshot(row.sessionId).session.error?.code, 'native_exit');
});

test('observer persistence failure on a reused handle cannot target the old turn or publish second-turn success', async t => {
    const f = fixture(t);
    const row = f.create('claude');
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers.claude.opened();
    const handle = f.providers.claude.handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const { receipt } = f.manager.prompt(row.sessionId, { text: 'second turn', clientTurnKey: 'second-key' });
    await handle.waitSent(1);
    f.db.exec(`CREATE TRIGGER reject_second_assistant BEFORE INSERT ON code_items
        WHEN json_extract(NEW.item_json, '$.kind') = 'assistant_message'
        BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END`);
    options.transcript(options.getTurnContext()).text('message', 'a', 'lost answer', 'replace', 'final');
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 2);
    assert.equal(f.providers.claude.calls.length, 1);
    assert.equal(handle.closes, 1);
    assert.equal(f.store.readTurn(row.sessionId, prompt.clientTurnKey)?.status, 'completed');
    assert.equal(f.store.readTurn(row.sessionId, 'second-key')?.status, 'failed');
    assert.equal(f.events.some(event => event.item?.turnId === receipt.turnId && event.item.kind === 'turn_completed'), false);
});

test('a no-op policy patch retains the handle and idle exit follows the updated metadata epoch', async t => {
    const f = fixture(t);
    const row = f.create();
    f.manager.prompt(row.sessionId, prompt);
    const options = await f.providers['codex-app'].opened();
    const handle = f.providers['codex-app'].handles[0]!;
    await handle.sent.promise;
    handle.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const patched = await f.manager.patch(row.sessionId, { expectedRevision: 0, model: 'model-a' });
    assert.equal(handle.closes, 0);
    options.onExit(new Error('idle exit'));
    await handle.closedEvent.promise;
    assert.equal(f.manager.snapshot(row.sessionId).session.epoch, patched.epoch);
    assert.equal(f.manager.snapshot(row.sessionId).session.error?.code, 'native_exit');
});

test('shared defaults admit four residents and idle eviction at 30000ms releases capacity without deleting history', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const f = fixture(t, { defaults: true });
    const rows = Array.from({ length: 5 }, () => f.create());
    for (const row of rows.slice(0, 4)) f.manager.prompt(row.sessionId, prompt);
    const provider = f.providers['codex-app'];
    await Promise.all([0, 1, 2, 3].map(index => provider.opened(index)));
    await Promise.all(provider.handles.map(handle => handle.sent.promise));
    const first = provider.handles[0]!;
    const row = rows[0]!, fifth = rows[4]!;
    first.outcome.resolve(done);
    await f.terminal(row.sessionId, 1);
    const history = f.manager.snapshot(row.sessionId).items;
    assert.throws(() => f.manager.prompt(fifth.sessionId, prompt), errorCode('session_capacity'));
    t.mock.timers.tick(29_999);
    assert.equal(first.closes, 0);
    t.mock.timers.tick(1);
    await first.closedEvent.promise;
    // Drain the completed close continuation, without advancing wall-clock time.
    await yieldEventLoop();
    assert.equal(first.closes, 1);
    assert.deepEqual(f.manager.snapshot(row.sessionId).items, history);
    assert.equal(f.store.readRecord(row.sessionId)?.nativeCursor, 'private-native-cursor');
    f.manager.prompt(fifth.sessionId, prompt);
    await provider.opened(4);
    assert.equal(provider.calls.length, 5);
});
