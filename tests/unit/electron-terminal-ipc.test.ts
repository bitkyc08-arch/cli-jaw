import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Execution-level IPC contract tests: the real registerTerminalIpc handlers run
// against mocked electron/node-pty packages (resolved from electron/package.json
// because they are electron-subpackage dependencies, not root ones).
const electronRequire = createRequire(new URL('../../electron/package.json', import.meta.url));
const electronModulePath = electronRequire.resolve('electron');
const nodePtyModulePath = electronRequire.resolve('node-pty');

const ALLOWED_URL = 'http://127.0.0.1:24577/dashboard2/';

interface FakePty {
    id: number;
    writes: string[];
    resizes: Array<{ cols: number; rows: number }>;
    killed: boolean;
    emitData(text: string): void;
    emitExit(code: number): void;
}

interface FakeSender {
    id: number;
    sent: Array<{ channel: string; args: unknown[] }>;
    destroyedCbs: Array<() => void>;
    destroyed: boolean;
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
    once(event: string, cb: () => void): void;
    destroy(): void;
}

const handlers = new Map<string, (event: unknown, ...args: never[]) => unknown>();
const ptys: FakePty[] = [];
const senders = new Map<number, FakeSender>();
let ptyCounter = 0;

function makeSender(id: number): FakeSender {
    const sender: FakeSender = {
        id,
        sent: [],
        destroyedCbs: [],
        destroyed: false,
        isDestroyed() { return sender.destroyed; },
        send(channel, ...args) { sender.sent.push({ channel, args }); },
        once(event, cb) { if (event === 'destroyed') sender.destroyedCbs.push(cb); },
        destroy() {
            if (sender.destroyed) return;
            sender.destroyed = true;
            for (const cb of [...sender.destroyedCbs]) cb();
        },
    };
    senders.set(id, sender);
    return sender;
}

function makeEvent(sender: FakeSender) {
    return { sender, senderFrame: { url: ALLOWED_URL } };
}

mock.module(electronModulePath, {
    namedExports: {
        ipcMain: {
            handle: (channel: string, fn: (event: unknown, ...args: never[]) => unknown) => {
                handlers.set(channel, fn);
            },
        },
        webContents: {
            fromId: (id: number) => senders.get(id) ?? null,
        },
    },
});

mock.module(nodePtyModulePath, {
    namedExports: {
        spawn: () => {
            ptyCounter += 1;
            let dataCb: ((text: string) => void) | null = null;
            let exitCb: ((result: { exitCode: number }) => void) | null = null;
            const pty: FakePty = {
                id: ptyCounter,
                writes: [],
                resizes: [],
                killed: false,
                emitData(text) { dataCb?.(text); },
                emitExit(code) { exitCb?.({ exitCode: code }); },
            };
            ptys.push(pty);
            return {
                write: (data: string) => { pty.writes.push(data); },
                resize: (cols: number, rows: number) => { pty.resizes.push({ cols, rows }); },
                kill: () => { pty.killed = true; },
                onData: (cb: (text: string) => void) => { dataCb = cb; },
                onExit: (cb: (result: { exitCode: number }) => void) => { exitCb = cb; },
            };
        },
    },
});

const { registerTerminalIpc, cleanupTerminals } = await import('../../electron/src/main/lib/terminal/index.ts');
const { setAllowedOrigin } = await import('../../electron/src/main/lib/ipc-origin-guard.ts');

interface CreateResult {
    ok: boolean;
    id?: string;
    shell?: string;
    cwd?: string;
    error?: string;
}

interface ListResult {
    ok: boolean;
    sessions?: Array<{ id: string; port: number | null; seq: number; cwd: string; buffer: string }>;
    error?: string;
}

function create(sender: FakeSender, opts?: Record<string, unknown>): CreateResult {
    return handlers.get('terminal:create')!(makeEvent(sender), opts) as CreateResult;
}

function list(sender: FakeSender): ListResult {
    return handlers.get('terminal:list')!(makeEvent(sender)) as ListResult;
}

function setup(): void {
    handlers.clear();
    ptys.length = 0;
    senders.clear();
    setAllowedOrigin(new URL(ALLOWED_URL).origin);
    registerTerminalIpc();
}

test('terminal ownership: list is sender-scoped and carries port+seq metadata', { concurrency: false }, async (t) => {
    t.after(() => cleanupTerminals());
    setup();
    const owner = makeSender(11);
    const other = makeSender(22);
    const created = create(owner, { cwd: process.env['HOME'], port: 3506 });
    assert.equal(created.ok, true);
    assert.ok(created.id);

    const ownerList = list(owner);
    assert.equal(ownerList.sessions?.length, 1);
    assert.equal(ownerList.sessions?.[0]?.port, 3506);
    assert.equal(ownerList.sessions?.[0]?.seq, 0);

    // Other senders see nothing and cannot drive the session.
    assert.equal(list(other).sessions?.length, 0);
    handlers.get('terminal:write')!(makeEvent(other), created.id, 'echo nope\n');
    handlers.get('terminal:resize')!(makeEvent(other), created.id, 120, 40);
    handlers.get('terminal:kill')!(makeEvent(other), created.id);
    assert.deepEqual(ptys[0]?.writes, []);
    assert.deepEqual(ptys[0]?.resizes, []);
    assert.equal(ptys[0]?.killed, false);

    // Owner can.
    handlers.get('terminal:write')!(makeEvent(owner), created.id, 'pwd\n');
    handlers.get('terminal:resize')!(makeEvent(owner), created.id, 120, 40);
    assert.deepEqual(ptys[0]?.writes, ['pwd\n']);
    assert.deepEqual(ptys[0]?.resizes, [{ cols: 120, rows: 40 }]);
});

test('terminal output and exit events route only to the owning webContents, with seq watermarks', { concurrency: false }, async (t) => {
    t.after(() => cleanupTerminals());
    setup();
    const owner = makeSender(33);
    const other = makeSender(44);
    const created = create(owner, { port: 3506 });
    assert.equal(created.ok, true);

    ptys[0]!.emitData('hello');
    ptys[0]!.emitData('world');
    const dataEvents = owner.sent.filter(entry => entry.channel === 'terminal:data');
    assert.equal(dataEvents.length, 2);
    assert.deepEqual(dataEvents[0]?.args, [created.id, 'hello', 1]);
    assert.deepEqual(dataEvents[1]?.args, [created.id, 'world', 2]);
    assert.equal(other.sent.length, 0);
    assert.equal(list(owner).sessions?.[0]?.seq, 2);
    assert.equal(list(owner).sessions?.[0]?.buffer, 'helloworld');

    ptys[0]!.emitExit(0);
    const exitEvents = owner.sent.filter(entry => entry.channel === 'terminal:exit');
    assert.equal(exitEvents.length, 1);
    assert.deepEqual(exitEvents[0]?.args, [created.id, 0]);
    // Natural exit removes the session from the owner list.
    assert.equal(list(owner).sessions?.length, 0);
});

test('terminal create rejects invalid port and disallowed cwd; owner kill works', { concurrency: false }, async (t) => {
    t.after(() => cleanupTerminals());
    setup();
    const owner = makeSender(55);
    assert.equal(create(owner, { port: -1 }).error, 'invalid port');
    assert.equal(create(owner, { port: 70000 }).error, 'invalid port');
    assert.equal(create(owner, { port: 3.5 }).error, 'invalid port');
    assert.equal(create(owner, { cwd: '/definitely/not/allowed' }).error, 'cwd not allowed');

    const created = create(owner, { port: null });
    assert.equal(created.ok, true);
    assert.equal(list(owner).sessions?.[0]?.port, null);
    handlers.get('terminal:kill')!(makeEvent(owner), created.id);
    assert.equal(ptys[0]?.killed, true);
    assert.equal(list(owner).sessions?.length, 0);
});

test('owner webContents destruction reaps its PTYs without touching other owners', { concurrency: false }, async (t) => {
    t.after(() => cleanupTerminals());
    setup();
    const ownerA = makeSender(66);
    const ownerB = makeSender(77);
    const a1 = create(ownerA, { port: 3506 });
    const a2 = create(ownerA, { port: 3507 });
    const b1 = create(ownerB, { port: 3508 });
    assert.ok(a1.id && a2.id && b1.id);
    // Exactly one destroyed listener per owner regardless of session count.
    assert.equal(ownerA.destroyedCbs.length, 1);
    assert.equal(ownerB.destroyedCbs.length, 1);

    ownerA.destroy();
    assert.equal(ptys[0]?.killed, true);
    assert.equal(ptys[1]?.killed, true);
    assert.equal(ptys[2]?.killed, false);
    assert.equal(list(ownerB).sessions?.length, 1);

    // Listener registry does not accumulate: new sessions for a live owner
    // still register exactly one destroyed callback.
    cleanupTerminals();
    const a3 = create(ownerB, { port: 3509 });
    assert.ok(a3.id);
    assert.equal(ownerB.destroyedCbs.length, 1);
});

test('global session cap rejects the ninth create across owners', { concurrency: false }, async (t) => {
    t.after(() => cleanupTerminals());
    setup();
    const owner = makeSender(88);
    for (let index = 0; index < 8; index += 1) {
        assert.equal(create(owner, { port: 3506 + index }).ok, true);
    }
    const ninth = create(owner, { port: 4000 });
    assert.equal(ninth.ok, false);
    assert.equal(ninth.error, 'max sessions reached');
});
