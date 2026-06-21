import { getDesktop } from '../panels/desktop-bridge';
import type { GitWorktreeEntry } from './folder-worktree-types';

type LoadGitWorktreesResult = {
    ok: boolean;
    repoRoot: string | null;
    worktrees: GitWorktreeEntry[];
    error: string | null;
};

function isQuietNonRepoError(error: string): boolean {
    return /not a git repository/i.test(error);
}

async function postWorktrees(folderPanelRoot: string, repoRoot?: string): Promise<{ ok: boolean; repoRoot?: string; worktrees?: GitWorktreeEntry[]; error?: string }> {
    const response = await fetch('/api/dashboard/git/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            folderPanelRoot,
            ...(repoRoot ? { repoRoot } : {}),
        }),
    });
    return await response.json() as { ok: boolean; repoRoot?: string; worktrees?: GitWorktreeEntry[]; error?: string };
}

export async function fetchGitWorktrees(folderPanelRoot: string, repoRoot?: string | null): Promise<LoadGitWorktreesResult> {
    const requestedRepoRoot = repoRoot ?? undefined;
    try {
        const bridge = getDesktop()?.git;
        const bridgeResult = bridge
            ? await bridge.getWorktrees(folderPanelRoot, requestedRepoRoot)
            : null;
        const result = bridgeResult?.ok
            ? bridgeResult
            : await postWorktrees(folderPanelRoot, requestedRepoRoot);
        if (result.ok) {
            return {
                ok: true,
                repoRoot: result.repoRoot ?? requestedRepoRoot ?? null,
                worktrees: result.worktrees ?? [],
                error: null,
            };
        }
        const error = result.error ?? 'Failed to load git worktrees';
        return {
            ok: false,
            repoRoot: null,
            worktrees: [],
            error: isQuietNonRepoError(error) ? null : error,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load git worktrees';
        return {
            ok: false,
            repoRoot: null,
            worktrees: [],
            error: isQuietNonRepoError(message) ? null : message,
        };
    }
}
