export type GoalEvidenceFreshness = 'fresh' | 'stale' | 'missing';
export type PabcdGateStatus = 'idle' | 'pending' | 'pass' | 'fail';
export type GoalStatusKind = 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled';
export type PabcdStateName = 'IDLE' | 'I' | 'P' | 'A' | 'B' | 'C' | 'D';

export interface GoalCheckpointSummary {
    summary: string;
    nextAction: string;
    evidencePaths: string[];
    timestamp: string;
}

export interface GoalStatusSummary {
    id: string;
    status: GoalStatusKind;
    goalMode: 'direct' | 'plan' | null;
    objectivePreview: string;
    repoRoot: string | null;
    createdAt: string;
    updatedAt: string;
    checkpointCount: number;
    lastCheckpoint: GoalCheckpointSummary | null;
    evidenceFreshness: GoalEvidenceFreshness;
    evidenceAgeMs: number | null;
}

export interface PabcdGateSummary {
    label: string;
    status: PabcdGateStatus;
    evidence: string[];
}

export interface PabcdStatusSummary {
    scope: string;
    state: PabcdStateName;
    active: boolean;
    worklogPath: string | null;
    planUpdatedAt: string | null;
    auditStatus: 'pending' | 'pass' | 'fail' | null;
    verificationStatus: 'pending' | 'done' | 'needs_fix' | null;
    userApproved: boolean | null;
    projectDirs: string[];
    gate: PabcdGateSummary;
}

export interface RuntimeStatusSummary {
    activeWorkers: number;
    pendingWorkerReplays: boolean;
    heartbeatPending: number;
    heartbeatDeferredPending: number;
}

export interface GoalPabcdStatusSnapshot {
    ok: boolean;
    generatedAt: number;
    goal: GoalStatusSummary | null;
    pabcd: PabcdStatusSummary;
    runtime: RuntimeStatusSummary;
}

export interface GoalPabcdStatusClient {
    readStatus(): Promise<GoalPabcdStatusSnapshot>;
}

type FetchImpl = typeof fetch;

function statusUrl(baseUrl: string): string {
    return `${baseUrl}/api/manager/runtime-status`;
}

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
    const text = await response.text();
    let body: unknown = {};
    if (text.trim()) {
        try {
            body = JSON.parse(text) as unknown;
        } catch {
            throw new Error(`${fallback}: response was not JSON`);
        }
    }
    if (!response.ok) {
        const message = typeof body === 'object' && body && 'error' in body
            ? String((body as { error?: unknown }).error)
            : fallback;
        throw new Error(message || fallback);
    }
    return body as T;
}

export function createGoalPabcdStatusClient(options: { baseUrl?: string; fetchImpl?: FetchImpl } = {}): GoalPabcdStatusClient {
    const baseUrl = options.baseUrl ?? '';
    const fetchImpl = options.fetchImpl ?? fetch;
    return {
        async readStatus() {
            return parseResponse<GoalPabcdStatusSnapshot>(
                await fetchImpl(statusUrl(baseUrl)),
                'goal PABCD status read failed',
            );
        },
    };
}
