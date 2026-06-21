import { getDesktop } from '../panels/desktop-bridge';
import type { GitStatusMapResult } from './folder-git-types';

type LoadFolderGitStatusOptions = {
    repoRoot?: string;
    includeIgnored?: boolean;
    includeUntracked?: boolean;
};

type LoadFolderGitStatusResult =
    | { ok: true; status: GitStatusMapResult }
    | { ok: false; quiet: boolean; error: string };

function isQuietNonRepoError(error: string): boolean {
    return /not a git repository/i.test(error);
}

async function postStatusMap(folderPanelRoot: string, options: LoadFolderGitStatusOptions): Promise<{ ok: boolean; status?: GitStatusMapResult; error?: string }> {
    const response = await fetch('/api/dashboard/git/status-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            folderPanelRoot,
            ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
            options: {
                includeIgnored: options.includeIgnored !== false,
                includeUntracked: options.includeUntracked !== false,
            },
        }),
    });
    return await response.json() as { ok: boolean; status?: GitStatusMapResult; error?: string };
}

export async function loadFolderGitStatus(folderPanelRoot: string, options: LoadFolderGitStatusOptions = {}): Promise<LoadFolderGitStatusResult> {
    const bridge = getDesktop()?.git;
    const bridgeResult = bridge
        ? await bridge.getStatusMap(folderPanelRoot, options.repoRoot, {
            includeIgnored: options.includeIgnored !== false,
            includeUntracked: options.includeUntracked !== false,
        })
        : null;
    const result = bridgeResult?.ok
        ? bridgeResult
        : await postStatusMap(folderPanelRoot, options);
    if (result.ok && result.status) return { ok: true, status: result.status };
    const error = result.error ?? 'Failed to load git status';
    return { ok: false, quiet: isQuietNonRepoError(error), error };
}
