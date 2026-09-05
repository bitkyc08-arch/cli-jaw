/** A pending fallback keeps its Stop observation until its actual enqueue decision. */
export interface SteerInputGuard {
    isCancelled(): boolean;
    release(): void;
}
type Token = { cancelled: boolean };
const pending = new Map<string, Set<Token>>();

export function beginSteerInput(scope: string): SteerInputGuard {
    let tokens = pending.get(scope);
    if (!tokens) { tokens = new Set(); pending.set(scope, tokens); }
    const owned = tokens, token: Token = { cancelled: false };
    owned.add(token);
    let released = false;
    return {
        isCancelled: () => released || token.cancelled,
        release: () => {
            if (released) return;
            released = true; owned.delete(token);
            if (!owned.size && pending.get(scope) === owned) pending.delete(scope);
        },
    };
}

export function cancelSteerInputs(scope: string): void {
    const tokens = pending.get(scope);
    pending.delete(scope); // genuinely new post-Stop input receives a fresh set
    for (const token of tokens ?? []) token.cancelled = true;
}

export function cancelAllSteerInputs(): void {
    for (const scope of pending.keys()) cancelSteerInputs(scope);
}
