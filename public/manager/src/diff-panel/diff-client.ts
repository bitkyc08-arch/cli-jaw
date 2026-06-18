import type { DiffBridgeApi, DiffOptions, DiffRootCandidate, DiffResolvedRoot } from '../panels/desktop-bridge';
import type { DashboardInstance, DashboardRegistryUi } from '../types';

type DiffSettings = Pick<DashboardRegistryUi, 'diffRootPolicy' | 'diffPinnedRootByPort' | 'diffRecentRepoRoots'>;

async function postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null) as T & { ok?: boolean; error?: string } | null;
    if (!response.ok || !data) return { ok: false, error: data?.error ?? `request failed: ${response.status}` } as T;
    return data as T;
}

function baseBody(instance: DashboardInstance | null, settings: DiffSettings): { selectedInstancePort: number | null; settings: DiffSettings } {
    return {
        selectedInstancePort: instance?.port ?? null,
        settings: {
            diffRootPolicy: settings.diffRootPolicy,
            diffPinnedRootByPort: settings.diffPinnedRootByPort,
            diffRecentRepoRoots: settings.diffRecentRepoRoots,
        },
    };
}

export function createDashboardGitDiffClient(
    instance: DashboardInstance | null,
    settings: DiffSettings,
): DiffBridgeApi {
    return {
        getRepoRoot: async () => ({ ok: false, error: 'Repository root resolution is server-derived in web mode' }),
        getRepoCandidates: async (_candidates: DiffRootCandidate[]) => postJson<{ ok: boolean; candidates?: DiffResolvedRoot[]; error?: string }>(
            '/api/dashboard/git/repo-candidates',
            baseBody(instance, settings),
        ),
        getScmSnapshot: async (repoRoot: string, options?: { includeUntracked?: boolean }) => postJson(
            '/api/dashboard/git/scm-snapshot',
            { ...baseBody(instance, settings), repoRoot, options },
        ),
        runScmOperation: async (repoRoot, operation) => postJson(
            '/api/dashboard/git/scm-operation',
            { ...baseBody(instance, settings), repoRoot, operation },
        ),
        getDiffSummary: async (repoRoot: string, options: DiffOptions) => postJson(
            '/api/dashboard/git/diff-summary',
            { ...baseBody(instance, settings), repoRoot, options },
        ),
        getFileDiff: async (repoRoot: string, filePath: string, options: DiffOptions) => postJson(
            '/api/dashboard/git/file-diff',
            { ...baseBody(instance, settings), repoRoot, filePath, options },
        ),
    };
}
