import type { Express } from 'express';
import { registerBgtaskRoutes } from '../../routes/bgtask.js';
import type { AuthMiddleware } from '../../routes/types.js';
import { getHeartbeatRuntimeState } from '../../memory/heartbeat.js';
import { getActiveGoal } from '../../goal/store.js';
import type { GoalCheckpoint, GoalState } from '../../goal/types.js';
import { getCtx, getState, type OrcContext, type OrcStateName } from '../../orchestrator/state-machine.js';
import {
    getActiveWorkers,
    getWorkerProgressSnapshot,
    hasPendingWorkerReplays,
    listWorkerProgressSnapshots,
} from '../../orchestrator/worker-registry.js';

type GateStatus = 'idle' | 'pending' | 'pass' | 'fail';

interface GoalCheckpointSummary {
    summary: string;
    nextAction: string;
    evidencePaths: string[];
    timestamp: string;
}

interface GoalStatusSummary {
    id: string;
    status: GoalState['status'];
    goalMode: GoalState['goalMode'] | null;
    objectivePreview: string;
    repoRoot: string | null;
    createdAt: string;
    updatedAt: string;
    checkpointCount: number;
    lastCheckpoint: GoalCheckpointSummary | null;
    evidenceFreshness: 'fresh' | 'stale' | 'missing';
    evidenceAgeMs: number | null;
}

interface PabcdGateSummary {
    label: string;
    status: GateStatus;
    evidence: string[];
}

interface PabcdStatusSummary {
    scope: string;
    state: OrcStateName;
    active: boolean;
    worklogPath: string | null;
    planUpdatedAt: string | null;
    auditStatus: OrcContext['auditStatus'] | null;
    verificationStatus: OrcContext['verificationStatus'] | null;
    userApproved: boolean | null;
    projectDirs: string[];
    gate: PabcdGateSummary;
}

const EVIDENCE_STALE_MS = 24 * 60 * 60 * 1000;

function previewText(value: string, limit = 180): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function checkpointSummary(checkpoint: GoalCheckpoint | undefined): GoalCheckpointSummary | null {
    if (!checkpoint) return null;
    return {
        summary: checkpoint.summary,
        nextAction: checkpoint.nextAction,
        evidencePaths: checkpoint.evidencePaths,
        timestamp: checkpoint.timestamp,
    };
}

function summarizeGoal(goal: GoalState | null): GoalStatusSummary | null {
    if (!goal) return null;
    const evidenceTimestamp = goal.lastCheckpoint?.timestamp ? Date.parse(goal.lastCheckpoint.timestamp) : NaN;
    const evidenceAgeMs = Number.isFinite(evidenceTimestamp) ? Math.max(0, Date.now() - evidenceTimestamp) : null;
    const hasEvidence = (goal.lastCheckpoint?.evidencePaths ?? []).some(item => item.trim().length > 0);
    const evidenceFreshness = !hasEvidence
        ? 'missing'
        : evidenceAgeMs !== null && evidenceAgeMs > EVIDENCE_STALE_MS
            ? 'stale'
            : 'fresh';

    return {
        id: goal.id,
        status: goal.status,
        goalMode: goal.goalMode ?? null,
        objectivePreview: previewText(goal.objective),
        repoRoot: goal.repoRoot ?? null,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
        checkpointCount: goal.checkpoints.length,
        lastCheckpoint: checkpointSummary(goal.lastCheckpoint),
        evidenceFreshness,
        evidenceAgeMs,
    };
}

function gateStatusFrom(value: string | undefined | null): GateStatus {
    if (value === 'pass' || value === 'done') return 'pass';
    if (value === 'fail' || value === 'needs_fix') return 'fail';
    return 'pending';
}

function compactEvidence(values: Array<string | null | undefined>): string[] {
    return values
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map(value => previewText(value, 120))
        .slice(0, 5);
}

function derivePabcdGate(state: OrcStateName, ctx: OrcContext | null): PabcdGateSummary {
    if (state === 'IDLE') {
        return { label: 'No active PABCD gate', status: 'idle', evidence: [] };
    }
    if (state === 'P') {
        return {
            label: 'Plan approval gate',
            status: ctx?.plan && ctx.userApproved ? 'pass' : 'pending',
            evidence: compactEvidence([ctx?.worklogPath, ctx?.planHash, ctx?.planUpdatedAt]),
        };
    }
    if (state === 'A') {
        return {
            label: 'Plan audit gate',
            status: gateStatusFrom(ctx?.auditStatus),
            evidence: compactEvidence([...(ctx?.workerResults ?? []), ctx?.worklogPath]),
        };
    }
    if (state === 'B') {
        return {
            label: 'Build implementation gate',
            status: ctx?.delivery?.filesChanged?.length ? 'pass' : 'pending',
            evidence: compactEvidence([...(ctx?.delivery?.filesChanged ?? []), ctx?.worklogPath]),
        };
    }
    if (state === 'C') {
        return {
            label: 'Verification gate',
            status: gateStatusFrom(ctx?.verificationStatus),
            evidence: compactEvidence([
                ...(ctx?.delivery?.acsMet ?? []),
                ...(ctx?.delivery?.acsNotMet ?? []),
                ...(ctx?.workerResults ?? []),
            ]),
        };
    }
    return {
        label: 'Delivery gate',
        status: ctx?.delivery ? 'pass' : 'pending',
        evidence: compactEvidence([...(ctx?.delivery?.filesChanged ?? []), ctx?.worklogPath]),
    };
}

function summarizePabcd(scope = 'default'): PabcdStatusSummary {
    const state = getState(scope);
    const ctx = getCtx(scope);
    return {
        scope,
        state,
        active: state !== 'IDLE',
        worklogPath: ctx?.worklogPath ?? null,
        planUpdatedAt: ctx?.planUpdatedAt ?? null,
        auditStatus: ctx?.auditStatus ?? null,
        verificationStatus: ctx?.verificationStatus ?? null,
        userApproved: typeof ctx?.userApproved === 'boolean' ? ctx.userApproved : null,
        projectDirs: Array.isArray(ctx?.projectDirs) ? ctx.projectDirs.filter((item): item is string => typeof item === 'string') : [],
        gate: derivePabcdGate(state, ctx),
    };
}

export function registerManagerRuntimeMonitorRoutes(app: Express, requireAuth: AuthMiddleware): void {
    registerBgtaskRoutes(app, requireAuth);

    app.get('/api/manager/runtime-status', requireAuth, (_req, res) => {
        const heartbeat = getHeartbeatRuntimeState();
        res.json({
            ok: true,
            generatedAt: Date.now(),
            goal: summarizeGoal(getActiveGoal()),
            pabcd: summarizePabcd(),
            runtime: {
                activeWorkers: getActiveWorkers().length,
                pendingWorkerReplays: hasPendingWorkerReplays(),
                heartbeatPending: heartbeat.pending,
                heartbeatDeferredPending: heartbeat.deferredPending,
            },
        });
    });

    app.get('/api/orchestrate/worker-progress', requireAuth, (_req, res) => {
        res.json({ ok: true, workers: listWorkerProgressSnapshots() });
    });

    app.get('/api/orchestrate/worker-progress/:agentId', requireAuth, (req, res) => {
        const agentId = String(req.params["agentId"] || '');
        if (!agentId) {
            res.status(400).json({ ok: false, error: 'missing agentId' });
            return;
        }
        const progress = getWorkerProgressSnapshot(agentId);
        if (!progress) {
            res.status(404).json({ ok: false, error: 'worker progress not found' });
            return;
        }
        res.json({ ok: true, progress });
    });
}
