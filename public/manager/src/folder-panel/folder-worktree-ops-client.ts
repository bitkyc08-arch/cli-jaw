import { getDesktop } from '../panels/desktop-bridge';
import type {
    GitWorktreeEntry,
    GitWorktreeOperation,
    GitWorktreeOperationPreview,
} from './folder-worktree-types';

type PreviewResult = {
    ok: boolean;
    preview: GitWorktreeOperationPreview | null;
    error: string | null;
};

type RunResult = {
    ok: boolean;
    repoRoot: string | null;
    preview: GitWorktreeOperationPreview | null;
    stdout: string;
    worktrees: GitWorktreeEntry[];
    error: string | null;
};

type RunInput = {
    folderPanelRoot: string;
    repoRoot?: string | null;
    operation: GitWorktreeOperation;
    confirmed: boolean;
};

async function postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return await response.json() as T;
}

export async function previewWorktreeOperation(input: Omit<RunInput, 'confirmed'>): Promise<PreviewResult> {
    const repoRoot = input.repoRoot ?? undefined;
    try {
        const bridge = getDesktop()?.git;
        const bridgeResult = bridge
            ? await bridge.previewWorktreeOperation(input.folderPanelRoot, repoRoot, input.operation)
            : null;
        const result = bridgeResult?.ok
            ? bridgeResult
            : await postJson<{ ok: boolean; preview?: GitWorktreeOperationPreview; error?: string }>('/api/dashboard/git/worktree-operation-preview', {
                folderPanelRoot: input.folderPanelRoot,
                ...(repoRoot ? { repoRoot } : {}),
                operation: input.operation,
            });
        return {
            ok: result.ok,
            preview: result.preview ?? null,
            error: result.ok ? null : result.error ?? 'Failed to preview git operation',
        };
    } catch (error) {
        return {
            ok: false,
            preview: null,
            error: error instanceof Error ? error.message : 'Failed to preview git operation',
        };
    }
}

export async function runWorktreeOperation(input: RunInput): Promise<RunResult> {
    const repoRoot = input.repoRoot ?? undefined;
    try {
        const bridge = getDesktop()?.git;
        const bridgeResult = bridge
            ? await bridge.runWorktreeOperation(input.folderPanelRoot, repoRoot, input.operation, input.confirmed)
            : null;
        const result = bridgeResult?.ok
            ? bridgeResult
            : await postJson<{ ok: boolean; repoRoot?: string; preview?: GitWorktreeOperationPreview; stdout?: string; worktrees?: GitWorktreeEntry[]; error?: string }>('/api/dashboard/git/worktree-operation', {
                folderPanelRoot: input.folderPanelRoot,
                ...(repoRoot ? { repoRoot } : {}),
                operation: input.operation,
                confirmed: input.confirmed,
            });
        return {
            ok: result.ok,
            repoRoot: result.repoRoot ?? null,
            preview: result.preview ?? null,
            stdout: result.stdout ?? '',
            worktrees: result.worktrees ?? [],
            error: result.ok ? null : result.error ?? 'Git operation failed',
        };
    } catch (error) {
        return {
            ok: false,
            repoRoot: null,
            preview: null,
            stdout: '',
            worktrees: [],
            error: error instanceof Error ? error.message : 'Git operation failed',
        };
    }
}
