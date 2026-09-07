import { useState } from 'react';
import type { CodeControllerModel } from './code-controller-types';
import { CODE_RUNTIME_LABELS, CODE_SESSION_LABELS } from './code-types';

export function CodeWorkspaceHeader({ controller: c }: { controller: CodeControllerModel }) {
    const [picking, setPicking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const cwd = c.session?.cwd ?? c.selection.cwd;
    const frozen = c.selectedId !== null || c.pending || c.creationUnknown || c.operation.kind !== 'idle';
    async function pick() {
        if (frozen || picking) return;
        setPicking(true); setError(null);
        try { await c.pickWorkspace(); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setPicking(false); }
    }
    return <header className="code-workspace-header">
        <div className="code-session-header">
            <span className="code-session-title">{c.session?.title || (c.selectedId ? 'Untitled session' : 'New session draft')}</span>
            <span>{CODE_RUNTIME_LABELS[c.session?.provider ?? c.selection.provider]}</span>
            <span role="status">{c.session ? CODE_SESSION_LABELS[c.session.status] : c.creationUnknown ? 'Creation unconfirmed' : c.operation.kind === 'creating' ? 'Creating session' : 'Draft'}{c.session?.archivedAt !== null && c.session ? ' · Archived' : ''}</span>
        </div>
        <div className="code-workspace-primary">
            {frozen ? <span className="code-workspace-chip" title={cwd}>{cwd || 'Workspace not set'}</span>
                : <button type="button" className="code-workspace-picker" aria-label="Choose Code workspace" disabled={picking}
                    title={cwd || 'Choose a folder'} onClick={() => void pick()}>
                    <span className="code-workspace-picker-label">{picking ? 'Choosing folder…' : cwd || 'Choose workspace'}</span>
                </button>}
            {c.gitInfo?.isRepo && <>
                <span className="code-workspace-pill">{c.gitInfo.branch ?? 'detached'}{c.gitInfo.head ? ` · ${c.gitInfo.head}` : ''}</span>
                {c.gitInfo.status && <span className={`code-workspace-pill${c.gitInfo.status.dirty ? ' is-dirty' : ''}`}>
                    {c.gitInfo.status.dirty ? `${c.gitInfo.status.changed} changed · ${c.gitInfo.status.untracked} untracked` : 'clean'}
                </span>}
            </>}
            {error && <span className="code-action-error" role="alert">{error}</span>}
        </div>
    </header>;
}
