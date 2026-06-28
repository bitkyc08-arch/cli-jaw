// Phase 20 (manager load plan): standalone per-stage timer for measuring the
// Manager dashboard request path. Dependency-free and pure so it is unit-testable
// without a live server. Uses a monotonic clock — never wall time — so a system
// clock change cannot produce negative or skewed stage durations.

export interface StageTiming {
    stages: Record<string, number>;
    totalMs: number;
}

export interface StageTimer {
    /** Record the elapsed time for `stage` since the previous mark (or start). */
    mark(stage: string): void;
    /** Finalize and return rounded per-stage durations plus the total. */
    measure(): StageTiming;
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

export function createStageTimer(now: () => number = () => performance.now()): StageTimer {
    const start = now();
    let last = start;
    const stages: Record<string, number> = {};
    return {
        mark(stage: string): void {
            const t = now();
            // Accumulate so a repeated stage name sums rather than overwrites, and
            // clamp at 0 so a backwards monotonic reading never yields a negative.
            stages[stage] = (stages[stage] ?? 0) + Math.max(0, t - last);
            last = t;
        },
        measure(): StageTiming {
            const total = Math.max(0, now() - start);
            const rounded: Record<string, number> = {};
            for (const [k, v] of Object.entries(stages)) rounded[k] = round2(v);
            return { stages: rounded, totalMs: round2(total) };
        },
    };
}
