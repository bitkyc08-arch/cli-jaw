import express from 'express';
import { homedir } from 'node:os';
import type { DashboardDiffRootPolicy, DashboardInstance } from '../types.js';
import {
    buildDiffRootCandidates,
    getDiffSummary,
    getFileDiff,
    readDiffOptions,
    resolveRepoCandidates,
    type DiffRootSettings,
} from '../git/diff-service.js';
import { resolveFolderGitRoot } from '../git/folder-root-validation.js';
import { getGitStatusMap, readGitStatusMapOptions } from '../git/status-service.js';
import { readSourceControlOperation, runSourceControlOperation } from '../git/source-control-operations.js';
import { getSourceControlSnapshot, readSourceControlSnapshotOptions } from '../git/source-control-service.js';
import { getGitWorktrees } from '../git/worktree-service.js';
import {
    readGitWorktreeOperation,
    runGitWorktreeOperation,
    validateGitWorktreeOperationPreviewContext,
} from '../git/worktree-operations.js';

type DashboardGitRouterOptions = {
    homePath?: string;
    resolveInstance: (port: number) => Promise<DashboardInstance | null>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readPort(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readSettings(value: unknown): DiffRootSettings {
    const input = isRecord(value) ? value : {};
    const policy = input['diffRootPolicy'] === 'working-dir-first' || input['diffRootPolicy'] === 'manual'
        ? input['diffRootPolicy'] as DashboardDiffRootPolicy
        : 'project-first';
    const pinnedInput = isRecord(input['diffPinnedRootByPort']) ? input['diffPinnedRootByPort'] : {};
    const diffPinnedRootByPort: Record<string, string> = {};
    for (const [port, path] of Object.entries(pinnedInput)) {
        if (/^\d+$/.test(port) && typeof path === 'string' && path.trim()) diffPinnedRootByPort[port] = path.trim();
    }
    const recentInput = Array.isArray(input['diffRecentRepoRoots']) ? input['diffRecentRepoRoots'] : [];
    const diffRecentRepoRoots = recentInput
        .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
        .map(path => path.trim())
        .slice(0, 8);
    return { diffRootPolicy: policy, diffPinnedRootByPort, diffRecentRepoRoots };
}

async function resolveRootsForBody(body: unknown, options: DashboardGitRouterOptions) {
    const input = isRecord(body) ? body : {};
    const selectedInstancePort = readPort(input['selectedInstancePort']);
    if (selectedInstancePort == null) return { ok: false as const, status: 400, error: 'selectedInstancePort required' };
    const instance = await options.resolveInstance(selectedInstancePort);
    if (!instance) return { ok: false as const, status: 404, error: 'selected instance not found' };
    const settings = readSettings(input['settings']);
    const candidates = buildDiffRootCandidates(instance, options.homePath ?? homedir(), settings);
    const roots = await resolveRepoCandidates(candidates);
    return { ok: true as const, roots };
}

async function validateRepoRoot(body: unknown, options: DashboardGitRouterOptions, repoRoot: string) {
    const rootsResult = await resolveRootsForBody(body, options);
    if (!rootsResult.ok) return rootsResult;
    const root = rootsResult.roots.find(candidate => candidate.root === repoRoot);
    if (!root) return { ok: false as const, status: 403, error: 'repo root is not allowed for selected instance' };
    return { ok: true as const, root };
}

export function createDashboardGitRouter(options: DashboardGitRouterOptions): express.Router {
    const router = express.Router();

    router.post('/repo-candidates', async (req, res) => {
        try {
            const roots = await resolveRootsForBody(req.body, options);
            if (!roots.ok) {
                res.status(roots.status).json({ ok: false, error: roots.error });
                return;
            }
            res.json({ ok: true, candidates: roots.roots });
        } catch (error) {
            res.status(500).json({ ok: false, error: (error as Error).message });
        }
    });

    router.post('/diff-summary', async (req, res) => {
        try {
            const input = isRecord(req.body) ? req.body : {};
            const repoRoot = typeof input['repoRoot'] === 'string' ? input['repoRoot'] : '';
            const root = await validateRepoRoot(req.body, options, repoRoot);
            if (!root.ok) {
                res.status(root.status).json({ ok: false, error: root.error });
                return;
            }
            const parsed = readDiffOptions(input['options']);
            if (!parsed.ok) {
                res.status(400).json(parsed);
                return;
            }
            const files = await getDiffSummary(root.root.root, parsed.options);
            res.json({ ok: true, files });
        } catch (error) {
            res.status(500).json({ ok: false, error: (error as Error).message });
        }
    });

    router.post('/scm-snapshot', async (req, res) => {
        try {
            const input = isRecord(req.body) ? req.body : {};
            const repoRoot = typeof input['repoRoot'] === 'string' ? input['repoRoot'] : '';
            const root = await validateRepoRoot(req.body, options, repoRoot);
            if (!root.ok) {
                res.status(root.status).json({ ok: false, error: root.error });
                return;
            }
            const snapshot = await getSourceControlSnapshot(root.root.root, readSourceControlSnapshotOptions(input['options']));
            res.json({ ok: true, snapshot });
        } catch (error) {
            res.status(500).json({ ok: false, error: (error as Error).message });
        }
    });

    router.post('/scm-operation', async (req, res) => {
        try {
            const input = isRecord(req.body) ? req.body : {};
            const repoRoot = typeof input['repoRoot'] === 'string' ? input['repoRoot'] : '';
            const root = await validateRepoRoot(req.body, options, repoRoot);
            if (!root.ok) {
                res.status(root.status).json({ ok: false, error: root.error });
                return;
            }
            const operation = readSourceControlOperation(input['operation']);
            const result = await runSourceControlOperation(root.root.root, operation);
            res.json({ ok: true, result });
        } catch (error) {
            res.status(400).json({ ok: false, error: (error as Error).message });
        }
    });

    router.post('/file-diff', async (req, res) => {
        try {
            const input = isRecord(req.body) ? req.body : {};
            const repoRoot = typeof input['repoRoot'] === 'string' ? input['repoRoot'] : '';
            const filePath = typeof input['filePath'] === 'string' ? input['filePath'] : '';
            const root = await validateRepoRoot(req.body, options, repoRoot);
            if (!root.ok) {
                res.status(root.status).json({ ok: false, error: root.error });
                return;
            }
            const parsed = readDiffOptions(input['options']);
            if (!parsed.ok) {
                res.status(400).json(parsed);
                return;
            }
            const diff = await getFileDiff(root.root.root, filePath, parsed.options);
            res.json({ ok: true, diff });
        } catch (error) {
            res.status(500).json({ ok: false, error: (error as Error).message });
        }
    });

    router.post('/status-map', async (req, res) => {
        try {
            const input = isRecord(req.body) ? req.body : {};
            const folderPanelRoot = typeof input['folderPanelRoot'] === 'string' ? input['folderPanelRoot'] : '';
            const repoRoot = typeof input['repoRoot'] === 'string' ? input['repoRoot'] : undefined;
            const resolved = await resolveFolderGitRoot(folderPanelRoot, repoRoot);
            const status = await getGitStatusMap(resolved.repoRoot, readGitStatusMapOptions(input['options']));
            res.json({ ok: true, status });
        } catch (error) {
            res.status(400).json({ ok: false, error: (error as Error).message });
        }
    });

    router.post('/worktrees', async (req, res) => {
        try {
            const input = isRecord(req.body) ? req.body : {};
            const folderPanelRoot = typeof input['folderPanelRoot'] === 'string' ? input['folderPanelRoot'] : '';
            const repoRoot = typeof input['repoRoot'] === 'string' ? input['repoRoot'] : undefined;
            const resolved = await resolveFolderGitRoot(folderPanelRoot, repoRoot);
            const worktrees = await getGitWorktrees(resolved.repoRoot);
            res.json({ ok: true, repoRoot: resolved.repoRoot, worktrees });
        } catch (error) {
            res.status(400).json({ ok: false, error: (error as Error).message });
        }
    });

    router.post('/worktree-operation-preview', async (req, res) => {
        try {
            const input = isRecord(req.body) ? req.body : {};
            const folderPanelRoot = typeof input['folderPanelRoot'] === 'string' ? input['folderPanelRoot'] : '';
            const repoRoot = typeof input['repoRoot'] === 'string' ? input['repoRoot'] : undefined;
            const operation = readGitWorktreeOperation(input['operation']);
            const preview = await validateGitWorktreeOperationPreviewContext({ folderPanelRoot, repoRoot, operation });
            res.json({ ok: true, preview });
        } catch (error) {
            res.status(400).json({ ok: false, error: (error as Error).message });
        }
    });

    router.post('/worktree-operation', async (req, res) => {
        try {
            const input = isRecord(req.body) ? req.body : {};
            if (input['confirmed'] !== true) {
                res.status(400).json({ ok: false, error: 'confirmation required' });
                return;
            }
            const folderPanelRoot = typeof input['folderPanelRoot'] === 'string' ? input['folderPanelRoot'] : '';
            const repoRoot = typeof input['repoRoot'] === 'string' ? input['repoRoot'] : undefined;
            const operation = readGitWorktreeOperation(input['operation']);
            const resolved = await resolveFolderGitRoot(folderPanelRoot, repoRoot);
            const result = await runGitWorktreeOperation(resolved.repoRoot, operation);
            res.json({ ok: true, ...result });
        } catch (error) {
            res.status(400).json({ ok: false, error: (error as Error).message });
        }
    });

    return router;
}
