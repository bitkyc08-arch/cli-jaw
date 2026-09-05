import type { RpcFrame } from './wire.js';

type Consumer = (frame: RpcFrame, signal: AbortSignal) => void | Promise<void>;
type Job = { frame: RpcFrame; bytes: number; consume: Consumer };
type Waiter = { resolve(): void; reject(error: Error): void };
const COUNT_LIMIT = 256;
const BYTE_LIMIT = 8 * 1024 * 1024;

/** Per-turn queue. Human requests bypass it; consumers bind effects to its signal and owner. */
export class AcpNotificationQueue {
    private readonly jobs: Job[] = [];
    private readonly waiters = new Set<Waiter>();
    private readonly controller = new AbortController();
    private active: Job | null = null;
    private bytes = 0;
    private scheduled = false;
    private sealed = false;
    private failure: Error | null = null;

    constructor(private readonly failed: (error: Error) => void) {}
    get idle(): boolean { return this.active === null && this.jobs.length === 0; }

    enqueue(frame: RpcFrame, consume: Consumer): void {
        if (this.sealed) throw new Error('acp_notification_after_terminal');
        let bytes: number;
        try { bytes = Buffer.byteLength(JSON.stringify(frame)); }
        catch { this.fail(new Error('acp_invalid_notification')); return; }
        if (this.sealed) throw new Error('acp_notification_after_terminal');
        if (this.jobs.length + Number(this.active !== null) >= COUNT_LIMIT || this.bytes + bytes > BYTE_LIMIT) {
            this.fail(new Error('acp_notification_limit'));
            return;
        }
        this.jobs.push({ frame, consume, bytes });
        this.bytes += bytes;
        this.schedule();
    }
    seal(): void { this.sealed = true; }
    close(error = new Error('acp_notification_closed')): void {
        if (this.failure) return;
        this.failure = error;
        this.sealed = true;
        this.jobs.length = 0;
        this.active = null;
        this.bytes = 0;
        this.controller.abort(error);
        for (const waiter of this.waiters) waiter.reject(error);
        this.waiters.clear();
    }
    drain(): Promise<void> {
        if (this.failure) return Promise.reject(this.failure);
        if (this.idle) return Promise.resolve();
        const pending = new Promise<void>((resolve, reject) => this.waiters.add({ resolve, reject }));
        void pending.catch(() => undefined);
        return pending;
    }
    private fail(error: Error): void {
        if (this.failure) return;
        this.close(error);
        try { this.failed(error); } catch { /* The closed queue cannot be resurrected by its owner. */ }
    }
    private schedule(): void {
        if (this.scheduled || this.active || this.failure) return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            if (!this.failure) void this.run();
        });
    }
    private async run(): Promise<void> {
        const job = this.jobs.shift();
        if (!job || this.failure) return;
        this.active = job;
        try { await job.consume(job.frame, this.controller.signal); }
        catch { this.fail(new Error('acp_notification_consumer_failed')); }
        finally {
            if (this.active === job) {
                this.active = null;
                this.bytes -= job.bytes;
            }
            if (!this.failure && this.idle) {
                for (const waiter of this.waiters) waiter.resolve();
                this.waiters.clear();
            }
            if (!this.failure) this.schedule();
        }
    }
}
