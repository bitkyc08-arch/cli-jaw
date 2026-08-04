import { AsyncLocalStorage } from 'node:async_hooks';
import { settings } from '../core/config.js';

type MainJob = { start(): void };

export type SessionLaneStats = {
    active: number;
    waiting: number;
    sessions: number;
    maxConcurrent: number;
};

function positiveInt(value: unknown, fallback = 1): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class SessionLanes {
    private readonly sessionTails = new Map<string, Promise<void>>();
    private readonly waiting: MainJob[] = [];
    private readonly runningScope = new AsyncLocalStorage<string>();
    private active = 0;

    constructor(private readonly readMaxConcurrent: () => unknown = () => 1) {}

    run<T>(scopeKey: string, task: () => Promise<T>): Promise<T> {
        if (this.runningScope.getStore() === scopeKey) return Promise.resolve().then(task);

        return this.enqueue(scopeKey, task);
    }

    /** Reserve a real lane turn even when called from the same scope's async context. */
    runDetachedTurn<T>(scopeKey: string, task: () => Promise<T>): Promise<T> {
        return this.enqueue(scopeKey, task);
    }

    private enqueue<T>(scopeKey: string, task: () => Promise<T>): Promise<T> {
        const previous = this.sessionTails.get(scopeKey);
        let settleTail!: () => void;
        const tail = new Promise<void>(resolve => { settleTail = resolve; });
        this.sessionTails.set(scopeKey, tail);
        const start = () => this.runMain(() => this.runningScope.run(scopeKey, task));
        const result = previous
            ? previous.catch(() => undefined).then(start)
            : start();
        void result.then(settleTail, settleTail);
        void tail.then(() => {
            if (this.sessionTails.get(scopeKey) === tail) this.sessionTails.delete(scopeKey);
        });
        return result;
    }

    stats(): SessionLaneStats {
        return {
            active: this.active,
            waiting: this.waiting.length,
            sessions: this.sessionTails.size,
            maxConcurrent: positiveInt(this.readMaxConcurrent()),
        };
    }

    private runMain<T>(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.waiting.push({
                start: () => {
                    this.active += 1;
                    let taskPromise: Promise<T>;
                    try {
                        taskPromise = task();
                    } catch (error) {
                        taskPromise = Promise.reject(error);
                    }
                    void taskPromise.then(value => {
                        this.active -= 1;
                        this.pump();
                        resolve(value);
                    }, error => {
                        this.active -= 1;
                        this.pump();
                        reject(error);
                    });
                },
            });
            this.pump();
        });
    }

    private pump(): void {
        const limit = positiveInt(this.readMaxConcurrent());
        while (this.active < limit) {
            const job = this.waiting.shift();
            if (!job) break;
            job.start();
        }
    }
}

export const sessionLanes = new SessionLanes(
    () => settings["multiSession"]?.maxConcurrent ?? 1,
);
