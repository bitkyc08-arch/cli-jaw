type Entry = { scope: string; workerId?: string; cancel(reason: string): void; resolve(): void; done: Promise<void> };
const runs = new Map<string, Entry>();
const MAX_RUNS = 128;

/** Owns cancellation/completion only; sessions and scheduling remain with their existing owners. */
export function reserveClaudeRun(input: { runId: string; scope: string; workerId?: string; cancel(reason: string): void }) {
    if (runs.has(input.runId) || runs.size >= MAX_RUNS || (input.workerId && hasClaudeWorker(input.workerId))) {
        throw new Error('claude_run_already_registered_or_capacity');
    }
    let resolve!: () => void;
    const done = new Promise<void>(yes => { resolve = yes; });
    const entry: Entry = { ...input, done, resolve };
    runs.set(input.runId, entry);
    return {
        done,
        current: () => runs.get(input.runId) === entry,
        finish: () => { if (runs.get(input.runId) !== entry) return; runs.delete(input.runId); resolve(); },
    };
}
export function hasClaudeWorker(id: string): boolean { return [...runs.values()].some(entry => entry.workerId === id); }
export function hasClaudeRuns(scope?: string): boolean { return [...runs.values()].some(entry => scope === undefined || entry.scope === scope); }
export function cancelClaudeWorker(id: string, reason = 'user'): boolean {
    const entry = [...runs.values()].find(entry => entry.workerId === id);
    if (!entry) return false;
    entry.cancel(reason); return true;
}
export function cancelClaudeScope(scope: string, reason: string, includeWorkers: boolean): boolean {
    const selected = [...runs.values()].filter(entry => entry.scope === scope && (includeWorkers || !entry.workerId));
    for (const entry of selected) entry.cancel(reason);
    return selected.length > 0;
}
export function cancelAllClaudeRuns(reason: string): boolean {
    const selected = [...runs.values()];
    for (const entry of selected) entry.cancel(reason);
    return selected.length > 0;
}
