// ── Shared State Module ──
// All modules import this to access/modify shared state.
// Object reference ensures mutations are seen across modules.

export const state = {
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
};
