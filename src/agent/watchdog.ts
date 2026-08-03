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

/** What last refreshed the deadline, so a stall report can say why we waited. */
type ProgressKind = 'output' | 'rate-limit' | 'structured';

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
    let lastProgressKind: ProgressKind | null = null;
    let outputOnlyProgress = 0;

    function markProgress(kind: ProgressKind = 'structured'): void {
        const now = Date.now();
        lastProgressAt = now;
        retryHits = 0;
        lastProgressKind = kind;
        // Raw output alone is a weak liveness signal: a progress bar or a log
        // loop keeps refreshing it while the turn itself is dead. Counting it
        // separately makes that visible in the stall report instead of hiding it.
        if (kind === 'output') outputOnlyProgress++;
        else outputOnlyProgress = 0;
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
            markProgress('rate-limit');
        } else if (RETRY_LOOP_PATTERN.test(text)) {
            retryHits++;
        } else if (text.trim().length > 10) {
            markProgress('output');
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

            // Naming what last counted as progress turns "it timed out" into a
            // diagnosable event: output-only liveness means nothing proved the
            // turn itself was still advancing.
            const progressNote = lastProgressKind
                ? `; lastProgress=${lastProgressKind}${outputOnlyProgress > 1 ? ` x${outputOnlyProgress}` : ''}`
                : '; lastProgress=none';
            onStall(`${reason}${progressNote}`);
        }
    }, cfg.checkIntervalMs);

    return {
        markProgress: (kind?: ProgressKind) => markProgress(kind),
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
