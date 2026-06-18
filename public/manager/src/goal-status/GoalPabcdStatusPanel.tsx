import { useMemo, useState } from 'react';
import type { GoalPabcdStatusSnapshot, PabcdGateStatus } from './goal-pabcd-status-client';
import { useGoalPabcdStatus } from './useGoalPabcdStatus';

function formatTime(value: string | number | null | undefined): string {
    if (!value) return 'unknown';
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(parsed)) return String(value);
    return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(new Date(parsed));
}

function statusClass(status: PabcdGateStatus | string | null | undefined): string {
    if (status === 'pass' || status === 'fresh' || status === 'active') return 'is-pass';
    if (status === 'fail' || status === 'stale' || status === 'blocked') return 'is-fail';
    if (status === 'idle' || status === 'missing') return 'is-muted';
    return 'is-pending';
}

function goalLine(snapshot: GoalPabcdStatusSnapshot | null): string {
    if (!snapshot?.goal) return 'No active goal';
    const checkpoint = snapshot.goal.lastCheckpoint;
    return checkpoint?.summary || snapshot.goal.objectivePreview || snapshot.goal.id;
}

function gateLine(snapshot: GoalPabcdStatusSnapshot | null): string {
    if (!snapshot) return 'Loading runtime status';
    return `${snapshot.pabcd.state} · ${snapshot.pabcd.gate.label}`;
}

function runtimeLine(snapshot: GoalPabcdStatusSnapshot | null): string {
    if (!snapshot) return 'hydrating';
    const runtime = snapshot.runtime;
    const parts = [
        `${runtime.activeWorkers} workers`,
        runtime.pendingWorkerReplays ? 'replay pending' : '',
        runtime.heartbeatPending > 0 ? `${runtime.heartbeatPending} heartbeat pending` : '',
    ];
    return parts.filter(Boolean).join(' · ') || 'idle runtime';
}

export function GoalPabcdStatusPanel() {
    const { snapshot, loading, error, lastReason, refresh } = useGoalPabcdStatus();
    const [expanded, setExpanded] = useState(false);
    const gateEvidence = useMemo(() => snapshot?.pabcd.gate.evidence.slice(0, 5) ?? [], [snapshot]);
    const goalEvidence = snapshot?.goal?.lastCheckpoint?.evidencePaths.slice(0, 5) ?? [];
    const goalStatus = snapshot?.goal?.status ?? 'idle';
    const evidenceFreshness = snapshot?.goal?.evidenceFreshness ?? 'missing';

    return (
        <section className="code-goal-status-panel" aria-label="Goal and PABCD status">
            <div className="code-goal-status-header">
                <button type="button" className="code-goal-status-main" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
                    <span className="code-goal-status-kicker">Monitor</span>
                    <strong>Goal / PABCD</strong>
                    <span className="code-goal-status-title">{goalLine(snapshot)}</span>
                    <span className="code-goal-status-meta">{gateLine(snapshot)}</span>
                </button>
                <div className="code-goal-status-pills" aria-live="polite">
                    <span className={statusClass(goalStatus)}>{goalStatus}</span>
                    <span className={statusClass(snapshot?.pabcd.gate.status)}>{snapshot?.pabcd.gate.status ?? 'pending'}</span>
                    <span className={statusClass(evidenceFreshness)}>{evidenceFreshness}</span>
                </div>
                <button type="button" className="code-goal-status-refresh" onClick={() => void refresh()} disabled={loading}>
                    Refresh
                </button>
            </div>
            {error && <div className="code-goal-status-error" role="status">{error}</div>}
            {loading && !snapshot ? (
                <div className="code-goal-status-empty">Loading goal and PABCD status...</div>
            ) : (
                <div className="code-goal-status-strip">
                    <span>{runtimeLine(snapshot)}</span>
                    <span>updated {formatTime(snapshot?.generatedAt)}</span>
                    <span>{lastReason}</span>
                </div>
            )}
            {expanded && snapshot && (
                <div className="code-goal-status-detail">
                    <div className="code-goal-status-detail-row">
                        <span>Objective</span>
                        <code>{snapshot.goal?.objectivePreview ?? 'No active goal'}</code>
                    </div>
                    <div className="code-goal-status-detail-row">
                        <span>Next action</span>
                        <code>{snapshot.goal?.lastCheckpoint?.nextAction || 'No checkpoint next action'}</code>
                    </div>
                    <div className="code-goal-status-detail-row">
                        <span>Repository</span>
                        <code>{snapshot.goal?.repoRoot || snapshot.pabcd.projectDirs[0] || 'unknown'}</code>
                    </div>
                    <div className="code-goal-status-detail-row">
                        <span>Gate evidence</span>
                        <div className="code-goal-status-evidence-list">
                            {gateEvidence.length === 0 ? <code>No PABCD gate evidence recorded</code> : gateEvidence.map(item => <code key={item}>{item}</code>)}
                        </div>
                    </div>
                    <div className="code-goal-status-detail-row">
                        <span>Goal evidence</span>
                        <div className="code-goal-status-evidence-list">
                            {goalEvidence.length === 0 ? <code>No goal checkpoint evidence recorded</code> : goalEvidence.map(item => <code key={item}>{item}</code>)}
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}
