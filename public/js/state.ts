// ── Shared State Module ──
// All modules import this to access/modify shared state.
// Object reference ensures mutations are seen across modules.

import type { ProcessBlockState } from './features/process-block.js';
import type { ActivityIdentity } from '../../src/shared/presentation.js';

export type HeartbeatSchedule =
    | {
        kind: 'every';
        minutes: number;
        timeZone?: string;
    }
    | {
        kind: 'cron';
        cron: string;
        timeZone?: string;
    };

export interface HeartbeatJob {
    id: string;
    name?: string;
    enabled?: boolean;
    schedule?: HeartbeatSchedule;
    prompt?: string;
}

export interface CliStatusCache {
    [cli: string]: unknown;
}

export type OrcStateName = 'IDLE' | 'I' | 'P' | 'A' | 'B' | 'C' | 'D';

export interface HeartbeatRuntimeState {
    pending: number;
    deferredPending: number;
    reason?: 'busy' | 'pabcd_active';
    policy?: 'defer';
    jobId?: string;
    jobName?: string;
}

export interface ResolvedSelectionState {
    raw: string;
    index: number;
    text: string;
    source: string;
}

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled';

export interface ActiveGoalState {
    id: string;
    objective: string;
    status: GoalStatus;
    createdAt: string;
    updatedAt: string;
    lastCheckpointSummary?: string | undefined;
    nextAction?: string | undefined;
}

export interface AppState {
    activityIdentity: ActivityIdentity | null;
    agentBusy: boolean;
    orcState: OrcStateName;
    employees: unknown[];
    allSkills: unknown[];
    currentSkillFilter: string;
    currentSkillSearch: string;
    currentAgentDiv: HTMLElement | null;
    attachedFiles: File[];
    heartbeatJobs: HeartbeatJob[];
    heartbeatErrors: Record<string, string>;
    cliStatusCache: CliStatusCache | null;
    cliStatusTs: number;
    isRecording: boolean;
    currentProcessBlock: ProcessBlockState | null;
    heartbeatRuntime: HeartbeatRuntimeState;
    orcTaskAnchor: string;
    orcResolvedSelection: ResolvedSelectionState | null;
    activeGoal: ActiveGoalState | null;
    lastWorkflowSequenceId: number;
    workflowEventCount: number;
}

export const state: AppState = {
    activityIdentity: null,
    agentBusy: false,
    employees: [],
    allSkills: [],
    currentSkillFilter: 'all',
    currentSkillSearch: '',
    currentAgentDiv: null,
    attachedFiles: [],
    heartbeatJobs: [],
    heartbeatErrors: {},
    cliStatusCache: null,
    cliStatusTs: 0,
    orcState: 'IDLE',
    isRecording: false,
    currentProcessBlock: null,
    heartbeatRuntime: { pending: 0, deferredPending: 0 },
    orcTaskAnchor: '',
    orcResolvedSelection: null,
    activeGoal: null,
    lastWorkflowSequenceId: -1,
    workflowEventCount: 0,
};
