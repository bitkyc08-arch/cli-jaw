import { useEffect, useMemo, useState } from 'react';
import type { CodeGitInfo, CodeModelOptions } from './code-session-client';
import { getDesktop } from '../panels/desktop-bridge';

type CodeWorkspaceHeaderProps = {
    workingDir: string;
    gitInfo: CodeGitInfo | null;
    modelOptions: CodeModelOptions | null;
    sessionTitle: string;
    usage: { contextTokens?: number; contextLimit?: number; cost?: number };
    planEntries: Array<{ title: string; status: string }>;
    onWorkingDirChange?: ((path: string | null) => void) | undefined;
    cwdLocked?: boolean | undefined;
};

function shortPath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts.slice(-2).join('/') || path;
}

export function CodeWorkspaceHeader({ workingDir, gitInfo, modelOptions, sessionTitle, usage, planEntries, onWorkingDirChange, cwdLocked = false }: CodeWorkspaceHeaderProps) {
    const [draftCwd, setDraftCwd] = useState(workingDir);
    const [pickingCwd, setPickingCwd] = useState(false);
    const [cwdPickError, setCwdPickError] = useState('');
    const dirty = gitInfo?.status?.dirty;
    const worktreeCount = gitInfo?.worktrees.length ?? 0;
    const trimmedDraft = useMemo(() => draftCwd.trim(), [draftCwd]);
    const cwdError = trimmedDraft && !trimmedDraft.startsWith('/') ? 'Use an absolute path.' : '';
    const desktop = getDesktop();
    const canApplyCwd = Boolean(!cwdLocked && onWorkingDirChange && trimmedDraft && trimmedDraft !== workingDir && !cwdError);
    const canPickCwd = Boolean(!cwdLocked && onWorkingDirChange && desktop?.folder?.pickFolder);

    useEffect(() => {
        setDraftCwd(workingDir);
    }, [workingDir]);

    async function pickWorkingDir(): Promise<void> {
        if (!canPickCwd || !desktop?.folder?.pickFolder) return;
        setPickingCwd(true);
        setCwdPickError('');
        try {
            const result = await desktop.folder.pickFolder();
            if (!result.ok || !result.path) {
                if (result.error && result.error !== 'cancelled') setCwdPickError(result.error);
                return;
            }
            setDraftCwd(result.path);
            onWorkingDirChange?.(result.path);
        } catch (err) {
            setCwdPickError(err instanceof Error ? err.message : String(err));
        } finally {
            setPickingCwd(false);
        }
    }

    return (
        <div className="code-workspace-header">
            <div className="code-workspace-primary">
                <span className="code-workspace-cwd" title={workingDir}>{shortPath(workingDir || '/tmp')}</span>
                <div className="code-workspace-cwd-control">
                    <input
                        className={`code-workspace-cwd-input${cwdError ? ' is-invalid' : ''}`}
                        type="text"
                        value={draftCwd}
                        onChange={event => setDraftCwd(event.target.value)}
                        placeholder="/absolute/path/to/project"
                        aria-label="Code working directory"
                        aria-readonly={cwdLocked}
                        disabled={cwdLocked}
                        title={cwdLocked ? 'CWD is fixed for the active Code session.' : undefined}
                    />
                    <button
                        type="button"
                        className="code-workspace-cwd-apply"
                        disabled={!canApplyCwd}
                        title={cwdLocked ? 'CWD is fixed for the active Code session.' : cwdError || 'Apply Code working directory'}
                        onClick={() => {
                            if (!canApplyCwd) return;
                            onWorkingDirChange?.(trimmedDraft);
                        }}
                    >
                        Apply
                    </button>
                    {canPickCwd && (
                        <button
                            type="button"
                            className="code-workspace-cwd-pick"
                            disabled={pickingCwd}
                            title="Choose Code working directory"
                            onClick={() => void pickWorkingDir()}
                        >
                            Browse
                        </button>
                    )}
                </div>
                {cwdLocked ? (
                    <span className="code-workspace-cwd-lock">fixed for this session</span>
                ) : cwdPickError ? (
                    <span className="code-workspace-cwd-error">{cwdPickError}</span>
                ) : null}
                {gitInfo?.isRepo && (
                    <>
                        <span className="code-workspace-pill">{gitInfo.branch ?? 'detached'}{gitInfo.head ? ` · ${gitInfo.head}` : ''}</span>
                        <span className={`code-workspace-pill ${dirty ? 'is-dirty' : ''}`}>
                            {dirty ? `${gitInfo.status?.changed ?? 0} changed · ${gitInfo.status?.untracked ?? 0} untracked` : 'clean'}
                        </span>
                        <span className="code-workspace-pill">worktrees {worktreeCount}</span>
                    </>
                )}
                {modelOptions?.degraded && <span className="code-workspace-pill is-warning" title={modelOptions.error}>provider fallback</span>}
            </div>
            {(sessionTitle || usage.contextTokens !== undefined || planEntries.length > 0) && (
                <div className="code-session-header">
                    {sessionTitle && <span className="code-session-title">{sessionTitle}</span>}
                    {usage.contextTokens !== undefined && usage.contextLimit ? (
                        <span className="code-context-meter" title={`${usage.contextTokens.toLocaleString()} / ${usage.contextLimit.toLocaleString()} tokens${usage.cost !== undefined ? ` · $${usage.cost.toFixed(4)}` : ''}`}>
                            <span className="code-context-bar" style={{ width: `${Math.min(100, (usage.contextTokens / usage.contextLimit) * 100)}%` }} />
                        </span>
                    ) : null}
                    {planEntries.length > 0 && (
                        <div className="code-plan-entries">
                            {planEntries.map((entry, index) => (
                                <span key={index} className={`code-plan-entry code-plan-${entry.status}`}>
                                    {entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '↻' : '○'} {entry.title}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
