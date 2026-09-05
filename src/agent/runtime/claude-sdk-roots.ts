import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type ClaudeRootProcessState =
    | { kind: 'pending' | 'closed' }
    | { kind: 'single'; child: ChildProcessWithoutNullStreams }
    | { kind: 'multiple'; count: number };
export interface ClaudeRootWaitOptions { timeoutMs?: number; signal?: AbortSignal }

/** Observes existing SDK roots only. It neither spawns a process nor chooses among roots. */
export class ClaudeSdkRoots {
    private first: ChildProcessWithoutNullStreams | null = null;
    private count = 0;
    private closed = false;
    private failed = false;
    private readonly changed = new Set<() => void>();
    private readonly seen = new WeakSet<ChildProcessWithoutNullStreams>();

    constructor(private readonly multiple: () => void = () => {}) {}
    get state(): ClaudeRootProcessState {
        if (this.count > 1) return { kind: 'multiple', count: this.count };
        if (this.first) return { kind: 'single', child: this.first };
        return { kind: this.closed ? 'closed' : 'pending' };
    }
    get primary(): ChildProcessWithoutNullStreams | null { return this.count === 1 ? this.first : null; }

    track(child: ChildProcessWithoutNullStreams): void {
        if (this.seen.has(child)) return;
        this.seen.add(child); this.count++;
        if (!this.first) this.first = child;
        const notify = () => this.notify();
        const failed = () => { this.failed = true; this.notify(); };
        child.on('spawn', notify); child.on('exit', notify); child.on('error', failed);
        child.once('close', () => {
            child.off('spawn', notify); child.off('exit', notify); child.off('error', failed); this.notify();
        });
        this.notify();
        if (this.count === 2) queueMicrotask(this.multiple);
    }
    close(): void { this.closed = true; this.notify(); }
    private notify(): void { for (const notify of [...this.changed]) notify(); }
    private ready(): ChildProcessWithoutNullStreams | null {
        if (this.count > 1) throw new Error('claude_multiple_root_processes');
        if (this.closed) throw new Error('claude_root_closed');
        if (this.failed) throw new Error('claude_root_spawn_failed');
        const child = this.first;
        if (!child) return null;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('claude_root_exited');
        return Number.isSafeInteger(child.pid) && Number(child.pid) > 0 ? child : null;
    }
    async wait(options: ClaudeRootWaitOptions = {}): Promise<ChildProcessWithoutNullStreams> {
        const timeoutMs = options.timeoutMs ?? 5000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('claude_invalid_root_timeout');
        if (options.signal?.aborted) throw new Error('claude_root_wait_aborted');
        const ready = this.ready();
        if (!ready && this.changed.size >= 32) throw new Error('claude_root_wait_capacity');
        if (ready) await Promise.resolve();
        else await new Promise<void>((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); this.changed.delete(check); options.signal?.removeEventListener('abort', abort); };
            const abort = () => { cleanup(); reject(new Error('claude_root_wait_aborted')); };
            const check = () => {
                try { if (this.ready()) { cleanup(); resolve(); } }
                catch (error) { cleanup(); reject(error); }
            };
            const timer = setTimeout(() => { cleanup(); reject(new Error('claude_root_wait_timeout')); }, timeoutMs);
            this.changed.add(check); options.signal?.addEventListener('abort', abort, { once: true });
            if (options.signal?.aborted) abort(); else check();
        });
        if (options.signal?.aborted) throw new Error('claude_root_wait_aborted');
        const child = this.ready();
        if (!child) throw new Error('claude_root_unavailable');
        return child;
    }
}
