import { useMemo, useState } from 'react';
import type { WorkerProgressRun, WorkerProgressSnapshot } from './worker-progress-client';
import { countWorkerProgress, useWorkerProgress } from './useWorkerProgress';

function runOf(snapshot: WorkerProgressSnapshot): WorkerProgressRun | null {
    return snapshot.current ?? snapshot.previous;
}

function formatTime(value: number | null | undefined): string {
    if (!value) return 'unknown';
    return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(new Date(value));
}

function statusLabel(snapshot: WorkerProgressSnapshot): string {
    const run = runOf(snapshot);
    if (!run) return 'Unknown';
    return snapshot.current ? 'Running' : run.state === 'done' ? 'Done' : run.state;
}

function subtitle(snapshot: WorkerProgressSnapshot): string {
    const run = runOf(snapshot);
    if (!run) return 'No progress snapshot';
    const time = snapshot.current ? run.progressUpdatedAt ?? run.startedAt : run.completedAt ?? run.progressUpdatedAt ?? run.startedAt;
    return [
        run.phaseLabel || run.phase || '',
        snapshot.current ? `active ${formatTime(time)}` : `updated ${formatTime(time)}`,
        `${run.tools.length} steps`,
    ].filter(Boolean).join(' · ');
}

function resultPreview(run: WorkerProgressRun): string {
    const text = run.resultPreview?.trim();
    if (!text) return '';
    return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function attentionClass(kind?: string): string {
    if (kind === 'stalled' || kind === 'pending_replay' || kind === 'replay_claimed') return 'is-warning';
    if (kind === 'disconnected' || kind === 'timeout' || kind === 'replay_failed') return 'is-error';
    return '';
}

type WorkerProgressItemProps = {
    snapshot: WorkerProgressSnapshot;
    expanded: boolean;
    onToggle: (agentId: string) => void;
};

function WorkerProgressItem({ snapshot, expanded, onToggle }: WorkerProgressItemProps) {
    const run = runOf(snapshot);
    if (!run) return null;
    const preview = resultPreview(run);
    const attention = run.attention;
    const visibleTools = run.tools.slice(-5);
    return (
        <li className={`code-worker-item ${snapshot.current ? 'is-current' : 'is-previous'}`}>
            <button type="button" className="code-worker-main" onClick={() => onToggle(snapshot.agentId)} aria-expanded={expanded}>
                <span className={`code-worker-status ${snapshot.current ? 'is-running' : `is-${run.state}`}`}>{statusLabel(snapshot)}</span>
                <span className="code-worker-title">{snapshot.employeeName || snapshot.agentId}</span>
                <span className="code-worker-meta">{subtitle(snapshot)}</span>
            </button>
            <button type="button" className="code-worker-open" onClick={() => onToggle(snapshot.agentId)}>
                {expanded ? 'Close' : 'Open'}
            </button>
            {expanded && (
                <div className="code-worker-detail">
                    <div className="code-worker-detail-row">
                        <span>Task</span>
                        <code>{run.taskPreview || 'No task preview'}</code>
                    </div>
                    <div className="code-worker-detail-row">
                        <span>Phase</span>
                        <code>{run.phaseLabel || run.phase || 'unknown'}</code>
                    </div>
                    {attention && (
                        <div className={`code-worker-attention ${attentionClass(attention.kind)}`}>
                            <strong>{attention.kind.replaceAll('_', ' ')}</strong>
                            <span>{attention.message}</span>
                            <small>
                                {formatTime(attention.occurredAt)}
                                {attention.exitCode !== undefined ? ` · exit ${attention.exitCode}` : ''}
                                {attention.attempts !== undefined ? ` · attempts ${attention.attempts}` : ''}
                            </small>
                        </div>
                    )}
                    {visibleTools.length > 0 && (
                        <div className="code-worker-steps">
                            <span>Recent steps</span>
                            <ol>
                                {visibleTools.map((tool, index) => (
                                    <li key={tool.stepRef || `${tool.label}-${index}`}>
                                        <b>{tool.status || 'step'}</b>
                                        <span>{tool.label || tool.toolType || 'tool'}</span>
                                        {tool.detail && <code>{tool.detail}</code>}
                                    </li>
                                ))}
                            </ol>
                        </div>
                    )}
                    {preview && (
                        <div className="code-worker-result">
                            <span>Result</span>
                            <pre>{preview}</pre>
                        </div>
                    )}
                </div>
            )}
        </li>
    );
}

export function WorkerProgressMonitorPanel() {
    const { workers, loading, error, lastReason, refresh } = useWorkerProgress();
    const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
    const counts = useMemo(() => countWorkerProgress(workers), [workers]);
    const visibleWorkers = workers.slice(0, 8);

    return (
        <section className="code-worker-panel" aria-label="Worker progress monitor">
            <div className="code-worker-header">
                <div>
                    <span className="code-worker-kicker">Monitor</span>
                    <strong>Workers</strong>
                </div>
                <div className="code-worker-summary" aria-live="polite">
                    <span className={counts.running > 0 ? 'is-active' : ''}>{counts.running} running</span>
                    <span>{counts.previous} previous</span>
                    <span className={counts.attention > 0 ? 'is-attention' : ''}>{counts.attention} attention</span>
                </div>
                <button type="button" className="code-worker-refresh" onClick={() => void refresh()} disabled={loading}>
                    Refresh
                </button>
            </div>
            {error && <div className="code-worker-error" role="status">{error}</div>}
            {loading ? (
                <div className="code-worker-empty">Loading worker progress...</div>
            ) : visibleWorkers.length === 0 ? (
                <div className="code-worker-empty">No worker progress.</div>
            ) : (
                <ul className="code-worker-list">
                    {visibleWorkers.map(snapshot => (
                        <WorkerProgressItem
                            key={snapshot.agentId}
                            snapshot={snapshot}
                            expanded={expandedAgentId === snapshot.agentId}
                            onToggle={(agentId) => setExpandedAgentId(prev => prev === agentId ? null : agentId)}
                        />
                    ))}
                </ul>
            )}
            <div className="code-worker-footer">
                <span>{workers.length} tracked</span>
                <span>{lastReason}</span>
            </div>
        </section>
    );
}
