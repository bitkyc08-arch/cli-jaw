import { discordDeliveryError, type DeliveryFailure } from '../messaging/delivery-outcome.js';

const API_BASE = 'https://discord.com/api/v10';
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_QUEUE = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_WAIT_MS = 30_000;
const INITIAL_BACKOFF_MS = 250;

export interface DiscordRestRequest<T> {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    /** Normalized method and route template, without concrete IDs. */
    routeKey: string;
    /** Discord major parameter: channel, guild, or webhook identity. */
    majorKey: string;
    /** Called for every attempt so multipart and other one-shot bodies stay fresh. */
    makeInit: () => RequestInit | Promise<RequestInit>;
    parse: (response: Response) => Promise<T>;
    signal?: AbortSignal;
}

export type DiscordRestResult<T> =
    | { ok: true; value: T; status: number }
    | { ok: false; failure: DeliveryFailure; status?: number };

interface QueuedJob {
    sequence: number;
    generation: number;
    callerSignal?: AbortSignal;
    detachAbort?: () => void;
    run: (lane: Lane) => Promise<void>;
    rejectUnsent: (code: string) => void;
}

interface Lane {
    key: string;
    parent: Lane | null;
    queue: QueuedJob[];
    /** Dispatched jobs. A union sums this to fence pending jobs during discovery. */
    active: number;
    /** Attempts on the wire. This exceeds one only while discovered lanes converge. */
    fetching: number;
    fetchWaiters: Array<() => void>;
    kickScheduled: boolean;
    remaining: number | null;
    resetAt: number;
}

interface RateMeta {
    bucket?: string;
    remaining?: number;
    resetAfterMs?: number;
    retryAfterMs?: number;
    global: boolean;
}

export interface DiscordRestSchedulerOptions {
    token: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    maxQueue?: number;
    maxRetries?: number;
    maxCumulativeWaitMs?: number;
}

export class DiscordRestScheduler {
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    private readonly maxQueue: number;
    private readonly maxRetries: number;
    private readonly maxWait: number;
    private readonly lanes = new Map<string, Lane>();
    private readonly bucketAliases = new Map<string, string>();
    private globalUntil = 0;
    private queued = 0;
    private nextSequence = 0;
    private generation = 0;
    private closed = false;
    private readonly closeController = new AbortController();

    constructor(private readonly options: DiscordRestSchedulerOptions) {
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? abortableSleep;
        this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
        this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.maxWait = options.maxCumulativeWaitMs ?? DEFAULT_MAX_WAIT_MS;
    }

    schedule<T>(request: DiscordRestRequest<T>): Promise<DiscordRestResult<T>> {
        if (this.closed || request.signal?.aborted) {
            return Promise.resolve(this.unsent('discord_request_aborted'));
        }
        if (this.queued >= this.maxQueue) {
            return Promise.resolve(this.unsent('discord_rest_queue_full'));
        }

        const routeMajor = routeMajorKey(request);
        const laneKey = this.bucketAliases.get(routeMajor) ?? routeMajor;
        const existing = this.lanes.get(laneKey);
        const lane = existing ? this.canonical(existing) : newLane(laneKey);
        if (!existing) this.lanes.set(laneKey, lane);

        this.queued += 1;
        return new Promise<DiscordRestResult<T>>((resolve) => {
            const generation = this.generation;
            const item: QueuedJob = {
                sequence: this.nextSequence++,
                generation,
                ...(request.signal ? { callerSignal: request.signal } : {}),
                run: async (owningLane) => {
                    resolve(await this.execute(request, generation, owningLane));
                },
                rejectUnsent: (code) => resolve(this.unsent(code)),
            };
            if (request.signal) {
                const onAbort = () => this.cancelQueued(lane, item);
                request.signal.addEventListener('abort', onAbort, { once: true });
                item.detachAbort = () => request.signal?.removeEventListener('abort', onAbort);
            }
            lane.queue.push(item);
            this.kick(lane);
        });
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.generation += 1;
        this.closeController.abort();
        const roots = new Set([...this.lanes.values()].map((lane) => this.canonical(lane)));
        for (const lane of roots) {
            for (const item of lane.queue.splice(0)) {
                this.queued -= 1;
                item.detachAbort?.();
                item.rejectUnsent('discord_rest_scheduler_closed');
            }
        }
    }

    private canonical(lane: Lane): Lane {
        if (!lane.parent) return lane;
        lane.parent = this.canonical(lane.parent);
        return lane.parent;
    }

    private kick(lane: Lane): void {
        const root = this.canonical(lane);
        if (root.kickScheduled || this.closed) return;
        root.kickScheduled = true;
        queueMicrotask(() => {
            root.kickScheduled = false;
            const current = this.canonical(root);
            if (current !== root) {
                this.kick(current);
                return;
            }
            if (this.closed || current.active !== 0) return;
            const item = current.queue.shift();
            if (!item) {
                this.deleteIdleRoot(current);
                return;
            }
            this.queued -= 1;
            item.detachAbort?.();
            if (item.generation !== this.generation || item.callerSignal?.aborted) {
                item.rejectUnsent('discord_request_aborted');
                this.kick(current);
                return;
            }
            current.active += 1;
            void item.run(current).finally(() => this.release(current));
        });
    }

    private cancelQueued(lane: Lane, item: QueuedJob): void {
        const root = this.canonical(lane);
        const index = root.queue.indexOf(item);
        if (index < 0) return;
        root.queue.splice(index, 1);
        this.queued -= 1;
        item.detachAbort?.();
        item.rejectUnsent('discord_request_aborted');
        this.kick(root);
    }

    private release(dispatchedFrom: Lane): void {
        const root = this.canonical(dispatchedFrom);
        root.active -= 1;
        if (root.active < 0) throw new Error('discord_rest_lane_active_underflow');
        if (root.active === 0) this.kick(root);
    }

    private deleteIdleRoot(root: Lane): void {
        if (root.active !== 0 || root.queue.length !== 0) return;
        for (const [key, lane] of this.lanes) {
            if (this.canonical(lane) === root) this.lanes.delete(key);
        }
    }

    private async execute<T>(
        request: DiscordRestRequest<T>,
        generation: number,
        initialLane: Lane,
    ): Promise<DiscordRestResult<T>> {
        let retries = 0;
        let cumulativeWait = 0;
        let lane = this.canonical(initialLane);

        while (!this.closed && generation === this.generation) {
            lane = this.canonical(lane);
            const gateUntil = Math.max(this.globalUntil, lane.remaining === 0 ? lane.resetAt : 0);
            const gateWait = Math.max(0, gateUntil - this.now());
            if (gateWait > 0) {
                cumulativeWait += gateWait;
                if (cumulativeWait > this.maxWait) return this.rateLimit(gateWait);
                if (!await this.waitFor(gateWait, request.signal)) {
                    return retries > 0 ? this.rateLimit(gateWait) : this.unsent('discord_request_aborted');
                }
            }

            if (!await this.acquireFetch(lane, request.signal)) {
                return retries > 0 ? this.rateLimit(0) : this.unsent('discord_request_aborted');
            }
            const dispatchLane = lane;
            let init: RequestInit;
            try {
                init = await request.makeInit();
            } catch {
                this.releaseFetch(dispatchLane);
                return this.unsent('discord_request_init_failed');
            }
            if (this.closed || generation !== this.generation || request.signal?.aborted) {
                this.releaseFetch(dispatchLane);
                return this.unsent('discord_request_aborted');
            }

            let response: Response;
            try {
                response = await this.fetchImpl(`${API_BASE}${request.path}`, {
                    ...init,
                    method: request.method,
                    headers: { Authorization: `Bot ${this.options.token}`, ...(init.headers ?? {}) },
                    signal: combineSignals(
                        request.signal,
                        this.closeController.signal,
                        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                    ),
                });
            } catch (error) {
                this.releaseFetch(dispatchLane);
                return this.dispatchedFailure(error);
            }

            const meta = await readRateMeta(response);
            lane = this.applyMeta(request, lane, meta);
            this.releaseFetch(dispatchLane);

            if (response.status === 429) {
                const retryDelay = meta.retryAfterMs
                    ?? meta.resetAfterMs
                    ?? exponentialBackoff(retries);
                if (meta.global) {
                    this.globalUntil = Math.max(this.globalUntil, this.now() + retryDelay);
                } else {
                    lane.remaining = 0;
                    lane.resetAt = Math.max(lane.resetAt, this.now() + retryDelay);
                }
                if (retries >= this.maxRetries || cumulativeWait + retryDelay > this.maxWait) {
                    return this.rateLimit(retryDelay, response.status);
                }
                retries += 1;
                // Let other already-settled discovery responses union their lanes
                // before this job attempts to reacquire the canonical fetch fence.
                await Promise.resolve();
                continue;
            }

            if (!response.ok) return await this.responseFailure(response, meta);
            try {
                return { ok: true, status: response.status, value: await request.parse(response) };
            } catch (error) {
                return this.dispatchedFailure(error, response.status);
            }
        }
        return this.unsent('discord_rest_scheduler_closed');
    }

    private applyMeta<T>(request: DiscordRestRequest<T>, lane: Lane, meta: RateMeta): Lane {
        lane = this.canonical(lane);
        if (meta.remaining !== undefined) lane.remaining = meta.remaining;
        if (meta.resetAfterMs !== undefined) lane.resetAt = this.now() + meta.resetAfterMs;
        if (!meta.bucket) return lane;

        const routeMajor = routeMajorKey(request);
        const learnedKey = `${meta.bucket}|${request.majorKey}`;
        this.bucketAliases.set(routeMajor, learnedKey);
        const learned = this.lanes.get(learnedKey);
        if (!learned) {
            lane.key = learnedKey;
            this.lanes.set(learnedKey, lane);
            return lane;
        }
        return this.mergeLanes(lane, this.canonical(learned), learnedKey);
    }

    private mergeLanes(source: Lane, target: Lane, learnedKey: string): Lane {
        source = this.canonical(source);
        target = this.canonical(target);
        if (source === target) return target;

        target.active += source.active;
        source.active = 0;
        target.fetching += source.fetching;
        source.fetching = 0;
        target.fetchWaiters.push(...source.fetchWaiters);
        source.fetchWaiters.length = 0;
        target.queue.push(...source.queue);
        target.queue.sort((left, right) => left.sequence - right.sequence);
        source.queue.length = 0;
        target.remaining = minimumKnown(target.remaining, source.remaining);
        target.resetAt = Math.max(target.resetAt, source.resetAt);
        source.parent = target;
        this.lanes.set(learnedKey, target);
        this.kick(target);
        return target;
    }

    private async acquireFetch(lane: Lane, caller?: AbortSignal): Promise<boolean> {
        while (!this.closed) {
            const root = this.canonical(lane);
            if (root.fetching === 0) {
                root.fetching = 1;
                return true;
            }
            const signal = combineSignals(caller, this.closeController.signal);
            try {
                await new Promise<void>((resolve, reject) => {
                    if (signal.aborted) {
                        reject(signal.reason);
                        return;
                    }
                    const wake = () => {
                        signal.removeEventListener('abort', onAbort);
                        resolve();
                    };
                    const onAbort = () => {
                        const owner = this.canonical(root);
                        const index = owner.fetchWaiters.indexOf(wake);
                        if (index >= 0) owner.fetchWaiters.splice(index, 1);
                        reject(signal.reason);
                    };
                    root.fetchWaiters.push(wake);
                    signal.addEventListener('abort', onAbort, { once: true });
                });
            } catch {
                return false;
            }
        }
        return false;
    }

    private releaseFetch(dispatchedFrom: Lane): void {
        const root = this.canonical(dispatchedFrom);
        root.fetching -= 1;
        if (root.fetching < 0) throw new Error('discord_rest_lane_fetch_underflow');
        if (root.fetching === 0) root.fetchWaiters.shift()?.();
    }

    private async waitFor(ms: number, caller?: AbortSignal): Promise<boolean> {
        try {
            await this.sleep(ms, combineSignals(caller, this.closeController.signal));
            return true;
        } catch {
            return false;
        }
    }

    private async responseFailure(response: Response, meta: RateMeta): Promise<DiscordRestResult<never>> {
        const body = await safeJson(response.clone());
        const message = typeof body['message'] === 'string'
            ? body['message']
            : await response.text().catch(() => response.statusText);
        const failure = discordDeliveryError({
            channel: 'discord',
            status: response.status,
            message,
            ...(body['code'] === undefined ? {} : { code: String(body['code']) }),
            ...(meta.retryAfterMs === undefined ? {} : { retryAfterMs: meta.retryAfterMs }),
            dispatched: true,
        });
        return { ok: false, status: response.status, failure };
    }

    private dispatchedFailure(error: unknown, status?: number): DiscordRestResult<never> {
        const failure = discordDeliveryError({
            channel: 'discord',
            ...(status === undefined ? {} : { status }),
            dispatched: true,
            message: error instanceof Error ? error.message : String(error),
            cause: error,
        });
        return { ok: false, ...(status === undefined ? {} : { status }), failure };
    }

    private unsent(code: string): DiscordRestResult<never> {
        return {
            ok: false,
            failure: discordDeliveryError({
                channel: 'discord', code, message: code, dispatched: false,
            }),
        };
    }

    private rateLimit(ms: number, status = 429): DiscordRestResult<never> {
        return {
            ok: false,
            status,
            failure: discordDeliveryError({
                channel: 'discord',
                status,
                code: 'rate_limited',
                message: 'Discord rate limit retry budget exhausted',
                retryAfterMs: ms,
                dispatched: true,
            }),
        };
    }
}

function newLane(key: string): Lane {
    return {
        key,
        parent: null,
        queue: [],
        active: 0,
        fetching: 0,
        fetchWaiters: [],
        kickScheduled: false,
        remaining: null,
        resetAt: 0,
    };
}

function routeMajorKey<T>(request: DiscordRestRequest<T>): string {
    return `${request.routeKey}|${request.majorKey}`;
}

async function readRateMeta(response: Response): Promise<RateMeta> {
    const body = response.status === 429 ? await safeJson(response.clone()) : {};
    const bucket = header(response, 'x-ratelimit-bucket');
    const remaining = headerNumber(response, 'x-ratelimit-remaining');
    const resetAfterMs = secondsToMs(header(response, 'x-ratelimit-reset-after'));
    const retryAfterMs = secondsToMs(header(response, 'retry-after') ?? body['retry_after']);
    return {
        ...(bucket ? { bucket } : {}),
        ...(remaining === undefined ? {} : { remaining: Math.max(0, Math.floor(remaining)) }),
        ...(resetAfterMs === undefined ? {} : { resetAfterMs }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        global: response.headers.get('x-ratelimit-global') === 'true'
            || response.headers.get('x-ratelimit-scope') === 'global'
            || body['global'] === true,
    };
}

function header(response: Response, name: string): string | undefined {
    return response.headers.get(name) ?? undefined;
}

function headerNumber(response: Response, name: string): number | undefined {
    const raw = response.headers.get(name);
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

function secondsToMs(value: unknown): number | undefined {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

function exponentialBackoff(retry: number): number {
    return INITIAL_BACKOFF_MS * (2 ** retry);
}

function minimumKnown(left: number | null, right: number | null): number | null {
    if (left === null) return right;
    if (right === null) return left;
    return Math.min(left, right);
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
    const value = await response.json().catch(() => ({}));
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function combineSignals(...values: Array<AbortSignal | undefined>): AbortSignal {
    const signals = values.filter((value): value is AbortSignal => value !== undefined);
    return signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const done = () => {
            signal.removeEventListener('abort', aborted);
            resolve();
        };
        const aborted = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', aborted, { once: true });
    });
}
