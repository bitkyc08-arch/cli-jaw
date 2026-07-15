export interface SseMessageLike {
    data: string;
    lastEventId?: string;
}

export interface SseSourceLike {
    onmessage: ((message: SseMessageLike) => void) | null;
    onerror: (() => void) | null;
    close(): void;
}

export interface SseConnectionClock {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
    setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
    clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface SseConnectionOptions {
    key: string;
    url: string;
    createSource(url: string): SseSourceLike;
    clock?: SseConnectionClock;
    getCursor(): string | undefined;
    setCursor(cursor: string): void;
    onPayload(payload: Record<string, unknown>, eventId?: string): void;
    onReconnect(): void;
    staleAfterMs?: number;
    watchdogEveryMs?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
}

const browserClock: SseConnectionClock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: timer => clearTimeout(timer),
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: timer => clearInterval(timer),
};

export class SseConnection {
    readonly key: string;
    private readonly options: Required<Omit<SseConnectionOptions, 'clock'>> & { clock: SseConnectionClock };
    private source: SseSourceLike | null = null;
    private generation = 0;
    private retryAttempt = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private watchdogTimer: ReturnType<typeof setInterval> | null = null;
    private visible = true;
    private stopped = true;
    private lastSeenAt = 0;

    constructor(options: SseConnectionOptions) {
        this.key = options.key;
        this.options = {
            ...options,
            clock: options.clock ?? browserClock,
            staleAfterMs: options.staleAfterMs ?? 45_000,
            watchdogEveryMs: options.watchdogEveryMs ?? 15_000,
            retryBaseMs: options.retryBaseMs ?? 1_000,
            retryMaxMs: options.retryMaxMs ?? 10_000,
        };
    }

    start(): void {
        this.stopped = false;
        this.open();
    }

    stop(): void {
        this.stopped = true;
        this.closeSource();
        this.clearRetry();
        this.clearWatchdog();
    }

    setVisible(visible: boolean): void {
        if (this.visible === visible) return;
        this.visible = visible;
        if (!visible) {
            this.closeSource();
            this.clearRetry();
            this.clearWatchdog();
            return;
        }
        if (!this.stopped) {
            this.options.onReconnect();
            this.retryAttempt = 0;
            this.open();
        }
    }

    private open(): void {
        if (this.stopped || !this.visible || this.source) return;
        const cursor = this.options.getCursor();
        const suffix = cursor ? `?lastEventId=${encodeURIComponent(cursor)}` : '';
        const source = this.options.createSource(`${this.options.url}${suffix}`);
        const generation = ++this.generation;
        this.source = source;
        this.lastSeenAt = this.options.clock.now();
        this.startWatchdog();

        source.onmessage = message => {
            if (this.source !== source || this.generation !== generation) return;
            let payload: Record<string, unknown>;
            try {
                payload = JSON.parse(String(message.data)) as Record<string, unknown>;
            } catch {
                return;
            }
            this.lastSeenAt = this.options.clock.now();
            this.retryAttempt = 0;
            if (message.lastEventId) this.options.setCursor(message.lastEventId);
            this.options.onPayload(payload, message.lastEventId || undefined);
        };
        source.onerror = () => {
            if (this.source !== source || this.generation !== generation) return;
            this.closeSource();
            this.scheduleRetry();
        };
    }

    private closeSource(): void {
        this.generation += 1;
        const source = this.source;
        this.source = null;
        if (source) {
            source.onmessage = null;
            source.onerror = null;
            source.close();
        }
    }

    private scheduleRetry(): void {
        if (this.stopped || !this.visible || this.retryTimer) return;
        const delay = Math.min(
            this.options.retryBaseMs * (2 ** this.retryAttempt),
            this.options.retryMaxMs,
        );
        this.retryAttempt += 1;
        this.retryTimer = this.options.clock.setTimeout(() => {
            this.retryTimer = null;
            if (this.stopped || !this.visible) return;
            this.options.onReconnect();
            this.open();
        }, delay);
    }

    private startWatchdog(): void {
        if (this.watchdogTimer) return;
        this.watchdogTimer = this.options.clock.setInterval(() => {
            if (!this.source || this.options.clock.now() - this.lastSeenAt < this.options.staleAfterMs) return;
            this.closeSource();
            this.options.onReconnect();
            this.scheduleRetry();
        }, this.options.watchdogEveryMs);
    }

    private clearRetry(): void {
        if (!this.retryTimer) return;
        this.options.clock.clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    private clearWatchdog(): void {
        if (!this.watchdogTimer) return;
        this.options.clock.clearInterval(this.watchdogTimer);
        this.watchdogTimer = null;
    }
}
