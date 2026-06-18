import type { FolderGitOperationHistoryItem } from './folder-git-operation-history';
import type { GitWorktreeOperation } from './folder-worktree-types';

type FolderWorktreeOperationHistoryProps = {
    history: FolderGitOperationHistoryItem[];
    busy: boolean;
    onRetry: (operation: GitWorktreeOperation) => void;
};

function commandText(command: string[]): string {
    return command.length > 0 ? command.join(' ') : 'Command unavailable';
}

function statusText(item: FolderGitOperationHistoryItem): string {
    if (item.status === 'running') return 'Running';
    if (item.status === 'succeeded') return 'Done';
    if (item.status === 'blocked') return 'Blocked';
    if (item.status === 'cancelled') return 'Cancelled';
    return 'Failed';
}

export function FolderWorktreeOperationHistory(props: FolderWorktreeOperationHistoryProps) {
    if (props.history.length === 0) return null;
    return (
        <div className="folder-worktree-history" aria-label="Git worktree operation history">
            <div className="folder-worktree-history__title">Recent operations</div>
            {props.history.map(item => (
                <div key={item.id} className={`folder-worktree-history__item is-${item.status}`}>
                    <div className="folder-worktree-history__main">
                        <span className="folder-worktree-history__label">{item.operationLabel}</span>
                        <span className="folder-worktree-history__status">{statusText(item)}</span>
                    </div>
                    <div className="folder-worktree-history__command" title={commandText(item.commandPreview)}>
                        {commandText(item.commandPreview)}
                    </div>
                    {item.stdout && <pre className="folder-worktree-history__output">{item.stdout}</pre>}
                    {item.stderr && <pre className="folder-worktree-history__output is-error">{item.stderr}</pre>}
                    {item.error && <div className="folder-worktree-history__error">{item.error}</div>}
                    <button
                        type="button"
                        className="folder-worktree-history__retry"
                        disabled={props.busy || item.status === 'running'}
                        onClick={() => props.onRetry(item.operation)}
                    >
                        Retry with confirmation
                    </button>
                </div>
            ))}
        </div>
    );
}
