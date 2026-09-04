// Which runtimes just told us they are out of capacity.
//
// Without this, a 429 on the primary runtime picks a fallback, that fallback
// finishes, and the very next turn walks back into the same exhausted runtime —
// so a rate limit that lasts a minute costs every turn in that minute. The
// registry lets the fallback search skip a runtime that is still parked.
//
// Keyed by the RUNTIME name (`lifecycleRuntimeCli`'s output), not the registry
// name, and read with the same key: an `ai-e` turn records under `claude-e`,
// so a search keyed on `ai-e` would never see its own cooldown and the feature
// would silently do nothing for exactly the aliased runtime.

const cooldowns = new Map<string, number>();

/** How long to park a runtime that returned 429 without saying for how long.
 *  Short on purpose: the cost of guessing high is a runtime skipped while it
 *  was already healthy again. */
export const DEFAULT_COOLDOWN_MS = 60_000;

/** Park a runtime for as long as the provider asked, bounded by the caller. */
export function noteRuntimeCooldown(runtimeCli: string, ms: number): void {
    if (!runtimeCli || !Number.isFinite(ms) || ms <= 0) return;
    cooldowns.set(runtimeCli, Date.now() + ms);
}

/** True while the runtime is still parked. Expiry is lazy — a stale entry is
 *  dropped on read rather than swept, so nothing has to own a timer. */
export function isRuntimeCoolingDown(runtimeCli: string): boolean {
    const until = cooldowns.get(runtimeCli);
    if (until === undefined) return false;
    if (Date.now() >= until) {
        cooldowns.delete(runtimeCli);
        return false;
    }
    return true;
}

/** A successful run is the only proof that capacity came back. */
export function clearRuntimeCooldown(runtimeCli: string): void {
    cooldowns.delete(runtimeCli);
}

/** Tests only: the registry outlives a single turn by design. */
export function resetRuntimeCooldowns(): void {
    cooldowns.clear();
}
