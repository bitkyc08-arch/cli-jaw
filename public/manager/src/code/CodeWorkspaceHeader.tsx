import { useState } from 'react';
import type { CodeGitInfo, CodeModelOptions } from './code-session-client';

type CodeWorkspaceHeaderProps = {
    workingDir: string;
    gitInfo: CodeGitInfo | null;
    modelOptions: CodeModelOptions | null;
    sessionTitle: string;
    usage: { contextTokens?: number; contextLimit?: number; cost?: number };
    planEntries: Array<{ title: string; status: string }>;
    onWorkingDirChange?: ((path: string | null) => void) | undefined;
    cwdLocked?: boolean | undefined;
    workspaceFrozen?: boolean | undefined;
    onPickWorkingDir?: (() => Promise<string | null>) | undefined;
};

function shortPath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts.slice(-2).join('/') || path;
}

export function CodeWorkspaceHeader({ workingDir, gitInfo, modelOptions, sessionTitle, usage, planEntries, onWorkingDirChange, cwdLocked = false, workspaceFrozen = false, onPickWorkingDir }: CodeWorkspaceHeaderProps) {
    const [picking, setPicking] = useState(false);
    const [pickError, setPickError] = useState('');
    const dirty = gitInfo?.status?.dirty;
    const worktreeCount = gitInfo?.worktrees.length ?? 0;
    // Slice 210: the workspace is editable only before first Send (workspaceFrozen)
    // and before an active session exists (cwdLocked covers a loaded stored session).
    const frozen = workspaceFrozen || cwdLocked;
    const canPick = Boolean(!frozen && onPickWorkingDir && onWorkingDirChange);

    async function pickWorkingDir(): Promise<void> {
        if (!canPick || !onPickWorkingDir) return;
        setPicking(true);
        setPickError('');
        try {
            const next = await onPickWorkingDir();
            if (next) onWorkingDirChange?.(next);
        } catch (err) {
            setPickError(err instanceof Error ? err.message : String(err));
        } finally {
            setPicking(false);
        }
    }

    return (
        <div className="code-workspace-header">
            <div className="code-workspace-primary">
                {frozen ? (
                    <span className="code-workspace-chip" title={workingDir} aria-label={`Current Code workspace: ${workingDir}`}>
                        {shortPath(workingDir || '/tmp')}
                    </span>
                ) : (
                    <button
                        type="button"
                        className="code-workspace-picker"
                        disabled={!canPick || picking}
                        title={workingDir || 'Select Code workspace folder'}
                        aria-label={`Code workspace: ${workingDir || 'not set'}. Choose a folder.`}
                        onClick={() => void pickWorkingDir()}
                    >
                        <span className="code-workspace-picker-label">{shortPath(workingDir || '/tmp')}</span>
                        <span className="code-workspace-picker-caret" aria-hidden="true">▾</span>
                    </button>
                )}
                {!frozen && pickError && <span className="code-workspace-cwd-error">{pickError}</span>}
                {gitInfo?.isRepo && (
                    <>
                        <span className="code-workspace-pill">{gitInfo.branch ?? 'detached'}{gitInfo.head ? ` · ${gitInfo.head}` : ''}</span>
                        <span className={`code-workspace-pill ${dirty ? 'is-dirty' : ''}`}>
                            {dirty ? `${gitInfo.status?.changed ?? 0} changed · ${gitInfo.status?.untracked ?? 0} untracked` : 'clean'}
                        </span>
                        <span className="code-workspace-pill" title={gitInfo.currentWorktree?.path ?? undefined}>
                            worktree {worktreeCount}
                        </span>
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
