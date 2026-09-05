export interface ClaudeResultMetadata {
    sessionId?: string;
    /** Incremental cost for this jaw turn, never the resident query's running total. */
    cost?: number;
    turns?: number; durationMs?: number;
    tokens?: { input?: number; output?: number; cache_read?: number; cache_creation?: number };
}

/** A fresh SDK query (including resume) starts a fresh cumulative accounting window. */
export function createClaudeMetadata() {
    let cumulativeCost: number | undefined;
    let seenTerminal = false;
    return (raw: Record<string, unknown>, completed: boolean, sessionId: string): ClaudeResultMetadata => {
        const metadata: ClaudeResultMetadata = { ...(sessionId ? { sessionId } : {}) };
        for (const [wire, field] of [['num_turns', 'turns'], ['duration_ms', 'durationMs']] as const) {
            const value = raw[wire];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metadata[field] = value;
        }
        const total = raw['total_cost_usd'];
        if (completed && typeof total === 'number' && Number.isFinite(total) && total >= 0) {
            if (!seenTerminal) metadata.cost = total;
            else if (cumulativeCost !== undefined && total >= cumulativeCost) metadata.cost = total - cumulativeCost;
            // A reset/decrease gives no defensible delta for this turn. Re-anchor
            // only at the accepted terminal; missing/error results do not advance it.
            cumulativeCost = total;
        } else cumulativeCost = undefined;
        seenTerminal = true;
        const usage = raw['usage'];
        if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
            const tokens: NonNullable<ClaudeResultMetadata['tokens']> = {};
            for (const [wire, field] of [['input_tokens', 'input'], ['output_tokens', 'output'],
                ['cache_read_input_tokens', 'cache_read'], ['cache_creation_input_tokens', 'cache_creation']] as const) {
                const value: unknown = Reflect.get(usage, wire);
                if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) tokens[field] = value;
            }
            if (Object.keys(tokens).length) metadata.tokens = tokens;
        }
        return metadata;
    };
}
