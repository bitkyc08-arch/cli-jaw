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
    terminalRequestLedgerReducer,
} from '../../public/dashboard2/src/shell/panels/terminal-session-requests.ts';
import type { TerminalBridgeApi } from '../../public/dashboard2/src/providers/desktop-bridge-contract.ts';

type CreateResult = Awaited<ReturnType<TerminalBridgeApi['create']>>;

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
    readonly createCalls: Array<{ cwd?: string; cols?: number; rows?: number }> = [];
    readonly writes: Array<{ id: string; data: string }> = [];
    readonly resizes: Array<{ id: string; cols: number; rows: number }> = [];
    readonly kills: string[] = [];
    readonly order: string[] = [];
    beforeKill: ((id: string) => void) | null = null;
    private readonly pendingCreates: Array<(result: CreateResult) => void> = [];
    private readonly dataListeners = new Set<(id: string, data: string) => void>();
    private readonly exitListeners = new Set<(id: string, code: number | null) => void>();

    async list(): Promise<{ ok: boolean; sessions?: []; error?: string }> {
        return { ok: true, sessions: [] };
    }

    create(opts: { cwd?: string; cols?: number; rows?: number } = {}): Promise<CreateResult> {
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

    onData(callback: (id: string, data: string) => void): () => void {
        this.dataListeners.add(callback);
        return () => this.dataListeners.delete(callback);
    }

    onExit(callback: (id: string, code: number | null) => void): () => void {
        this.exitListeners.add(callback);
        return () => this.exitListeners.delete(callback);
    }

    emitData(id: string, data: string): void {
        for (const listener of this.dataListeners) listener(id, data);
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
}

test('terminalNewTab request ledger preserves batched and unopened requests', () => {
    let ledger = initialTerminalRequestLedger;
    ledger = terminalRequestLedgerReducer(ledger, { type: 'issue' });
    ledger = terminalRequestLedgerReducer(ledger, { type: 'issue' });
    ledger = terminalRequestLedgerReducer(ledger, { type: 'issue' });
    assert.deepEqual(ledger, { issued: 3, consumed: 0 });
    assert.equal(ledger.issued - ledger.consumed, 3);

    ledger = terminalRequestLedgerReducer(ledger, { type: 'consume-through', token: 2 });
    assert.deepEqual(ledger, { issued: 3, consumed: 2 });
    ledger = terminalRequestLedgerReducer(ledger, { type: 'consume-through', token: 3 });
    assert.deepEqual(ledger, { issued: 3, consumed: 3 });
});

test('pre-bind data is bounded, early exit is preserved, and non-owned events are discarded', async () => {
    const { bridge, controller, runtimes } = createHarness();
    controller.setTarget({ port: 3457, cwd: '/Users/jun/project-a' });
    controller.requestNewSessions(1);
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
    controller.setTarget({ port: 3458, cwd: '/Users/jun/b' });
    controller.requestNewSessions(1);
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
    bridge.resolveNext({ ok: true, id: 'term-1', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();
    bridge.resolveNext({ ok: true, id: 'term-2', shell: '/bin/zsh', cwd: '/Users/jun/project-a' });
    await flushCreates();

    assert.deepEqual(bridge.kills, [], 'hiding a keepAlive panel performs no lifecycle action');
    controller.dispose();
    assert.deepEqual(bridge.kills.sort(), ['term-1', 'term-2']);
});
