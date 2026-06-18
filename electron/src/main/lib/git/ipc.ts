import { ipcMain } from 'electron';
import { isAllowedSender } from '../ipc-origin-guard.js';
import {
    getDiffSummary,
    getFileDiff,
    getRepoRoot,
    readCandidate,
    readDiffOptions,
    resolveRepoCandidates,
    type DiffRootCandidate,
} from '../../../../../src/manager/git/diff-service.js';
import { resolveFolderGitRoot } from '../../../../../src/manager/git/folder-root-validation.js';
import { getGitStatusMap, readGitStatusMapOptions } from '../../../../../src/manager/git/status-service.js';
import { readSourceControlOperation, runSourceControlOperation } from '../../../../../src/manager/git/source-control-operations.js';
import { getSourceControlSnapshot, readSourceControlSnapshotOptions } from '../../../../../src/manager/git/source-control-service.js';
import { getGitWorktrees } from '../../../../../src/manager/git/worktree-service.js';
import {
    readGitWorktreeOperation,
    runGitWorktreeOperation,
    validateGitWorktreeOperationPreviewContext,
} from '../../../../../src/manager/git/worktree-operations.js';

export function registerDiffIpc(): void {
    ipcMain.handle('diff:getRepoRoot', async (event, cwd: string) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        try {
            const root = await getRepoRoot(cwd);
            return { ok: true, root };
        } catch (error) {
            return { ok: false, error: (error as Error).message || 'not a git repository' };
        }
    });

    ipcMain.handle('diff:getRepoCandidates', async (event, rawCandidates: unknown) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        const candidates = Array.isArray(rawCandidates)
            ? rawCandidates.map(readCandidate).filter((candidate): candidate is DiffRootCandidate => candidate !== null)
            : [];
        return { ok: true, candidates: await resolveRepoCandidates(candidates) };
    });

    ipcMain.handle('diff:getDiffSummary', async (event, repoRoot: string, rawOptions?: unknown) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        const parsed = readDiffOptions(rawOptions);
        if (!parsed.ok) return parsed;
        try {
            const files = await getDiffSummary(repoRoot, parsed.options);
            return { ok: true, files };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('diff:getScmSnapshot', async (event, repoRoot: string, rawOptions?: unknown) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        try {
            const snapshot = await getSourceControlSnapshot(repoRoot, readSourceControlSnapshotOptions(rawOptions));
            return { ok: true, snapshot };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('diff:runScmOperation', async (event, repoRoot: string, rawOperation?: unknown) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        try {
            const operation = readSourceControlOperation(rawOperation);
            const result = await runSourceControlOperation(repoRoot, operation);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('diff:getFileDiff', async (event, repoRoot: string, filePath: string, rawOptions?: unknown) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        const parsed = readDiffOptions(rawOptions);
        if (!parsed.ok) return parsed;
        try {
            const diff = await getFileDiff(repoRoot, filePath, parsed.options);
            return { ok: true, diff };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('git:getStatusMap', async (event, folderPanelRoot: string, repoRoot?: string, rawOptions?: unknown) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        try {
            const resolved = await resolveFolderGitRoot(folderPanelRoot, repoRoot);
            const status = await getGitStatusMap(resolved.repoRoot, readGitStatusMapOptions(rawOptions));
            return { ok: true, status };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('git:getWorktrees', async (event, folderPanelRoot: string, repoRoot?: string) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        try {
            const resolved = await resolveFolderGitRoot(folderPanelRoot, repoRoot);
            const worktrees = await getGitWorktrees(resolved.repoRoot);
            return { ok: true, repoRoot: resolved.repoRoot, worktrees };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('git:previewWorktreeOperation', async (event, folderPanelRoot: string, repoRoot: string | undefined, rawOperation: unknown) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        try {
            const operation = readGitWorktreeOperation(rawOperation);
            const preview = await validateGitWorktreeOperationPreviewContext({ folderPanelRoot, repoRoot, operation });
            return { ok: true, preview };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });

    ipcMain.handle('git:runWorktreeOperation', async (event, folderPanelRoot: string, repoRoot: string | undefined, rawOperation: unknown, confirmed?: boolean) => {
        if (!isAllowedSender(event)) return { ok: false, error: 'unauthorized' };
        if (confirmed !== true) return { ok: false, error: 'confirmation required' };
        try {
            const operation = readGitWorktreeOperation(rawOperation);
            const resolved = await resolveFolderGitRoot(folderPanelRoot, repoRoot);
            const result = await runGitWorktreeOperation(resolved.repoRoot, operation);
            return { ok: true, ...result };
        } catch (err) {
            return { ok: false, error: (err as Error).message };
        }
    });
}
