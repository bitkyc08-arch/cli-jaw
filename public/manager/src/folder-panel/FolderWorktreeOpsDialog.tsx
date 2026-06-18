import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FolderGitOperationHistoryItem } from './folder-git-operation-history';
import { previewWorktreeOperation } from './folder-worktree-ops-client';
import { FolderWorktreeOperationHistory } from './FolderWorktreeOperationHistory';
import type {
    GitWorktreeEntry,
    GitWorktreeOperation,
    GitWorktreeOperationPreview,
} from './folder-worktree-types';

type FolderWorktreeOpsDialogProps = {
    folderPanelRoot: string;
    repoRoot: string | null;
    worktrees: GitWorktreeEntry[];
    busy: boolean;
    history: FolderGitOperationHistoryItem[];
    onRun: (operation: GitWorktreeOperation, preview: GitWorktreeOperationPreview | null) => void;
    onClose: () => void;
};

type OperationMode = GitWorktreeOperation['type'];

function worktreeName(path: string): string {
    return path.split('/').filter(Boolean).pop() || path;
}

function commandText(preview: GitWorktreeOperationPreview | null): string {
    return preview ? preview.command.join(' ') : 'Preview unavailable';
}

export function FolderWorktreeOpsDialog(props: FolderWorktreeOpsDialogProps) {
    const [mode, setMode] = useState<OperationMode>('worktree-add');
    const [targetPath, setTargetPath] = useState('');
    const [branch, setBranch] = useState('');
    const [createBranch, setCreateBranch] = useState(false);
    const [removePath, setRemovePath] = useState(props.worktrees.find(entry => !entry.current)?.path ?? props.worktrees[0]?.path ?? '');
    const [forceRemove, setForceRemove] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [previewResult, setPreviewResult] = useState<GitWorktreeOperationPreview | null>(null);

    const applyOperation = useCallback((nextOperation: GitWorktreeOperation) => {
        setMode(nextOperation.type);
        setConfirmed(false);
        if (nextOperation.type === 'worktree-add') {
            setTargetPath(nextOperation.path);
            setBranch(nextOperation.branch);
            setCreateBranch(nextOperation.createBranch);
        }
        if (nextOperation.type === 'worktree-remove') {
            setRemovePath(nextOperation.path);
            setForceRemove(nextOperation.force);
        }
    }, []);

    const operation = useMemo<GitWorktreeOperation>(() => {
        if (mode === 'worktree-add') {
            return { type: mode, path: targetPath, branch, createBranch };
        }
        if (mode === 'worktree-remove') {
            return { type: mode, path: removePath, force: forceRemove };
        }
        return { type: mode };
    }, [branch, createBranch, forceRemove, mode, removePath, targetPath]);

    useEffect(() => {
        let cancelled = false;
        setConfirmed(false);
        setPreviewLoading(true);
        setPreviewError(null);
        setPreviewResult(null);
        void (async () => {
            const result = await previewWorktreeOperation({
                folderPanelRoot: props.folderPanelRoot,
                repoRoot: props.repoRoot,
                operation,
            });
            if (cancelled) return;
            setPreviewLoading(false);
            setPreviewResult(result.preview);
            setPreviewError(result.error);
        })();
        return () => { cancelled = true; };
    }, [operation, props.folderPanelRoot, props.repoRoot]);

    const canRun = confirmed && previewResult !== null && !previewError && !previewLoading && !props.busy;
    const isRemove = mode === 'worktree-remove';

    return (
        <div className="folder-worktree-ops" role="dialog" aria-label="Git worktree operations">
            <div className="folder-worktree-ops__panel">
                <div className="folder-worktree-ops__header">
                    <span>Worktree Ops</span>
                    <button type="button" onClick={props.onClose} disabled={props.busy}>Close</button>
                </div>
                <div className="folder-worktree-ops__row">
                    <label>
                        Operation
                        <select value={mode} onChange={event => setMode(event.target.value as OperationMode)} disabled={props.busy}>
                            <option value="worktree-add">Add worktree</option>
                            <option value="worktree-remove">Remove worktree</option>
                            <option value="worktree-prune">Prune stale worktrees</option>
                        </select>
                    </label>
                </div>
                {mode === 'worktree-add' && (
                    <>
                        <div className="folder-worktree-ops__row">
                            <label>
                                Path
                                <input value={targetPath} onChange={event => setTargetPath(event.target.value)} placeholder="/Users/jun/..." disabled={props.busy} />
                            </label>
                        </div>
                        <div className="folder-worktree-ops__row">
                            <label>
                                Branch / ref
                                <input value={branch} onChange={event => setBranch(event.target.value)} placeholder="feature/name" disabled={props.busy} />
                            </label>
                            <label className="folder-worktree-ops__check">
                                <input type="checkbox" checked={createBranch} onChange={event => setCreateBranch(event.target.checked)} disabled={props.busy} />
                                Create branch
                            </label>
                        </div>
                    </>
                )}
                {isRemove && (
                    <>
                        <div className="folder-worktree-ops__row">
                            <label>
                                Worktree
                                <select value={removePath} onChange={event => setRemovePath(event.target.value)} disabled={props.busy}>
                                    {props.worktrees.map(entry => (
                                        <option key={entry.path} value={entry.path}>{worktreeName(entry.path)} - {entry.path}</option>
                                    ))}
                                </select>
                            </label>
                        </div>
                        <label className="folder-worktree-ops__warning">
                            <input type="checkbox" checked={forceRemove} onChange={event => setForceRemove(event.target.checked)} disabled={props.busy} />
                            Force remove dirty worktree
                        </label>
                    </>
                )}
                <div className="folder-worktree-ops__preview" aria-busy={previewLoading}>
                    {previewLoading ? 'Previewing command...' : commandText(previewResult)}
                </div>
                {previewError && <div className="folder-worktree-ops__warning">{previewError}</div>}
                {isRemove && !forceRemove && (
                    <div className="folder-worktree-ops__hint">Dirty worktrees are blocked unless force remove is explicitly checked.</div>
                )}
                {isRemove && forceRemove && (
                    <div className="folder-worktree-ops__hint">Preview changes to git worktree remove --force for this target.</div>
                )}
                <label className="folder-worktree-ops__check">
                    <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={previewResult === null || Boolean(previewError) || props.busy} />
                    I understand this will run the previewed git command.
                </label>
                <div className="folder-worktree-ops__actions">
                    <button type="button" className="folder-action-btn" onClick={props.onClose} disabled={props.busy}>Cancel</button>
                    <button type="button" className="folder-action-btn is-primary" disabled={!canRun} onClick={() => props.onRun(operation, previewResult)}>
                        {props.busy ? 'Running...' : 'Run'}
                    </button>
                </div>
                <FolderWorktreeOperationHistory
                    history={props.history}
                    busy={props.busy}
                    onRetry={applyOperation}
                />
            </div>
        </div>
    );
}
