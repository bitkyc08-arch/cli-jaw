import type { ChildProcess } from 'child_process';

const RETRY_LOOP_PATTERN = /(RESOURCE_EXHAUSTED|Too Many Requests|\bstatus[=: ]*429\b|MODEL_CAPACITY_EXHAUSTED|\bstatus[=: ]*503\b|UNAVAILABLE|OAuth2Client\.requestAsync|retryWithBackoff|GeminiChat\.streamWithRetries|Attempt \d+(?:\/\d+)? failed)/i;
const RATE_LIMIT_EVENT_PATTERN = /"type"\s*:\s*"rate_limit_event"/i;

interface WatchdogConfig {
    firstProgressMs: number;
    idleMs: number;
    absoluteMs: number;
    absoluteHardCapMs: number;
    checkIntervalMs: number;
}

export const DEFAULT_WATCHDOG_ABSOLUTE_HARD_CAP_MS = 4 * 60 * 60_000;

const DEFAULTS: WatchdogConfig = {
    firstProgressMs: 120_000,
    idleMs: 90_000,
    absoluteMs: 600_000,
    absoluteHardCapMs: DEFAULT_WATCHDOG_ABSOLUTE_HARD_CAP_MS,
    checkIntervalMs: 2_000,
};

export interface WatchdogHandle {
    markProgress(): void;
    extendDeadline(extraMs: number, reason?: string): void;
    stop(): void;
}

export function attachWatchdog(
    child: ChildProcess,
    _label: string,
    onStall: (reason: string) => void,
    config?: Partial<WatchdogConfig>,
): WatchdogHandle {
    const cfg = { ...DEFAULTS, ...config };
    const startedAt = Date.now();
    let absoluteDeadline = startedAt + cfg.absoluteMs;
    let lastProgressAt = 0;
    let retryHits = 0;
    let stopped = false;

    function markProgress(): void {
        const now = Date.now();
        lastProgressAt = now;
        retryHits = 0;
        const progressDeadline = now + cfg.absoluteMs;
        const hardCapDeadline = startedAt + cfg.absoluteHardCapMs;
        const nextDeadline = Math.min(progressDeadline, hardCapDeadline);
        if (nextDeadline > absoluteDeadline) {
            absoluteDeadline = nextDeadline;
        }
    }

    function observe(chunk: Buffer): void {
        const text = chunk.toString('utf8');
        if (RATE_LIMIT_EVENT_PATTERN.test(text)) {
            markProgress();
        } else if (RETRY_LOOP_PATTERN.test(text)) {
            retryHits++;
        } else if (text.trim().length > 10) {
            markProgress();
        }
    }

    const stdoutRef = child.stdout;
    const stderrRef = child.stderr;
    stdoutRef?.on('data', observe);
    stderrRef?.on('data', observe);

    const timer = setInterval(() => {
        if (stopped) return;
        const now = Date.now();
        const elapsed = now - startedAt;

        const noFirstProgress = lastProgressAt === 0 && elapsed > cfg.firstProgressMs;
        const idleWithRetries = retryHits >= 3 && lastProgressAt > 0
            && (now - lastProgressAt) > cfg.idleMs;
        const absoluteExpired = now > absoluteDeadline;

        if (noFirstProgress || idleWithRetries || absoluteExpired) {
            stopped = true;
            clearInterval(timer);

            const reason = absoluteExpired
                ? `absolute timeout ${Math.round(elapsed / 1000)}s`
                : noFirstProgress
                    ? `no first progress after ${Math.round(elapsed / 1000)}s`
                    : `idle ${Math.round((now - lastProgressAt) / 1000)}s with ${retryHits} retry hits`;

            onStall(reason);
        }
    }, cfg.checkIntervalMs);

    return {
        markProgress,
        extendDeadline(extraMs: number) {
            if (!Number.isFinite(extraMs) || extraMs <= 0) return;
            const hardCapDeadline = startedAt + Math.max(cfg.absoluteMs, cfg.absoluteHardCapMs);
            const requestedDeadline = Date.now() + extraMs;
            absoluteDeadline = Math.min(
                Math.max(absoluteDeadline, requestedDeadline),
                hardCapDeadline,
            );
        },
        stop() {
            stopped = true;
            clearInterval(timer);
            stdoutRef?.off('data', observe);
            stderrRef?.off('data', observe);
        },
    };
}
