import type { DiffBridgeApi } from '../panels/desktop-bridge';

async function withDiffFallback<T extends { ok: boolean; error?: string }>(
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
): Promise<T> {
    const result = await primary();
    return result.ok ? result : fallback();
}

export function createResilientDiffBridge(desktopBridge: DiffBridgeApi | null, fallbackBridge: DiffBridgeApi): DiffBridgeApi {
    if (!desktopBridge) return fallbackBridge;
    return {
        getRepoRoot: (cwd) => withDiffFallback(
            () => desktopBridge.getRepoRoot(cwd),
            () => fallbackBridge.getRepoRoot(cwd),
        ),
        getRepoCandidates: (candidates) => withDiffFallback(
            () => desktopBridge.getRepoCandidates(candidates),
            () => fallbackBridge.getRepoCandidates(candidates),
        ),
        getScmSnapshot: (repoRoot, options) => withDiffFallback(
            () => desktopBridge.getScmSnapshot(repoRoot, options),
            () => fallbackBridge.getScmSnapshot(repoRoot, options),
        ),
        runScmOperation: (repoRoot, operation) => withDiffFallback(
            () => desktopBridge.runScmOperation(repoRoot, operation),
            () => fallbackBridge.runScmOperation(repoRoot, operation),
        ),
        getDiffSummary: (repoRoot, options) => withDiffFallback(
            () => desktopBridge.getDiffSummary(repoRoot, options),
            () => fallbackBridge.getDiffSummary(repoRoot, options),
        ),
        getFileDiff: (repoRoot, filePath, options) => withDiffFallback(
            () => desktopBridge.getFileDiff(repoRoot, filePath, options),
            () => fallbackBridge.getFileDiff(repoRoot, filePath, options),
        ),
    };
}
