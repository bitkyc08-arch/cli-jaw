// ── Shared State Module ──
// All modules import this to access/modify shared state.
// Object reference ensures mutations are seen across modules.

export interface HeartbeatJob {
    id: string;
    [key: string]: unknown;
}

export interface CliStatusCache {
    [cli: string]: unknown;
}

export type OrcStateName = 'IDLE' | 'P' | 'A' | 'B' | 'C' | 'D';

export interface AppState {
    ws: WebSocket | null;
    agentBusy: boolean;
    orcState: OrcStateName;
    employees: unknown[];
    allSkills: unknown[];
    currentSkillFilter: string;
    currentAgentDiv: HTMLElement | null;
    attachedFiles: File[];
    heartbeatJobs: HeartbeatJob[];
    cliStatusCache: CliStatusCache | null;
    cliStatusTs: number;
}

export const state: AppState = {
    ws: null,
    agentBusy: false,
    employees: [],
    allSkills: [],
    currentSkillFilter: 'all',
    currentAgentDiv: null,
    attachedFiles: [],
    heartbeatJobs: [],
    cliStatusCache: null,
    cliStatusTs: 0,
    orcState: 'IDLE',
};
