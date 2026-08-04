/**
 * Insertion-ordered Set with a FIFO bound. `Set` already preserves insertion
 * order, so the oldest entry is simply the first key — no side queue needed.
 *
 * Used for streaming dedupe sets, which otherwise grow for the lifetime of a
 * session (260803 unit, 050 phase D3).
 */
export function addBounded(set: Set<string>, key: string, max: number): void {
    set.add(key);
    while (set.size > max) {
        const oldest = set.values().next();
        if (oldest.done) return;
        set.delete(oldest.value);
    }
}
