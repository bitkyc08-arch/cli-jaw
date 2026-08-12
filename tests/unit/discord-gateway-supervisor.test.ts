import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientEvents } from 'discord.js';
import {
    DiscordGatewaySupervisor,
    type DiscordGatewayClientPort,
    type DiscordGatewaySnapshot,
    type GatewayEventMap,
    type GatewayEventName,
} from '../../src/discord/gateway-supervisor.ts';

type Listener<K extends GatewayEventName> = (...args: GatewayEventMap[K]) => void;

class FakeClient implements DiscordGatewayClientPort {
    readonly listeners = new Map<GatewayEventName, Set<(...args: never[]) => void>>();
    loginCalls = 0;
    destroyCalls = 0;
    loginError: Error | null = null;

    constructor(readonly shards: readonly number[] = [0]) {}

    async login(): Promise<string> {
        this.loginCalls += 1;
        if (this.loginError) throw this.loginError;
        return 'token';
    }

    destroy(): void {
        this.destroyCalls += 1;
    }

    shardIds(): readonly number[] {
        return this.shards;
    }

    on<K extends GatewayEventName>(event: K, listener: Listener<K>): void {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener as (...args: never[]) => void);
        this.listeners.set(event, listeners);
    }

    off<K extends GatewayEventName>(event: K, listener: Listener<K>): void {
        this.listeners.get(event)?.delete(listener as (...args: never[]) => void);
    }

    emit<K extends GatewayEventName>(event: K, ...args: GatewayEventMap[K]): void {
        for (const listener of [...(this.listeners.get(event) ?? [])]) {
            listener(...args as never[]);
        }
    }

    listenerCount(): number {
        return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
    }
}

interface PendingSleep {
    signal: AbortSignal;
    resolve: () => void;
    reject: (error: Error) => void;
}

function sleepHarness() {
    const pending: PendingSleep[] = [];
    const sleep = (_ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
        const item = { signal, resolve, reject };
        pending.push(item);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return { pending, sleep };
}

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function drain(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

function closeEvent(code: number): ClientEvents['shardDisconnect'][0] {
    return { code, reason: '', wasClean: true } as ClientEvents['shardDisconnect'][0];
}

test('activation finishes before the first ready snapshot', async () => {
    const client = new FakeClient();
    const generationReady = deferred();
    const snapshots: DiscordGatewaySnapshot[] = [];
    const calls: string[] = [];
    const supervisor = new DiscordGatewaySupervisor({
        token: 'secret',
        createClient: () => client,
        onGenerationReady: async () => {
            calls.push('generation:start');
            await generationReady.promise;
            calls.push('generation:end');
        },
        onConnectionReady: () => { calls.push('connection'); },
        onClientRetired: () => { calls.push('retired'); },
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        now: () => 1234,
    });

    await supervisor.start();
    client.emit('shardReady', 0, undefined);
    await drain();
    assert.equal(supervisor.snapshot().state, 'starting');
    assert.equal(snapshots.some(({ state }) => state === 'ready'), false);

    generationReady.resolve();
    await drain();
    assert.deepEqual(calls, ['generation:start', 'generation:end', 'connection']);
    assert.deepEqual(supervisor.snapshot(), {
        state: 'ready',
        generation: 1,
        attempts: 0,
        lastCloseCode: null,
        lastEventCode: 'shard_ready',
        lastReadyAt: 1234,
        readyShards: 1,
        recoveringShards: 0,
        blockedShards: 0,
    });
});

test('reconnecting is recoverable and resume returns the same generation to ready', async () => {
    const client = new FakeClient();
    const timers = sleepHarness();
    let generationReady = 0;
    let connectionReady = 0;
    const supervisor = new DiscordGatewaySupervisor({
        token: 'secret',
        createClient: () => client,
        onGenerationReady: () => { generationReady += 1; },
        onConnectionReady: () => { connectionReady += 1; },
        onClientRetired: () => undefined,
        sleep: timers.sleep,
    });

    await supervisor.start();
    client.emit('shardReady', 0, undefined);
    await drain();
    client.emit('shardReconnecting', 0);
    client.emit('shardReconnecting', 0);
    await drain();

    assert.equal(supervisor.snapshot().state, 'recovering');
    assert.equal(timers.pending.length, 1, 'one aggregate recovery timer is armed');
    assert.equal(client.destroyCalls, 0);
    assert.equal(supervisor.snapshot().lastCloseCode, null);

    client.emit('shardResume', 0, 17);
    await drain();
    assert.equal(supervisor.snapshot().state, 'ready');
    assert.equal(supervisor.snapshot().generation, 1);
    assert.equal(supervisor.snapshot().lastEventCode, 'shard_resumed:17');
    assert.equal(timers.pending[0]!.signal.aborted, true);
    assert.equal(generationReady, 1);
    assert.equal(connectionReady, 2);

    client.emit('shardResume', 0, 1);
    await drain();
    assert.equal(generationReady, 1);
    assert.equal(connectionReady, 2, 'duplicate ready events do not reactivate an already-ready epoch');
});

test('aggregate readiness waits for every shard after a reconnect', async () => {
    const client = new FakeClient([0, 1]);
    const supervisor = new DiscordGatewaySupervisor({
        token: 'secret',
        createClient: () => client,
        onGenerationReady: () => undefined,
        onConnectionReady: () => undefined,
        onClientRetired: () => undefined,
    });

    await supervisor.start();
    client.emit('shardReady', 0, undefined);
    client.emit('shardReady', 1, undefined);
    await drain();
    assert.equal(supervisor.snapshot().state, 'ready');

    client.emit('shardReconnecting', 1);
    await drain();
    client.emit('shardReady', 1, new Set());
    await drain();
    assert.equal(supervisor.snapshot().state, 'ready');
    assert.equal(supervisor.snapshot().readyShards, 2);
});

test('public error events are diagnostic and never retire a ready client', async () => {
    const client = new FakeClient();
    const supervisor = new DiscordGatewaySupervisor({
        token: 'secret',
        createClient: () => client,
        onGenerationReady: () => undefined,
        onConnectionReady: () => undefined,
        onClientRetired: () => undefined,
    });

    await supervisor.start();
    client.emit('shardReady', 0, undefined);
    await drain();
    client.emit('shardError', new TypeError('raw text must not escape'), 0);
    await drain();
    assert.equal(supervisor.snapshot().state, 'ready');
    assert.equal(supervisor.snapshot().lastEventCode, 'shard_error:0:TypeError');
    client.emit('error', new RangeError('raw text must not escape'));
    await drain();
    assert.equal(supervisor.snapshot().state, 'ready');
    assert.equal(supervisor.snapshot().lastEventCode, 'client_error:RangeError');
    assert.equal(client.destroyCalls, 0);
});

test('discord.js terminal shardDisconnect blocks and retires exactly once', async () => {
    for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
        const client = new FakeClient();
        let retired = 0;
        const supervisor = new DiscordGatewaySupervisor({
            token: 'secret',
            createClient: () => client,
            onGenerationReady: () => undefined,
            onConnectionReady: () => undefined,
            onClientRetired: () => { retired += 1; },
        });

        await supervisor.start();
        client.emit('shardDisconnect', closeEvent(code), 0);
        await drain();
        assert.equal(supervisor.snapshot().state, 'blocked');
        assert.equal(supervisor.snapshot().lastCloseCode, code);
        assert.equal(supervisor.snapshot().lastEventCode, `unrecoverable_disconnect:${code}`);
        assert.equal(retired, 1);
        assert.equal(client.destroyCalls, 1);
        assert.equal(client.listenerCount(), 0);
    }
});

test('recovery timeout replaces once and stale generation events cannot mutate state', async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const clients = [first, second];
    const timers = sleepHarness();
    const supervisor = new DiscordGatewaySupervisor({
        token: 'secret',
        createClient: () => clients.shift()!,
        onGenerationReady: () => undefined,
        onConnectionReady: () => undefined,
        onClientRetired: () => undefined,
        sleep: timers.sleep,
    });

    await supervisor.start();
    first.emit('shardReady', 0, undefined);
    await drain();
    first.emit('shardReconnecting', 0);
    await drain();
    timers.pending[0]!.resolve();
    await drain();
    assert.equal(timers.pending.length, 2, 'timeout arms one replacement backoff');
    timers.pending[1]!.resolve();
    await drain();

    assert.equal(supervisor.snapshot().generation, 2);
    assert.equal(first.destroyCalls, 1);
    assert.equal(second.loginCalls, 1);
    first.emit('shardDisconnect', closeEvent(4004), 0);
    first.emit('shardReady', 0, undefined);
    await drain();
    assert.equal(supervisor.snapshot().generation, 2);
    assert.equal(supervisor.snapshot().state, 'starting');
});

test('failed generation initialization is fenced until a replacement succeeds', async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const clients = [first, second];
    const timers = sleepHarness();
    let generationCalls = 0;
    let connectionCalls = 0;
    const snapshots: DiscordGatewaySnapshot[] = [];
    const supervisor = new DiscordGatewaySupervisor({
        token: 'secret',
        createClient: () => clients.shift()!,
        onGenerationReady: () => {
            generationCalls += 1;
            if (generationCalls === 1) throw new TypeError('activation failed');
        },
        onConnectionReady: () => { connectionCalls += 1; },
        onClientRetired: () => undefined,
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        sleep: timers.sleep,
        now: () => 99,
    });

    await supervisor.start();
    first.emit('shardReady', 0, undefined);
    await drain();
    assert.equal(supervisor.snapshot().state, 'recovering');
    assert.equal(supervisor.snapshot().lastReadyAt, null);
    first.emit('shardReady', 0, undefined);
    await drain();
    assert.equal(generationCalls, 1, 'activationFailed fences duplicate ready events');

    timers.pending[0]!.resolve();
    await drain();
    second.emit('shardReady', 0, undefined);
    await drain();
    assert.equal(generationCalls, 2);
    assert.equal(connectionCalls, 1);
    assert.equal(supervisor.snapshot().state, 'ready');
    assert.equal(supervisor.snapshot().lastReadyAt, 99);
    assert.equal(snapshots.filter(({ state }) => state === 'ready').length, 1);
});

test('connection activation failure also requires a fully initialized fresh generation', async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const clients = [first, second];
    const timers = sleepHarness();
    let generationCalls = 0;
    let connectionCalls = 0;
    const supervisor = new DiscordGatewaySupervisor({
        token: 'secret',
        createClient: () => clients.shift()!,
        onGenerationReady: () => { generationCalls += 1; },
        onConnectionReady: () => {
            connectionCalls += 1;
            if (connectionCalls === 1) throw new RangeError('connection activation failed');
        },
        onClientRetired: () => undefined,
        sleep: timers.sleep,
    });

    await supervisor.start();
    first.emit('shardReady', 0, undefined);
    await drain();
    assert.equal(supervisor.snapshot().state, 'recovering');
    assert.equal(supervisor.snapshot().lastReadyAt, null);
    timers.pending[0]!.resolve();
    await drain();
    second.emit('shardReady', 0, undefined);
    await drain();
    assert.equal(generationCalls, 2);
    assert.equal(connectionCalls, 2);
    assert.equal(supervisor.snapshot().state, 'ready');
});

test('explicit stop aborts timers, removes all lifecycle listeners, and destroys once', async () => {
    const client = new FakeClient();
    const timers = sleepHarness();
    const supervisor = new DiscordGatewaySupervisor({
        token: 'secret',
        createClient: () => client,
        onGenerationReady: () => undefined,
        onConnectionReady: () => undefined,
        onClientRetired: () => undefined,
        sleep: timers.sleep,
    });

    await supervisor.start();
    client.emit('shardReconnecting', 0);
    await drain();
    await supervisor.stop();
    assert.equal(supervisor.snapshot().state, 'stopped');
    assert.equal(timers.pending[0]!.signal.aborted, true);
    assert.equal(client.listenerCount(), 0);
    assert.equal(client.destroyCalls, 1);
});

test('consecutive login failures exhaust bounded replacements and leave no client', async () => {
    const clients = Array.from({ length: 3 }, () => {
        const client = new FakeClient();
        client.loginError = new Error('login failed');
        return client;
    });
    const available = [...clients];
    const timers = sleepHarness();
    const supervisor = new DiscordGatewaySupervisor({
        token: 'secret',
        createClient: () => available.shift()!,
        onGenerationReady: () => undefined,
        onConnectionReady: () => undefined,
        onClientRetired: () => undefined,
        sleep: timers.sleep,
        maxAttempts: 3,
    });

    await supervisor.start();
    for (let index = 0; index < 3; index += 1) {
        assert.equal(timers.pending.length, index + 1);
        timers.pending[index]!.resolve();
        await drain();
    }

    assert.equal(supervisor.snapshot().state, 'blocked');
    assert.equal(supervisor.snapshot().generation, 3);
    assert.equal(supervisor.snapshot().lastEventCode, 'recovery_exhausted:login_failed');
    assert.deepEqual(clients.map(({ loginCalls }) => loginCalls), [1, 1, 1]);
    assert.deepEqual(clients.map(({ destroyCalls }) => destroyCalls), [1, 1, 1]);
    assert.equal(clients.every((client) => client.listenerCount() === 0), true);
});

test('serialized event failures never become unhandled rejections', async () => {
    const client = new FakeClient();
    const timers = sleepHarness();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
        const supervisor = new DiscordGatewaySupervisor({
            token: 'secret',
            createClient: () => client,
            onGenerationReady: () => undefined,
            onConnectionReady: () => undefined,
            onClientRetired: () => undefined,
            sleep: timers.sleep,
            onSnapshot: (snapshot) => {
                if (snapshot.lastEventCode === 'client_error:Error') {
                    throw new Error('observer failed inside an EventEmitter callback');
                }
            },
        });

        await supervisor.start();
        client.emit('shardReady', 0, undefined);
        await drain();
        client.emit('error', new Error('diagnostic'));
        await drain();

        assert.equal(unhandled.length, 0);
        assert.equal(supervisor.snapshot().state, 'recovering');
        assert.equal(supervisor.snapshot().lastEventCode, 'serialized_task_failed:client_error:Error');
        await supervisor.stop();
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});

test('installed discord.js exposes only observable public lifecycle tuples', () => {
    const root = join(import.meta.dirname, '..', '..');
    const typings = readFileSync(join(root, 'node_modules/discord.js/typings/index.d.ts'), 'utf8');
    const manager = readFileSync(
        join(root, 'node_modules/discord.js/src/client/websocket/WebSocketManager.js'),
        'utf8',
    );

    const publicTuples = [
        'shardDisconnect: [closeEvent: CloseEvent, shardId: number]',
        'shardError: [error: Error, shardId: number]',
        'shardReady: [shardId: number, unavailableGuilds: Set<Snowflake> | undefined]',
        'shardReconnecting: [shardId: number]',
        'shardResume: [shardId: number, replayedEvents: number]',
    ];
    for (const tuple of publicTuples) assert.ok(typings.includes(tuple), tuple);
    assert.match(manager, /UNRECOVERABLE_CLOSE_CODES\.includes\(code\)[\s\S]*Events\.ShardDisconnect/);
    assert.match(manager, /Events\.ShardReconnecting, shardId/);
    assert.doesNotMatch(manager, /emit\(Events\.Invalidated/);

    const supervisor = readFileSync(join(root, 'src/discord/gateway-supervisor.ts'), 'utf8');
    assert.doesNotMatch(supervisor, /void this\.serialize\(/);
    assert.doesNotMatch(supervisor, /disconnect\(code, reason\)/);
});
