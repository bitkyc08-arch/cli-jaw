import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_TERMINAL_SESSIONS,
    PRE_BIND_BUFFER_CAP,
    TerminalSessionController,
    terminalTargetMatches,
    type TerminalRuntime,
    type TerminalRuntimeFactory,
    type TerminalSessionSnapshot,
} from '../../public/dashboard2/src/shell/panels/terminal-session-state.ts';
import {
    initialTerminalRequestLedger,
    dispatchTerminalShortcutIntent,
    normalizeTerminalShortcutAction,
    terminalRequestLedgerReducer,
} from '../../public/dashboard2/src/shell/panels/terminal-session-requests.ts';
import type { TerminalBridgeApi } from '../../public/dashboard2/src/providers/desktop-bridge-contract.ts';

type CreateResult = Awaited<ReturnType<TerminalBridgeApi['create']>>;
type ListResult = Awaited<ReturnType<TerminalBridgeApi['list']>>;

class FakeRuntime implements TerminalRuntime {
    readonly writes: string[] = [];
    readonly lines: string[] = [];
    opened = false;
    focused = 0;
    cleared = 0;
    disposed = false;
    fitResult: { cols: number; rows: number } | null = { cols: 90, rows: 30 };

    constructor(
        readonly key: string,
        readonly onInput: (data: string) => void,
        private readonly order: string[],
    ) {}

    open(): void { this.opened = true; }
    write(data: string): void { this.writes.push(data); }
    writeln(data: string): void { this.lines.push(data); }
    clear(): void { this.cleared += 1; }
    focus(): void { this.focused += 1; }
    fit(): { cols: number; rows: number } | null { return this.fitResult; }
    dispose(): void {
        this.disposed = true;
        this.order.push(`dispose:${this.key}`);
    }
}

class FakeTerminalBridge implements TerminalBridgeApi {
    readonly createCalls: Array<{ cwd?: string; cols?: number; rows?: number; port?: number | null }> = [];
    readonly writes: Array<{ id: string; data: string }> = [];
    readonly resizes: Array<{ id: string; cols: number; rows: number }> = [];
    readonly kills: string[] = [];
    readonly order: string[] = [];
    beforeKill: ((id: string) => void) | null = null;
    private readonly pendingCreates: Array<(result: CreateResult) => void> = [];
    private readonly dataListeners = new Set<(id: string, data: string, seq?: number) => void>();
    private readonly exitListeners = new Set<(id: string, code: number | null) => void>();

    listImpl: (() => Promise<ListResult>) | null = null;
    readonly listCalls: number[] = [];

    async list(): Promise<ListResult> {
        this.listCalls.push(this.listCalls.length);
        if (this.listImpl) return this.listImpl();
        return { ok: true, sessions: [] };
    }

    create(opts: { cwd?: string; cols?: number; rows?: number; port?: number | null } = {}): Promise<CreateResult> {
        this.createCalls.push(opts);
        return new Promise((resolve) => this.pendingCreates.push(resolve));
    }

    async write(id: string, data: string): Promise<void> {
        this.writes.push({ id, data });
    }

    async resize(id: string, cols: number, rows: number): Promise<void> {
        this.resizes.push({ id, cols, rows });
    }

    async kill(id: string): Promise<void> {
        this.kills.push(id);
        this.order.push(`kill:${id}`);
        this.beforeKill?.(id);
    }

    onData(callback: (id: string, data: string, seq?: number) => void): () => void {
        this.dataListeners.add(callback);
        return () => this.dataListeners.delete(callback);
    }

    onExit(callback: (id: string, code: number | null) => void): () => void {
        this.exitListeners.add(callback);
        return () => this.exitListeners.delete(callback);
    }

    emitData(id: string, data: string, seq?: number): void {
        for (const listener of this.dataListeners) listener(id, data, seq);
    }

    emitExit(id: string, code: number | null): void {
        for (const listener of this.exitListeners) listener(id, code);
    }

    resolveNext(result: CreateResult): void {
        const resolve = this.pendingCreates.shift();
        assert.ok(resolve, 'expected a pending terminal:create call');
        resolve(result);
    }
}

function createHarness(): {
    bridge: FakeTerminalBridge;
    controller: TerminalSessionController;
    runtimes: Map<string, FakeRuntime>;
    snapshots: TerminalSessionSnapshot[];
} {
    const bridge = new FakeTerminalBridge();
    const runtimes = new Map<string, FakeRuntime>();
    const runtimeFactory: TerminalRuntimeFactory = (key, onInput) => {
        const runtime = new FakeRuntime(key, onInput, bridge.order);
        runtimes.set(key, runtime);
        return runtime;
    };
    const controller = new TerminalSessionController(bridge, runtimeFactory);
    const snapshots: TerminalSessionSnapshot[] = [];
    controller.subscribe((snapshot) => snapshots.push(snapshot));
    return { bridge, controller, runtimes, snapshots };
}

async function flushCreates(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

test('terminalNewTab request ledger preserves batched and unopened requests', () => {
    let ledger = initialTerminalRequestLedger;
    ledger = terminalRequestLedgerReducer(ledger, { type: 'issue' });
    ledger = terminalRequestLedgerReducer(ledger, { type: 'issue' });
    ledger = terminalRequestLedgerReducer(ledger, { type: 'issue' });
    assert.deepEqual(ledger, { newTab: { issued: 3, consumed: 0 }, focus: { issued: 0, consumed: 0 } });
    assert.equal(ledger.newTab.issued - ledger.newTab.consumed, 3);

    ledger = terminalRequestLedgerReducer(ledger, { type: 'consume-through', token: 2 });
    assert.deepEqual(ledger.newTab, { issued: 3, consumed: 2 });
    ledger = terminalRequestLedgerReducer(ledger, { type: 'consume-through', token: 3 });
    assert.deepEqual(ledger.newTab, { issued: 3, consumed: 3 });
    assert.deepEqual(ledger.focus, { issued: 0, consumed: 0 });
});

test('request ledger keeps focus and new-tab counters independent', () => {
    let ledger = initialTerminalRequestLedger;
    ledger = terminalRequestLedgerReducer(ledger, { type: 'issue-focus' });
    ledger = terminalRequestLedgerReducer(ledger, { type: 'issue-new-tab' });
    assert.deepEqual(ledger.newTab, { issued: 1, consumed: 0 });
    assert.deepEqual(ledger.focus, { issued: 1, consumed: 0 });
    ledger = terminalRequestLedgerReducer(ledger, { type: 'consume-focus-through', token: 1 });
    assert.deepEqual(ledger.focus, { issued: 1, consumed: 1 });
    assert.deepEqual(ledger.newTab, { issued: 1, consumed: 0 });
    ledger = terminalRequestLedgerReducer(ledger, { type: 'consume-new-tab-through', token: 1 });
    assert.deepEqual(ledger.newTab, { issued: 1, consumed: 1 });
});

test('terminal shortcut actions normalize to canonical intents and dispatch side effects', () => {
    assert.equal(normalizeTerminalShortcutAction('focusTerminal'), 'focus');
    assert.equal(normalizeTerminalShortcutAction('newTerminalSession'), 'new-tab');
    assert.equal(normalizeTerminalShortcutAction('terminalNewTab'), 'new-tab');
    assert.equal(normalizeTerminalShortcutAction('terminalClear'), null);
    assert.equal(normalizeTerminalShortcutAction('unrelatedAction'), null);

    const calls: string[] = [];
    const ports = {
        openPanel: () => { calls.push('openPanel'); },
        issueNewTab: () => { calls.push('issueNewTab'); },
        issueFocus: () => { calls.push('issueFocus'); },
    };
    dispatchTerminalShortcutIntent('new-tab', ports);
    assert.deepEqual(calls, ['openPanel', 'issueNewTab']);
    calls.length = 0;
    dispatchTerminalShortcutIntent('focus', ports);
    assert.deepEqual(calls, ['openPanel', 'issueFocus'], 'focus never issues a new session');
});

test('pre-bind data is bounded, early exit is preserved, and non-owned events are discarded', async () => {
    const { bridge, controller, runtimes } = createHarness();
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestNewSessions(1);
    await flushCreates();
    const key = controller.getSnapshot().activeSessionKey!;
    const runtime = runtimes.get(key)!;

    bridge.emitData('foreign-session', 'must-not-leak');
    bridge.emitData('term-a', 'x'.repeat(PRE_BIND_BUFFER_CAP + 32));
    bridge.emitExit('term-a', 7);
    bridge.resolveNext({ ok: true, id: 'term-a', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();

    const session = controller.getSnapshot().sessions[0]!;
    assert.equal(runtime.writes.join('').length, PRE_BIND_BUFFER_CAP);
    assert.equal(runtime.writes.join('').includes('must-not-leak'), false);
    assert.equal(session.status, 'exited');
    assert.equal(session.sessionId, null);
    assert.match(session.message, /code 7/);

    bridge.emitData('foreign-after-bind', 'also-discarded');
    assert.equal(runtime.writes.join('').includes('also-discarded'), false);

    controller.restartSession(key);
    bridge.resolveNext({ ok: true, id: 'term-a2', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();
    assert.equal(controller.getSnapshot().sessions[0]?.key, key);
    assert.equal(controller.getSnapshot().sessions[0]?.status, 'running');
});

test('batched new sessions share cwd and only the active session is resized', async () => {
    const { bridge, controller, runtimes } = createHarness();
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestNewSessions(3);
    await flushCreates();

    for (let index = 1; index <= 3; index += 1) {
        assert.equal(bridge.createCalls.length, index);
        bridge.resolveNext({ ok: true, id: `term-${index}`, shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
        await flushCreates();
    }

    assert.deepEqual(bridge.createCalls.map((call) => call.cwd), [
        '/Users/jun/project-a',
        '/Users/jun/project-a',
        '/Users/jun/project-a',
    ]);
    const sessions = controller.getSnapshot().sessions;
    assert.equal(sessions.length, 3);
    assert.equal(controller.getSnapshot().activeSessionKey, sessions[2]?.key);

    bridge.resizes.length = 0;
    controller.resizeActive();
    assert.deepEqual(bridge.resizes.map((entry) => entry.id), ['term-3']);

    controller.activateSession(sessions[0]!.key);
    controller.resizeActive();
    assert.deepEqual(bridge.resizes.map((entry) => entry.id), ['term-3', 'term-1']);

    runtimes.get(sessions[0]!.key)!.fitResult = null;
    controller.resizeActive();
    assert.deepEqual(bridge.resizes.map((entry) => entry.id), ['term-3', 'term-1']);
});

test('stale cwd-port create is tombstoned and late resolution is killed before the new target starts', async () => {
    const { bridge, controller } = createHarness();
    assert.equal(terminalTargetMatches(3457, { port: 3457, cwd: '/Users/jun/a' }), true);
    assert.equal(terminalTargetMatches(3458, { port: 3457, cwd: '/Users/jun/a' }), false);

    controller.setTarget({ port: 3457, cwd: '/Users/jun/a' });
    controller.requestNewSessions(1);
    await flushCreates();
    controller.setTarget({ port: 3458, cwd: '/Users/jun/b' });
    controller.requestNewSessions(1);
    await flushCreates();
    assert.equal(bridge.createCalls.length, 1, 'a stale create must remain the sole in-flight create');

    bridge.emitData('term-stale', 'stale-output');
    bridge.resolveNext({ ok: true, id: 'term-stale', shell: '/bin/zsh', cwd: '/Users/jun/a' });
    await flushCreates();
    assert.deepEqual(bridge.kills, ['term-stale']);
    assert.equal(bridge.createCalls.length, 2);
    assert.equal(bridge.createCalls[1]?.cwd, '/Users/jun/b');

    bridge.resolveNext({ ok: true, id: 'term-current', shell: '/bin/zsh', cwd: '/Users/jun/b' });
    await flushCreates();
    assert.deepEqual(controller.getSnapshot().sessions.map((session) => session.cwd), ['/Users/jun/b']);
    assert.equal(controller.getSnapshot().sessions[0]?.sessionId, 'term-current');
});

test('close follows tombstone-detach-kill-dispose and drops synchronous late events', async () => {
    const { bridge, controller, runtimes, snapshots } = createHarness();
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestNewSessions(1);
    await flushCreates();
    bridge.resolveNext({ ok: true, id: 'term-a', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();

    const key = controller.getSnapshot().activeSessionKey!;
    const runtime = runtimes.get(key)!;
    bridge.beforeKill = (id) => {
        bridge.order.push(controller.getSnapshot().sessions.length === 0 ? 'detached' : 'still-owned');
        bridge.emitData(id, 'late-after-detach');
    };

    controller.closeSession(key);
    assert.deepEqual(bridge.order.slice(-3), ['kill:term-a', 'detached', `dispose:${key}`]);
    assert.equal(runtime.writes.join('').includes('late-after-detach'), false);
    assert.equal(runtime.disposed, true);
    assert.equal(controller.getSnapshot().sessions.length, 0);
    assert.ok(snapshots.some((snapshot) => snapshot.sessions.length === 0));
});

test('MAX_SESSIONS rejects overflow without evicting existing sessions', async () => {
    const { bridge, controller } = createHarness();
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestNewSessions(MAX_TERMINAL_SESSIONS + 1);
    await flushCreates();

    for (let index = 1; index <= MAX_TERMINAL_SESSIONS; index += 1) {
        bridge.resolveNext({ ok: true, id: `term-${index}`, shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
        await flushCreates();
    }

    const before = controller.getSnapshot().sessions.map((session) => session.key);
    assert.equal(bridge.createCalls.length, MAX_TERMINAL_SESSIONS);
    assert.match(controller.getSnapshot().rejection ?? '', /limit reached/i);
    controller.requestNewSessions(1);
    assert.deepEqual(controller.getSnapshot().sessions.map((session) => session.key), before);
    assert.equal(bridge.createCalls.length, MAX_TERMINAL_SESSIONS);
    assert.deepEqual(bridge.kills, []);
});

test('backend MAX_SESSIONS rejection remains visible on the rejected tab', async () => {
    const { bridge, controller } = createHarness();
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestNewSessions(1);
    await flushCreates();
    bridge.resolveNext({ ok: false, error: 'max sessions reached' });
    await flushCreates();

    assert.equal(controller.getSnapshot().sessions[0]?.status, 'error');
    assert.equal(controller.getSnapshot().sessions[0]?.message, 'max sessions reached');
    assert.match(controller.getSnapshot().rejection ?? '', /limit reached/i);
});

test('keepAlive leaves sessions running until controller disposal, which kills every live PTY', async () => {
    const { bridge, controller } = createHarness();
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestNewSessions(2);
    await flushCreates();
    bridge.resolveNext({ ok: true, id: 'term-1', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();
    bridge.resolveNext({ ok: true, id: 'term-2', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();

    assert.deepEqual(bridge.kills, [], 'hiding a keepAlive panel performs no lifecycle action');
    controller.dispose();
    assert.deepEqual(bridge.kills.sort(), ['term-1', 'term-2']);
});

test('hydrate rebinds same-port sessions with buffer replay and leaves other ports untouched', async () => {
    const { bridge, controller, runtimes } = createHarness();
    bridge.listImpl = async () => ({
        ok: true,
        sessions: [
            { id: 'term-mine', shell: '/bin/zsh', cwd: '/Users/jun/project-a', port: 3457, seq: 4, cols: 90, rows: 30, buffer: 'previous-output' },
            { id: 'term-other', shell: '/bin/zsh', cwd: '/Users/jun/project-b', port: 3458, seq: 1, cols: 90, rows: 30, buffer: 'other' },
        ],
    });
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    await flushCreates();

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0]?.sessionId, 'term-mine');
    assert.equal(snapshot.sessions[0]?.status, 'running');
    const runtime = runtimes.get(snapshot.sessions[0]!.key)!;
    assert.equal(runtime.writes.join(''), 'previous-output');
    assert.equal(bridge.kills.length, 0, 'other-port sessions are never killed or adopted');
    assert.equal(bridge.createCalls.length, 0, 'restored sessions need no create');
});

test('hydrate replays only post-snapshot output using the seq watermark', async () => {
    const { bridge, controller, runtimes } = createHarness();
    let resolveList!: (result: ListResult) => void;
    bridge.listImpl = () => new Promise<ListResult>((resolve) => { resolveList = resolve; });
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    // Output that is already inside the snapshot (seq <= watermark) must not double-replay.
    bridge.emitData('term-mine', 'in-snapshot', 3);
    bridge.emitData('term-mine', 'post-snapshot', 7);
    resolveList({
        ok: true,
        sessions: [
            { id: 'term-mine', shell: '/bin/zsh', cwd: '/Users/jun/project-a', port: 3457, seq: 5, cols: 90, rows: 30, buffer: 'base+in-snapshot' },
        ],
    });
    await flushCreates();

    const session = controller.getSnapshot().sessions[0]!;
    const runtime = runtimes.get(session.key)!;
    assert.equal(runtime.writes.join(''), 'base+in-snapshotpost-snapshot');
});

test('hydrate restores a session that exited between snapshot and rebind as exited, not running', async () => {
    const { bridge, controller } = createHarness();
    let resolveList!: (result: ListResult) => void;
    bridge.listImpl = () => new Promise<ListResult>((resolve) => { resolveList = resolve; });
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    bridge.emitExit('term-mine', 3);
    resolveList({
        ok: true,
        sessions: [
            { id: 'term-mine', shell: '/bin/zsh', cwd: '/Users/jun/project-a', port: 3457, seq: 2, cols: 90, rows: 30, buffer: 'tail' },
        ],
    });
    await flushCreates();

    const session = controller.getSnapshot().sessions[0]!;
    assert.equal(session.status, 'exited');
    assert.equal(session.sessionId, null);
    assert.match(session.message, /code 3/);
});

test('target switch parks without killing and switching back re-hydrates from list', async () => {
    const { bridge, controller } = createHarness();
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestNewSessions(1);
    await flushCreates();
    bridge.resolveNext({ ok: true, id: 'term-a', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();
    assert.equal(controller.getSnapshot().sessions.length, 1);

    controller.setTarget({ port: 3458, cwd: '/Users/jun/project-b' });
    await flushCreates();
    assert.deepEqual(bridge.kills, [], 'park must not kill remote PTYs');
    assert.equal(controller.getSnapshot().sessions.length, 0);

    bridge.listImpl = async () => ({
        ok: true,
        sessions: [
            { id: 'term-a', shell: '/bin/zsh', cwd: '/Users/jun/project-a', port: 3457, seq: 0, cols: 90, rows: 30, buffer: 'back' },
        ],
    });
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    await flushCreates();
    assert.equal(controller.getSnapshot().sessions[0]?.sessionId, 'term-a');
    assert.equal(controller.getSnapshot().sessions[0]?.status, 'running');
    assert.deepEqual(bridge.kills, []);
});

test('detach parks without killing; dispose close-all kills parked owner sessions too', async () => {
    const { bridge, controller } = createHarness();
    bridge.listImpl = async () => ({
        ok: true,
        sessions: [
            { id: 'term-parked', shell: '/bin/zsh', cwd: '/Users/jun/project-b', port: 3458, seq: 0, cols: 90, rows: 30, buffer: '' },
        ],
    });
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    await flushCreates();
    controller.detach();
    assert.deepEqual(bridge.kills, [], 'detach is the unmount path and never kills');

    const { bridge: bridge2, controller: controller2 } = createHarness();
    bridge2.listImpl = async () => ({
        ok: true,
        sessions: [
            { id: 'term-parked', shell: '/bin/zsh', cwd: '/Users/jun/project-b', port: 3458, seq: 0, cols: 90, rows: 30, buffer: '' },
        ],
    });
    controller2.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    await flushCreates();
    controller2.dispose();
    await flushCreates();
    assert.deepEqual(bridge2.kills, ['term-parked'], 'dispose close-all reaches parked sessions');
});

test('owner-wide capacity counts parked sessions and frees on parked exit or explicit close', async () => {
    const { bridge, controller } = createHarness();
    const parked = Array.from({ length: MAX_TERMINAL_SESSIONS - 1 }, (_, index) => ({
        id: `term-parked-${index}`, shell: '/bin/zsh', cwd: '/Users/jun/other',
        port: 3458, seq: 0, cols: 90, rows: 30, buffer: '',
    }));
    bridge.listImpl = async () => ({ ok: true, sessions: parked });
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    await flushCreates();

    controller.requestNewSessions(2);
    await flushCreates();
    assert.match(controller.getSnapshot().rejection ?? '', /parked/);
    assert.equal(bridge.createCalls.length, 1, 'only one slot remains');
    bridge.resolveNext({ ok: true, id: 'term-mine', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();

    controller.requestNewSessions(1);
    assert.match(controller.getSnapshot().rejection ?? '', /limit reached/);

    // A parked session exits on its own while we watch another target: capacity frees.
    bridge.emitExit('term-parked-0', 0);
    controller.requestNewSessions(1);
    await flushCreates();
    assert.equal(bridge.createCalls.length, 2, 'parked exit reopened one slot');
    bridge.resolveNext({ ok: true, id: 'term-mine-2', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();

    // Explicit close frees capacity immediately without waiting for a remote exit.
    const key = controller.getSnapshot().sessions.find(session => session.sessionId === 'term-mine')!.key;
    controller.closeSession(key);
    controller.requestNewSessions(1);
    await flushCreates();
    assert.equal(bridge.createCalls.length, 3, 'explicit close reopened one slot');
});

test('hydrate failure fails closed and an explicit request retries hydration', async () => {
    const { bridge, controller } = createHarness();
    let listCalls = 0;
    bridge.listImpl = async () => {
        listCalls += 1;
        return listCalls === 1 ? { ok: false, error: 'list exploded' } : { ok: true, sessions: [] };
    };
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    await flushCreates();
    assert.equal(controller.getSnapshot().rejection, 'list exploded');

    controller.requestAutoSession();
    await flushCreates();
    assert.equal(bridge.createCalls.length, 0, 'auto-create is suppressed after hydrate failure');

    controller.requestNewSessions(1);
    await flushCreates();
    assert.equal(listCalls, 2, 'explicit intent retries hydration');
    assert.equal(bridge.createCalls.length, 1, 'create resumes after a successful retry');
});

test('hydrate failure clears a pending auto-session from the in-flight ordering', async () => {
    const { bridge, controller } = createHarness();
    let rejectList!: (error: Error) => void;
    bridge.listImpl = () => new Promise<ListResult>((_resolve, reject) => { rejectList = reject; });
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    // TerminalPanel ordering: auto-session is requested while hydrate is pending.
    controller.requestAutoSession();
    rejectList(new Error('list exploded'));
    await flushCreates();
    assert.equal(controller.getSnapshot().rejection, 'list exploded');
    assert.equal(bridge.createCalls.length, 0, 'fail-closed: no auto-create after hydrate failure');
});

test('detach with an in-flight create parks the late resolution instead of killing it', async () => {
    const { bridge, controller } = createHarness();
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestNewSessions(1);
    await flushCreates();
    assert.equal(bridge.createCalls.length, 1);

    controller.detach();
    bridge.resolveNext({ ok: true, id: 'term-late', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();
    assert.deepEqual(bridge.kills, [], 'detached controller parks its late create for a future hydrate');
});

test('stale-create kill prunes owner-wide capacity even when the snapshot contained the id', async () => {
    const { bridge, controller } = createHarness();
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestNewSessions(1);
    await flushCreates();
    assert.equal(bridge.createCalls.length, 1);

    // Switch target: the new snapshot still contains the in-flight old-target id
    // plus fills every other slot.
    const crowd = Array.from({ length: MAX_TERMINAL_SESSIONS - 1 }, (_, index) => ({
        id: `term-crowd-${index}`, shell: '/bin/zsh', cwd: '/Users/jun/other',
        port: 3458, seq: 0, cols: 90, rows: 30, buffer: '',
    }));
    bridge.listImpl = async () => ({
        ok: true,
        sessions: [...crowd, { id: 'term-inflight', shell: '/bin/zsh', cwd: '/Users/jun/project-a', port: 3457, seq: 0, cols: 90, rows: 30, buffer: '' }],
    });
    controller.setTarget({ port: 3458, cwd: '/Users/jun/project-b' });
    await flushCreates();

    // The in-flight create resolves stale and is killed; capacity must be pruned.
    bridge.resolveNext({ ok: true, id: 'term-inflight', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();
    assert.deepEqual(bridge.kills, ['term-inflight']);

    controller.requestNewSessions(1);
    await flushCreates();
    assert.equal(controller.getSnapshot().rejection, null, 'killed stale create must not occupy capacity');
    assert.equal(bridge.createCalls.length, 2);
});

test('hydrate event buffer is bounded by the pre-bind cap', async () => {
    const { bridge, controller, runtimes } = createHarness();
    let resolveList!: (result: ListResult) => void;
    bridge.listImpl = () => new Promise<ListResult>((resolve) => { resolveList = resolve; });
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    bridge.emitData('term-mine', 'x'.repeat(PRE_BIND_BUFFER_CAP + 4096), 9);
    resolveList({
        ok: true,
        sessions: [
            { id: 'term-mine', shell: '/bin/zsh', cwd: '/Users/jun/project-a', port: 3457, seq: 1, cols: 90, rows: 30, buffer: 'base' },
        ],
    });
    await flushCreates();

    const session = controller.getSnapshot().sessions[0]!;
    const runtime = runtimes.get(session.key)!;
    assert.equal(runtime.writes.join('').length, 'base'.length + PRE_BIND_BUFFER_CAP);
});

test('auto session waits for hydration and fires only when nothing was restored', async () => {
    const { bridge, controller } = createHarness();
    let resolveList!: (result: ListResult) => void;
    let listCalls = 0;
    bridge.listImpl = () => {
        listCalls += 1;
        return listCalls === 1
            ? new Promise<ListResult>((resolve) => { resolveList = resolve; })
            : Promise.resolve({ ok: true, sessions: [] });
    };
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestAutoSession();
    resolveList({
        ok: true,
        sessions: [
            { id: 'term-mine', shell: '/bin/zsh', cwd: '/Users/jun/project-a', port: 3457, seq: 0, cols: 90, rows: 30, buffer: '' },
        ],
    });
    await flushCreates();
    assert.equal(bridge.createCalls.length, 0, 'restored sessions suppress auto-create');

    controller.setTarget({ port: 3458, cwd: '/Users/jun/project-b' });
    controller.requestAutoSession();
    await flushCreates();
    assert.equal(bridge.createCalls.length, 1, 'empty restore fires exactly one auto-create');
});

test('focusActive focuses only a running active session', async () => {
    const { bridge, controller, runtimes } = createHarness();
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestNewSessions(1);
    await flushCreates();

    const key = controller.getSnapshot().activeSessionKey!;
    const runtime = runtimes.get(key)!;
    controller.focusActive();
    assert.equal(runtime.focused, 0, 'no focus before the session is running');

    bridge.resolveNext({ ok: true, id: 'term-a', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();
    const focusedOnCreate = runtime.focused;
    controller.focusActive();
    assert.equal(runtime.focused, focusedOnCreate + 1);
});
