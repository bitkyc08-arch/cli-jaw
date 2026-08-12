import type { ClientEvents } from 'discord.js';

export type DiscordGatewayState = 'starting' | 'ready' | 'recovering' | 'blocked' | 'stopped';

export type GatewayEventName =
    | 'clientReady'
    | 'shardReady'
    | 'shardResume'
    | 'shardReconnecting'
    | 'shardDisconnect'
    | 'shardError'
    | 'error';

export type GatewayEventMap = Pick<ClientEvents, GatewayEventName>;

type GatewayListeners = {
    [K in GatewayEventName]: (...args: GatewayEventMap[K]) => void;
};

type ShardState = 'starting' | 'ready' | 'recovering' | 'blocked';

export interface DiscordGatewayClientPort {
    login(token: string): Promise<string>;
    destroy(): Promise<void> | void;
    shardIds(): readonly number[];
    on<K extends GatewayEventName>(
        event: K,
        listener: (...args: GatewayEventMap[K]) => void,
    ): void;
    off<K extends GatewayEventName>(
        event: K,
        listener: (...args: GatewayEventMap[K]) => void,
    ): void;
}

export interface DiscordGatewaySnapshot {
    state: DiscordGatewayState;
    generation: number;
    attempts: number;
    lastCloseCode: number | null;
    lastEventCode: string | null;
    lastReadyAt: number | null;
    readyShards: number;
    recoveringShards: number;
    blockedShards: number;
}

export interface DiscordGatewaySupervisorOptions {
    token: string;
    createClient: () => DiscordGatewayClientPort;
    onGenerationReady: (client: DiscordGatewayClientPort) => Promise<void> | void;
    onConnectionReady: (client: DiscordGatewayClientPort) => Promise<void> | void;
    onClientRetired: (client: DiscordGatewayClientPort) => Promise<void> | void;
    onSnapshot?: (snapshot: DiscordGatewaySnapshot) => void;
    now?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    recoveryTimeoutMs?: number;
    maxAttempts?: number;
}

interface BoundClient {
    client: DiscordGatewayClientPort;
    generation: number;
    listeners: GatewayListeners;
    shards: Map<number, ShardState>;
    initialized: boolean;
    activationFailed: boolean;
}

export class DiscordGatewaySupervisor {
    private state: DiscordGatewayState = 'stopped';
    private generation = 0;
    private attempts = 0;
    private lastCloseCode: number | null = null;
    private lastEventCode: string | null = null;
    private lastReadyAt: number | null = null;
    private bound: BoundClient | null = null;
    private recovery: AbortController | null = null;
    private operation: Promise<void> = Promise.resolve();
    private stopRequested = false;
    private readonly now: () => number;
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    private readonly recoveryTimeoutMs: number;
    private readonly maxAttempts: number;

    constructor(private readonly options: DiscordGatewaySupervisorOptions) {
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? abortableSleep;
        this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 30_000;
        this.maxAttempts = options.maxAttempts ?? 5;
    }

    snapshot(): DiscordGatewaySnapshot {
        return {
            state: this.state,
            generation: this.generation,
            attempts: this.attempts,
            lastCloseCode: this.lastCloseCode,
            lastEventCode: this.lastEventCode,
            lastReadyAt: this.lastReadyAt,
            readyShards: this.countShards('ready'),
            recoveringShards: this.countShards('recovering'),
            blockedShards: this.countShards('blocked'),
        };
    }

    start(): Promise<void> {
        return this.serialize(async () => {
            if (this.state !== 'stopped' && this.state !== 'blocked') return;
            this.stopRequested = false;
            this.attempts = 0;
            await this.replaceClient('initial_start');
        });
    }

    stop(): Promise<void> {
        this.stopRequested = true;
        return this.serialize(async () => {
            this.cancelRecovery();
            try {
                await this.retireCurrent();
            } finally {
                this.setState('stopped');
            }
        });
    }

    private serialize(task: () => Promise<void>): Promise<void> {
        this.operation = this.operation.then(task, task);
        return this.operation;
    }

    /** EventEmitter listeners have no promise owner, so every event terminates here. */
    private enqueueSerialized(label: string, task: () => Promise<void>): void {
        const guarded = async (): Promise<void> => {
            try {
                await task();
            } catch (error) {
                if (this.stopRequested || this.state === 'stopped') return;
                const name = error instanceof Error ? error.name : 'unknown';
                this.lastEventCode = `serialized_task_failed:${label}:${name}`.slice(0, 120);
                try {
                    if (this.bound) {
                        this.bound.activationFailed = true;
                        this.scheduleReplacement(`serialized_task_failed:${label}`);
                    } else {
                        this.setState('blocked');
                    }
                } catch {
                    // A throwing observer cannot reject the queue or leave health ready.
                    this.state = 'blocked';
                }
            }
        };

        this.operation = this.operation.then(guarded, guarded);
    }

    private async replaceClient(reason: string): Promise<void> {
        this.cancelRecovery();
        await this.retireCurrent();
        if (this.stopRequested) return;
        if (this.attempts >= this.maxAttempts) {
            this.lastEventCode = `recovery_exhausted:${reason}`;
            this.setState('blocked');
            return;
        }

        this.attempts += 1;
        const generation = ++this.generation;
        const client = this.options.createClient();
        const listeners: GatewayListeners = {
            clientReady: () => {
                this.enqueueSerialized('client_ready', async () => {
                    if (!this.isCurrent(generation, client)) return;
                    this.lastEventCode = 'client_ready';
                    this.emit();
                });
            },
            shardReady: (shardId) => {
                this.enqueueSerialized('shard_ready', () =>
                    this.onShardReady(generation, client, shardId, 'shard_ready'));
            },
            shardResume: (shardId, replayedEvents) => {
                this.enqueueSerialized('shard_resume', () =>
                    this.onShardReady(generation, client, shardId, `shard_resumed:${replayedEvents}`));
            },
            shardReconnecting: (shardId) => {
                this.enqueueSerialized('shard_reconnecting', () =>
                    this.onShardReconnecting(generation, client, shardId));
            },
            shardDisconnect: (closeEvent, shardId) => {
                this.enqueueSerialized('shard_disconnect', () =>
                    this.onShardDisconnect(generation, client, shardId, closeEvent.code));
            },
            shardError: (error, shardId) => {
                this.enqueueSerialized('shard_error', async () => {
                    this.onDiagnostic(generation, client, `shard_error:${shardId}:${error.name}`);
                });
            },
            error: (error) => {
                this.enqueueSerialized('client_error', async () => {
                    this.onDiagnostic(generation, client, `client_error:${error.name}`);
                });
            },
        };

        for (const event of Object.keys(listeners) as GatewayEventName[]) {
            client.on(event, listeners[event] as never);
        }
        this.bound = {
            client,
            generation,
            listeners,
            shards: new Map(),
            initialized: false,
            activationFailed: false,
        };
        this.setState('starting');

        try {
            await client.login(this.options.token);
        } catch (error) {
            if (!this.isCurrent(generation, client) || this.stopRequested) return;
            this.lastEventCode = `login_failed:${error instanceof Error ? error.name : 'unknown'}`;
            this.scheduleReplacement('login_failed');
        }
    }

    private async onShardReady(
        generation: number,
        client: DiscordGatewayClientPort,
        shardId: number,
        eventCode: string,
    ): Promise<void> {
        if (!this.isCurrent(generation, client) || this.stopRequested) return;
        const bound = this.bound!;
        if (bound.activationFailed) return;

        const wasAggregateReady = this.state === 'ready';
        bound.shards.set(shardId, 'ready');
        this.lastEventCode = eventCode;
        const expected = client.shardIds();
        if (!expected.length || !expected.every((id) => bound.shards.get(id) === 'ready')) {
            this.emit();
            return;
        }

        this.cancelRecovery();
        let callback: 'generation' | 'connection' = 'generation';
        try {
            if (!bound.initialized) {
                await this.options.onGenerationReady(client);
                if (!this.isCurrent(generation, client) || this.stopRequested) return;
                bound.initialized = true;
            }
            callback = 'connection';
            if (!wasAggregateReady) {
                await this.options.onConnectionReady(client);
            }
        } catch (error) {
            if (!this.isCurrent(generation, client) || this.stopRequested) return;
            const name = error instanceof Error ? error.name : 'unknown';
            this.lastEventCode = `${callback}_ready_callback_failed:${name}`.slice(0, 120);
            bound.activationFailed = true;
            this.scheduleReplacement(`${callback}_ready_callback_failed`);
            return;
        }

        if (!this.isCurrent(generation, client) || this.stopRequested) return;
        this.attempts = 0;
        this.lastReadyAt = this.now();
        this.setState('ready');
    }

    private async onShardReconnecting(
        generation: number,
        client: DiscordGatewayClientPort,
        shardId: number,
    ): Promise<void> {
        if (!this.isCurrent(generation, client) || this.stopRequested) return;
        this.bound!.shards.set(shardId, 'recovering');
        this.lastEventCode = `shard_reconnecting:${shardId}`;
        this.setState('recovering');
        if (this.recovery) return;

        const controller = new AbortController();
        this.recovery = controller;
        this.sleep(this.recoveryTimeoutMs, controller.signal).then(() => {
            this.enqueueSerialized('shard_recovery_timeout', async () => {
                if (this.isCurrent(generation, client) && this.state === 'recovering') {
                    this.scheduleReplacement('shard_recovery_timeout');
                }
            });
        }).catch((error: unknown) => {
            if (!controller.signal.aborted) {
                this.enqueueSerialized('shard_recovery_timer', async () => { throw error; });
            }
        });
    }

    private async onShardDisconnect(
        generation: number,
        client: DiscordGatewayClientPort,
        shardId: number,
        code: number,
    ): Promise<void> {
        if (!this.isCurrent(generation, client) || this.stopRequested) return;
        this.bound!.shards.set(shardId, 'blocked');
        this.lastCloseCode = code;
        this.lastEventCode = `unrecoverable_disconnect:${code}`;
        this.setState('blocked');
        await this.retireCurrent();
    }

    private onDiagnostic(
        generation: number,
        client: DiscordGatewayClientPort,
        code: string,
    ): void {
        if (!this.isCurrent(generation, client) || this.stopRequested) return;
        this.lastEventCode = code.slice(0, 120);
        this.emit();
    }

    private scheduleReplacement(reason: string): void {
        if (this.stopRequested) return;
        this.setState('recovering');
        const delay = Math.min(30_000, 1_000 * 2 ** Math.max(0, this.attempts - 1));
        const controller = new AbortController();
        this.cancelRecovery();
        this.recovery = controller;
        this.sleep(delay, controller.signal).then(() => {
            this.enqueueSerialized('replacement_timer', async () => {
                if (!this.stopRequested && this.state !== 'stopped') {
                    await this.replaceClient(reason);
                }
            });
        }).catch((error: unknown) => {
            if (!controller.signal.aborted) {
                this.enqueueSerialized('replacement_sleep', async () => { throw error; });
            }
        });
    }

    private cancelRecovery(): void {
        this.recovery?.abort();
        this.recovery = null;
    }

    private async retireCurrent(): Promise<void> {
        const bound = this.bound;
        this.bound = null;
        if (!bound) return;
        for (const event of Object.keys(bound.listeners) as GatewayEventName[]) {
            bound.client.off(event, bound.listeners[event] as never);
        }

        try {
            await this.options.onClientRetired(bound.client);
        } finally {
            await bound.client.destroy();
        }
    }

    private isCurrent(generation: number, client: DiscordGatewayClientPort): boolean {
        return this.bound?.generation === generation && this.bound.client === client;
    }

    private countShards(state: ShardState): number {
        return [...(this.bound?.shards.values() ?? [])].filter((value) => value === state).length;
    }

    private setState(state: DiscordGatewayState): void {
        this.state = state;
        this.emit();
    }

    private emit(): void {
        this.options.onSnapshot?.(this.snapshot());
    }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
        }, { once: true });
    });
}
