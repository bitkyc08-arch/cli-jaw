export interface StreamSchedulerOptions {
    raf?: (callback: () => void) => number;
    now?: () => number;
}

export type StreamTurnKey = string;

export interface StreamScheduler {
    beginTurn(key: StreamTurnKey): void;
    push(key: StreamTurnKey, chunk: string): void;
    flushTurn(key: StreamTurnKey): void;
    resetTurn(key: StreamTurnKey): void;
    resetAll(): void;
    stats(key: StreamTurnKey): {
        receivedChars: number;
        flushCount: number;
        maxBatch: number;
    } | null;
    dispose(): void;
}

const FULL_SPEED_CHARS = 2_000;
const BASE_THROTTLE_MS = 80;
const MAX_THROTTLE_MS = 400;

function throttleMsFor(charCount: number): number {
    if (charCount <= FULL_SPEED_CHARS) return 0;
    return Math.min(
        MAX_THROTTLE_MS,
        Math.round(BASE_THROTTLE_MS * (charCount / FULL_SPEED_CHARS)),
    );
}

export function createStreamScheduler(
    onFlush: (key: StreamTurnKey, chunks: readonly string[]) => void,
    options: StreamSchedulerOptions = {},
): StreamScheduler {
    const raf = options.raf ?? ((callback) => requestAnimationFrame(callback));
    const now = options.now ?? (() => performance.now());
    interface TurnState {
        buffered: string[];
        receivedChars: number;
        lastFlushAt: number;
        flushCount: number;
        maxBatch: number;
    }

    const turns = new Map<StreamTurnKey, TurnState>();
    let pendingFrame: number | null = null;
    let disposed = false;

    function begin(key: StreamTurnKey): void {
        if (disposed || turns.has(key)) return;
        turns.set(key, {
            buffered: [], receivedChars: 0,
            lastFlushAt: Number.NEGATIVE_INFINITY,
            flushCount: 0, maxBatch: 0,
        });
    }

    function flush(key: StreamTurnKey, state: TurnState): void {
        if (state.buffered.length === 0) return;
        const batch = state.buffered;
        state.buffered = [];
        state.flushCount++;
        state.maxBatch = Math.max(state.maxBatch, batch.length);
        state.lastFlushAt = now();
        onFlush(key, batch);
    }

    function schedule(): void {
        if (disposed || pendingFrame !== null
            || ![...turns.values()].some(state => state.buffered.length > 0)) return;
        pendingFrame = raf(() => {
            pendingFrame = null;
            if (disposed) return;
            const timestamp = now();
            for (const [key, state] of turns) {
                if (state.buffered.length > 0
                    && timestamp - state.lastFlushAt >= throttleMsFor(state.receivedChars)) {
                    flush(key, state);
                }
            }
            schedule();
        });
    }

    return {
        beginTurn(key) {
            begin(key);
        },
        push(key, chunk) {
            if (disposed) return;
            begin(key);
            const state = turns.get(key)!;
            state.buffered.push(chunk);
            state.receivedChars += chunk.length;
            schedule();
        },
        flushTurn(key) {
            if (disposed) return;
            const state = turns.get(key);
            if (state) flush(key, state);
        },
        resetTurn(key) {
            if (disposed) return;
            turns.delete(key);
        },
        resetAll() {
            if (disposed) return;
            turns.clear();
        },
        dispose() {
            disposed = true;
            turns.clear();
            pendingFrame = null;
        },
        stats(key) {
            const state = turns.get(key);
            return state ? {
                receivedChars: state.receivedChars,
                flushCount: state.flushCount,
                maxBatch: state.maxBatch,
            } : null;
        },
    };
}
