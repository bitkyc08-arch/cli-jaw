import type { DiffBridgeApi, DiffOptions, SourceControlOperation } from '../../providers/desktop-bridge-contract.ts';

export interface DiffTransport {
    resolveRepoRoot(workingDir: string): Promise<string>;
    getSummary(repoRoot: string, options: DiffOptions): Promise<Array<{ path: string; status: string; insertions: number; deletions: number }>>;
    getFileDiff(repoRoot: string, filePath: string, options: DiffOptions): Promise<string>;
    runScmOperation(repoRoot: string, operation: SourceControlOperation): Promise<void>;
}

function requireOk<T extends { ok: boolean; error?: string }>(result: T, fallback: string): T {
    if (!result.ok) throw new Error(result.error ?? fallback);
    return result;
}

export function createNativeDiffTransport(native: DiffBridgeApi): DiffTransport {
    return {
        async resolveRepoRoot(workingDir) {
            const direct = await native.getRepoRoot(workingDir);
            if (direct.ok && direct.root) return direct.root;
            const candidates = requireOk(await native.getRepoCandidates([
                { path: workingDir, label: 'Working dir', source: 'working-dir' },
            ]), 'Unable to resolve repository root');
            const root = candidates.candidates?.[0]?.root;
            if (!root) throw new Error(direct.error ?? 'No repository found for the selected instance');
            return root;
        },
        async getSummary(repoRoot, options) {
            const result = requireOk(await native.getDiffSummary(repoRoot, options), 'Unable to load diff summary');
            return result.files ?? [];
        },
        async getFileDiff(repoRoot, filePath, options) {
            const result = requireOk(await native.getFileDiff(repoRoot, filePath, options), 'Unable to load file diff');
            return result.diff ?? '';
        },
        async runScmOperation(repoRoot, operation) {
            requireOk(await native.runScmOperation(repoRoot, operation), 'Source-control operation failed');
        },
    };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (!response.ok || !result) throw new Error(result?.error ?? `Request failed (${response.status})`);
    return result;
}

export function createDashboardGitDiffTransport(selectedInstancePort: number): DiffTransport {
    const base = { selectedInstancePort, settings: {} };
    return {
        async resolveRepoRoot() {
            const result = await postJson<{ ok: boolean; candidates?: Array<{ root: string }> }>(
                '/api/dashboard/git/repo-candidates',
                base,
            );
            const root = result.candidates?.[0]?.root;
            if (!root) throw new Error('No repository found for the selected instance');
            return root;
        },
        async getSummary(repoRoot, options) {
            const result = await postJson<{ ok: boolean; files?: Array<{ path: string; status: string; insertions: number; deletions: number }> }>(
                '/api/dashboard/git/diff-summary', { ...base, repoRoot, options },
            );
            return result.files ?? [];
        },
        async getFileDiff(repoRoot, filePath, options) {
            const result = await postJson<{ ok: boolean; diff?: string }>(
                '/api/dashboard/git/file-diff', { ...base, repoRoot, filePath, options },
            );
            return result.diff ?? '';
        },
        async runScmOperation(repoRoot, operation) {
            await postJson('/api/dashboard/git/scm-operation', { ...base, repoRoot, operation });
        },
    };
}

export function selectDiffTransport(native: DiffBridgeApi | null, selectedInstancePort: number): DiffTransport {
    return native ? createNativeDiffTransport(native) : createDashboardGitDiffTransport(selectedInstancePort);
}
