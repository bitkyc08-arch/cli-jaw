import type {
    BackgroundTaskRow,
    BackgroundTaskStatus,
    BackgroundTaskUpdate,
} from '../../public/manager/src/background-tasks/background-task-client.ts';
import type {
    WorkerProgressAttentionKind,
    WorkerProgressRun,
    WorkerProgressSnapshot,
} from '../../public/manager/src/workers/worker-progress-client.ts';

export const MONITOR_FIXTURE_ISO = '2026-06-19T00:00:00.000Z';
export const MONITOR_FIXTURE_TIME = Date.parse(MONITOR_FIXTURE_ISO);

export function backgroundTaskFixture(
    input: Partial<BackgroundTaskRow> & Pick<BackgroundTaskRow, 'id' | 'status'>,
): BackgroundTaskRow {
    return {
        id: input.id,
        kind: input.kind ?? 'shell',
        spec: input.spec ?? {
            command: ['node', '-e', 'console.log("done")'],
            completion: { type: 'exit' },
            promptTemplate: 'done {{result}}',
        },
        status: input.status,
        pid: input.pid ?? null,
        originMeta: input.originMeta ?? {},
        result: input.result ?? null,
        createdAt: input.createdAt ?? MONITOR_FIXTURE_ISO,
        startedAt: input.startedAt ?? null,
        deadlineAt: input.deadlineAt ?? null,
        completedAt: input.completedAt ?? null,
        notifiedAt: input.notifiedAt ?? null,
        runnerActive: input.runnerActive ?? false,
    };
}

export function backgroundMonitorRowsFixture(): BackgroundTaskRow[] {
    const statusRows: BackgroundTaskStatus[] = ['running', 'complete', 'failed', 'cancelled', 'orphaned'];
    return [
        ...statusRows.map((status, index) => backgroundTaskFixture({
            id: `bg_${status}`,
            status,
            createdAt: new Date(MONITOR_FIXTURE_TIME + index * 1000).toISOString(),
            startedAt: status === 'running' || status === 'orphaned'
                ? new Date(MONITOR_FIXTURE_TIME + index * 1000 + 250).toISOString()
                : null,
            completedAt: status === 'complete' || status === 'failed' || status === 'cancelled'
                ? new Date(MONITOR_FIXTURE_TIME + index * 1000 + 500).toISOString()
                : null,
            result: status === 'complete' ? 'completed result' : status === 'failed' ? 'failed result' : null,
            runnerActive: status === 'running',
        })),
        backgroundTaskFixture({
            id: 'bg_web_ai_running',
            kind: 'web-ai',
            status: 'running',
            spec: {
                completion: { type: 'session-status', sessionId: 'web_ai_session_fixture' },
                promptTemplate: 'deliver {{result}}',
            },
            createdAt: new Date(MONITOR_FIXTURE_TIME + 6000).toISOString(),
            startedAt: new Date(MONITOR_FIXTURE_TIME + 6250).toISOString(),
            runnerActive: true,
        }),
    ];
}

export function backgroundTaskUpdateFixture(
    input: Partial<BackgroundTaskUpdate> = {},
): BackgroundTaskUpdate {
    return {
        topic: 'bgtask',
        event: 'bgtask_update',
        running: input.running ?? [{ id: 'bg_running', kind: 'shell', startedAt: MONITOR_FIXTURE_ISO }],
        changed: input.changed ?? { id: 'bg_complete', kind: 'shell', status: 'complete' },
        ...(input.sseReplay === true ? { sseReplay: true } : {}),
    };
}

export function workerRunFixture(input: Partial<WorkerProgressRun> & Pick<WorkerProgressRun, 'agentId'>): WorkerProgressRun {
    return {
        agentId: input.agentId,
        employeeName: input.employeeName ?? input.agentId,
        state: input.state ?? 'running',
        taskPreview: input.taskPreview ?? 'verify monitor flow',
        phase: input.phase ?? '047',
        phaseLabel: input.phaseLabel ?? 'Monitor QA fixtures',
        startedAt: input.startedAt ?? MONITOR_FIXTURE_TIME,
        completedAt: input.completedAt ?? null,
        progressUpdatedAt: input.progressUpdatedAt ?? MONITOR_FIXTURE_TIME + 1000,
        ...(input.resultPreview !== undefined ? { resultPreview: input.resultPreview } : {}),
        ...(input.attention ? { attention: input.attention } : {}),
        tools: input.tools ?? [],
    };
}

export function workerProgressSnapshotFixture(
    input: Partial<WorkerProgressSnapshot> & Pick<WorkerProgressSnapshot, 'agentId'>,
): WorkerProgressSnapshot {
    return {
        agentId: input.agentId,
        employeeName: input.employeeName ?? input.agentId,
        current: input.current ?? null,
        previous: input.previous ?? null,
        generatedAt: input.generatedAt ?? MONITOR_FIXTURE_TIME,
    };
}

export function workerAttentionSnapshotFixture(kind: WorkerProgressAttentionKind): WorkerProgressSnapshot {
    const currentAttention = kind === 'pending_replay' || kind === 'replay_claimed' || kind === 'replay_failed'
        ? null
        : {
            kind,
            message: `${kind.replaceAll('_', ' ')} fixture`,
            occurredAt: MONITOR_FIXTURE_TIME + 2000,
            ...(kind === 'disconnected' ? { exitCode: 1 } : {}),
        };
    const previousAttention = currentAttention ? null : {
        kind,
        message: `${kind.replaceAll('_', ' ')} fixture`,
        occurredAt: MONITOR_FIXTURE_TIME + 2000,
        attempts: kind === 'replay_failed' ? 3 : 0,
    };

    return workerProgressSnapshotFixture({
        agentId: `worker_${kind}`,
        employeeName: `Worker ${kind}`,
        current: currentAttention
            ? workerRunFixture({
                agentId: `worker_${kind}`,
                employeeName: `Worker ${kind}`,
                attention: currentAttention,
                progressUpdatedAt: MONITOR_FIXTURE_TIME + 2000,
            })
            : null,
        previous: previousAttention
            ? workerRunFixture({
                agentId: `worker_${kind}`,
                employeeName: `Worker ${kind}`,
                state: kind === 'replay_failed' ? 'failed' : 'done',
                completedAt: MONITOR_FIXTURE_TIME + 1500,
                progressUpdatedAt: MONITOR_FIXTURE_TIME + 1500,
                resultPreview: kind === 'replay_failed' ? 'replay failed' : 'pending replay',
                attention: previousAttention,
            })
            : null,
    });
}

export function workerMonitorRowsFixture(): WorkerProgressSnapshot[] {
    return [
        workerProgressSnapshotFixture({
            agentId: 'worker_running',
            employeeName: 'Worker Running',
            current: workerRunFixture({
                agentId: 'worker_running',
                employeeName: 'Worker Running',
                startedAt: MONITOR_FIXTURE_TIME + 10_000,
                progressUpdatedAt: MONITOR_FIXTURE_TIME + 20_000,
            }),
        }),
        workerProgressSnapshotFixture({
            agentId: 'worker_previous',
            employeeName: 'Worker Previous',
            previous: workerRunFixture({
                agentId: 'worker_previous',
                employeeName: 'Worker Previous',
                state: 'done',
                startedAt: MONITOR_FIXTURE_TIME + 1000,
                completedAt: MONITOR_FIXTURE_TIME + 5000,
                progressUpdatedAt: MONITOR_FIXTURE_TIME + 4000,
                resultPreview: 'done',
            }),
        }),
        workerAttentionSnapshotFixture('stalled'),
        workerAttentionSnapshotFixture('disconnected'),
        workerAttentionSnapshotFixture('timeout'),
        workerAttentionSnapshotFixture('pending_replay'),
        workerAttentionSnapshotFixture('replay_failed'),
    ];
}

export function workerProgressEventFrameFixture(kind: WorkerProgressAttentionKind): Record<string, unknown> {
    return {
        topic: 'worker',
        event: `worker_${kind}`,
        agentId: `worker_${kind}`,
        employeeName: `Worker ${kind}`,
        occurredAt: MONITOR_FIXTURE_TIME + 2000,
    };
}
