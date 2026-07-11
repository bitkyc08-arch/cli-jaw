// 042 — deterministic byte estimation + LRU downgrade/eviction policy.
// Pure policy module: the TurnStore owns when to apply planned steps; this
// module never deletes pinned entries — over-budget with all-pinned raises
// pressure instead (doc §2 pin rules). No window/react/fetch imports.

export type BodyFidelity = 'full' | 'preview' | 'summary' | 'stub';

export const FIDELITY_LADDER: readonly BodyFidelity[] = ['full', 'preview', 'summary', 'stub'];

const STRING_BYTES_PER_CHAR = 2; // UTF-16
const ENTRY_OVERHEAD = 32;
const VALUE_OVERHEAD = 8;

/** Deterministic byte estimate (UTF-16 string bytes + object overhead
 *  constants). CDP heap remains a separate system metric (doc §6). */
export function estimateBytes(value: unknown): number {
    if (value == null) return 0;
    if (typeof value === 'string') return value.length * STRING_BYTES_PER_CHAR + VALUE_OVERHEAD;
    if (typeof value === 'number' || typeof value === 'boolean') return VALUE_OVERHEAD;
    if (Array.isArray(value)) {
        let total = ENTRY_OVERHEAD;
        for (const item of value) total += estimateBytes(item);
        return total;
    }
    if (typeof value === 'object') {
        let total = ENTRY_OVERHEAD;
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            total += key.length * STRING_BYTES_PER_CHAR + estimateBytes(item);
        }
        return total;
    }
    return VALUE_OVERHEAD;
}

export interface BudgetEntry {
    key: string;
    bytes: number;
    pinned: boolean;
    fidelity: BodyFidelity;
    /** monotonically increasing LRU touch sequence */
    seq: number;
}

export interface TierBudget {
    limitBytes: number;
    /** entry-count cap (T2: 200 turns); null = bytes-only tier */
    maxEntries: number | null;
    /** 'downgrade' walks the fidelity ladder (T2); 'evict' removes (T3) */
    mode: 'downgrade' | 'evict';
    entries: Map<string, BudgetEntry>;
    totalBytes: number;
    touchSeq: number;
    pressure: boolean;
}

export function createTierBudget(
    limitBytes: number,
    options: { maxEntries?: number | null; mode?: 'downgrade' | 'evict' } = {},
): TierBudget {
    return {
        limitBytes,
        maxEntries: options.maxEntries ?? null,
        mode: options.mode ?? 'downgrade',
        entries: new Map(),
        totalBytes: 0,
        touchSeq: 0,
        pressure: false,
    };
}

export function touchEntry(
    budget: TierBudget,
    key: string,
    bytes: number,
    options: { pinned?: boolean; fidelity?: BodyFidelity } = {},
): void {
    const existing = budget.entries.get(key);
    budget.touchSeq += 1;
    if (existing) {
        budget.totalBytes += bytes - existing.bytes;
        existing.bytes = bytes;
        existing.seq = budget.touchSeq;
        if (options.pinned !== undefined) existing.pinned = options.pinned;
        if (options.fidelity !== undefined) existing.fidelity = options.fidelity;
        return;
    }
    budget.entries.set(key, {
        key,
        bytes,
        pinned: options.pinned ?? false,
        fidelity: options.fidelity ?? 'full',
        seq: budget.touchSeq,
    });
    budget.totalBytes += bytes;
}

export function removeEntry(budget: TierBudget, key: string): void {
    const entry = budget.entries.get(key);
    if (!entry) return;
    budget.entries.delete(key);
    budget.totalBytes -= entry.bytes;
}

export function setPinned(budget: TierBudget, key: string, pinned: boolean): void {
    const entry = budget.entries.get(key);
    if (entry) entry.pinned = pinned;
}

export function isOverBudget(budget: TierBudget): boolean {
    if (budget.totalBytes > budget.limitBytes) return true;
    if (budget.maxEntries !== null && budget.entries.size > budget.maxEntries) return true;
    return false;
}

export interface BudgetStep {
    key: string;
    action: 'downgrade' | 'evict';
    from: BodyFidelity;
    to: BodyFidelity | null;
}

/**
 * Plan ONE enforcement step: the oldest unpinned entry is downgraded one
 * ladder rung ('downgrade' mode) or removed ('evict' mode). Returns null when
 * nothing can move — the caller must then treat over-budget as pressure.
 */
export function planStep(budget: TierBudget): BudgetStep | null {
    if (!isOverBudget(budget)) return null;
    const overCount = budget.maxEntries !== null && budget.entries.size > budget.maxEntries;
    let victim: BudgetEntry | null = null;
    for (const entry of budget.entries.values()) {
        if (entry.pinned) continue;
        if (budget.mode === 'downgrade' && !overCount && entry.fidelity === 'stub') continue;
        if (!victim || entry.seq < victim.seq) victim = entry;
    }
    if (!victim) return null;
    if (budget.mode === 'evict' || overCount) {
        // count overflow removes the oldest entry outright: the ladder only
        // answers BYTE pressure — a 200-turn cap means 200 retained turns
        return { key: victim.key, action: 'evict', from: victim.fidelity, to: null };
    }
    const idx = FIDELITY_LADDER.indexOf(victim.fidelity);
    return { key: victim.key, action: 'downgrade', from: victim.fidelity, to: FIDELITY_LADDER[idx + 1] };
}

/**
 * Enforce the budget by repeatedly applying planned steps through `apply`
 * (the store recomputes shrunken bytes and calls touch/remove). Sets
 * `pressure` when the budget stays exceeded with only pinned entries left.
 */
export function enforceBudget(
    budget: TierBudget,
    apply: (step: BudgetStep) => void,
): BudgetStep[] {
    const steps: BudgetStep[] = [];
    // bounded loop: each step either removes an entry or moves it down a
    // finite ladder, so progress is guaranteed
    for (;;) {
        const step = planStep(budget);
        if (!step) break;
        const before = budget.totalBytes;
        const beforeCount = budget.entries.size;
        apply(step);
        steps.push(step);
        if (budget.totalBytes >= before && budget.entries.size >= beforeCount) {
            // defensive: apply() made no progress — stop instead of spinning
            break;
        }
    }
    budget.pressure = isOverBudget(budget);
    return steps;
}
