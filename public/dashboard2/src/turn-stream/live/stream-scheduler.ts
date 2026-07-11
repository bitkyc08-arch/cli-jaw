export interface StreamSchedulerOptions {
    raf?: (callback: () => void) => number;
    now?: () => number;
}

export interface StreamScheduler {
    push(chunk: string): void;
    flushNow(): void;
    dispose(): void;
    stats(): { flushCount: number; maxBatch: number };
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
    onFlush: (chunks: string[]) => void,
    options: StreamSchedulerOptions = {},
): StreamScheduler {
    const raf = options.raf ?? ((callback) => requestAnimationFrame(callback));
    const now = options.now ?? (() => performance.now());
    let buffered: string[] = [];
    let receivedChars = 0;
    let pendingFrame: number | null = null;
    let lastFlushAt = Number.NEGATIVE_INFINITY;
    let disposed = false;
    let flushCount = 0;
    let maxBatch = 0;

    function flush(): void {
        if (buffered.length === 0) return;
        const batch = buffered;
        buffered = [];
        flushCount++;
        maxBatch = Math.max(maxBatch, batch.length);
        lastFlushAt = now();
        onFlush(batch);
    }

    function schedule(): void {
        if (disposed || pendingFrame !== null || buffered.length === 0) return;
        pendingFrame = raf(() => {
            pendingFrame = null;
            if (disposed || buffered.length === 0) return;
            if (now() - lastFlushAt >= throttleMsFor(receivedChars)) {
                flush();
            }
            schedule();
        });
    }

    return {
        push(chunk) {
            if (disposed) return;
            buffered.push(chunk);
            receivedChars += chunk.length;
            schedule();
        },
        flushNow() {
            if (disposed) return;
            flush();
        },
        dispose() {
            disposed = true;
            buffered = [];
            pendingFrame = null;
        },
        stats() {
            return { flushCount, maxBatch };
        },
    };
}
