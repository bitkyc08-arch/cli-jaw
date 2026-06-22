import { useMemo, useState } from 'react';
import type { WorkerRunEvent, WorkerRunRecord, WorkerRunsClient } from './worker-runs-client';
import { useWorkerRuns } from './useWorkerRuns';

type WorkerRunsPanelProps = {
    client?: WorkerRunsClient;
};

function formatTime(value: number | null | undefined): string {
    if (!value) return 'unknown';
    return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(new Date(value));
}

function byteLabel(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function taskPreview(value: string): string {
    const text = value.trim();
    if (!text) return 'No task preview';
    return text.length > 96 ? `${text.slice(0, 96)}...` : text;
}

function runDetail(run: WorkerRunRecord): string {
    return [
        run.runId,
        `updated ${formatTime(run.updatedAt)}`,
        run.hasOutput ? byteLabel(run.outputBytes) : 'no output',
    ].join(' · ');
}

function eventDetail(event: WorkerRunEvent): string {
    const data = event.data || {};
    if (typeof data['safeSummary'] === 'string') return data['safeSummary'];
    if (typeof data['toolCount'] === 'number') return `${data['toolCount']} tool updates`;
    if (data['attention'] && typeof data['attention'] === 'object') return 'attention metadata';
    return `seq ${event.seq}`;
}

function countRuns(runs: WorkerRunRecord[]): { running: number; done: number; failed: number; attention: number } {
    return runs.reduce((counts, run) => {
        if (run.status === 'running') counts.running += 1;
        if (run.status === 'done') counts.done += 1;
        if (run.status === 'failed' || run.status === 'cancelled') counts.failed += 1;
        if (run.hasOutput || run.outputBytes > 0) counts.attention += 1;
        return counts;
    }, { running: 0, done: 0, failed: 0, attention: 0 });
}

export function WorkerRunsPanel(props: WorkerRunsPanelProps) {
    const { runs, loading, error, lastReason, eventsByRunId, outputByRunId, refresh, loadEvents, loadOutput } = useWorkerRuns(props.client);
    const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
    const visibleRuns = runs.slice(0, 8);
    const counts = useMemo(() => countRuns(runs), [runs]);

    const toggleRun = (run: WorkerRunRecord) => {
        setExpandedRunId(prev => prev === run.runId ? null : run.runId);
        if (expandedRunId !== run.runId) void loadEvents(run.runId);
    };

    return (
        <section className="code-worker-runs" aria-label="Worker runs">
            <div className="code-worker-runs-header">
                <div>
                    <span className="code-worker-kicker">Runs</span>
                    <strong>Recent worker runs</strong>
                </div>
                <div className="code-worker-runs-summary" aria-live="polite">
                    <span className={counts.running > 0 ? 'is-active' : ''}>{counts.running} running</span>
                    <span>{counts.done} done</span>
                    <span className={counts.failed > 0 ? 'is-attention' : ''}>{counts.failed} failed</span>
                    <span>{counts.attention} output</span>
                </div>
                <button type="button" className="code-worker-refresh" onClick={() => void refresh()} disabled={loading}>
                    Refresh
                </button>
            </div>
            {error && <div className="code-worker-error" role="status">{error}</div>}
            {loading ? (
                <div className="code-worker-empty">Loading worker runs...</div>
            ) : visibleRuns.length === 0 ? (
                <div className="code-worker-empty">No worker runs.</div>
            ) : (
                <ul className="code-worker-run-list">
                    {visibleRuns.map(run => {
                        const expanded = expandedRunId === run.runId;
                        const eventsState = eventsByRunId[run.runId];
                        const outputState = outputByRunId[run.runId];
                        const output = outputState?.output ?? null;
                        return (
                            <li key={run.runId} className={`code-worker-run-item is-${run.status}`}>
                                <button type="button" className="code-worker-run-main" onClick={() => toggleRun(run)} aria-expanded={expanded}>
                                    <span className={`code-worker-status is-${run.status}`}>{run.status}</span>
                                    <span className="code-worker-title">{run.employeeName || run.agentId}</span>
                                    <span className="code-worker-meta">{runDetail(run)}</span>
                                    <span className="code-worker-run-task">{taskPreview(run.taskPreview)}</span>
                                </button>
                                {expanded && (
                                    <div className="code-worker-run-detail">
                                        {eventsState?.error && <div className="code-worker-error" role="status">{eventsState.error}</div>}
                                        {eventsState?.loading ? (
                                            <div className="code-worker-empty">Loading safe events...</div>
                                        ) : (
                                            <ol className="code-worker-run-events">
                                                {(eventsState?.events ?? []).slice(-12).map(event => (
                                                    <li key={`${event.runId}:${event.seq}`}>
                                                        <b>{event.event.replace('worker_run_', '')}</b>
                                                        <span>{formatTime(event.ts)}</span>
                                                        <code>{eventDetail(event)}</code>
                                                    </li>
                                                ))}
                                            </ol>
                                        )}
                                        {run.hasOutput && !output && (
                                            <button type="button" className="code-worker-output-action" onClick={() => void loadOutput(run.runId, { offset: 0 })} disabled={outputState?.loading}>
                                                {outputState?.loading ? 'Loading output...' : 'Load output'}
                                            </button>
                                        )}
                                        {outputState?.error && <div className="code-worker-error" role="status">{outputState.error}</div>}
                                        {output && (
                                            <div className="code-worker-output">
                                                <div>
                                                    <span>{byteLabel(output.offset)}-{byteLabel(output.nextOffset)} of {byteLabel(output.outputBytes)}</span>
                                                    {!output.eof && (
                                                        <button type="button" className="code-worker-output-action" onClick={() => void loadOutput(run.runId, { offset: output.nextOffset })} disabled={outputState?.loading}>
                                                            Load next chunk
                                                        </button>
                                                    )}
                                                </div>
                                                <pre>{output.text || 'No output text.'}</pre>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            <div className="code-worker-footer">
                <span>{runs.length} runs</span>
                <span>{lastReason}</span>
            </div>
        </section>
    );
}
