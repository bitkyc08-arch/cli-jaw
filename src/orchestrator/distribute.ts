// ─── Distribute Helpers (parallel/sequential agent execution) ──
// Extracted from pipeline.ts for 500-line compliance.

import { broadcast } from '../core/bus.js';
import { getEmployeeSession, upsertEmployeeSession } from '../core/db.js';
import { getEmployeePromptV2 } from '../prompt/builder.js';
import { spawnAgent, killAgentById } from '../agent/spawn.js';
import { appendToWorklog } from '../memory/worklog.js';
import { startWorkerMonitor } from './worker-monitor.js';
import { updateWorkerPhase } from './worker-registry.js';

// ─── Phase Constants (shared with pipeline.ts) ───────

export const PHASES: Record<number, string> = { 1: 'Planning', 2: 'Plan Audit', 3: 'Development', 4: 'Debug/Check', 5: 'Integration' };

// Employee-scoped phase agenda. Do NOT include delegation language
// (dispatch, sub-agent, cross-agent coordination, "ALL risks", "thoroughly verify")
// — those concepts belong to the boss, not the single employee executing a task.
export const PHASE_INSTRUCTIONS: Record<number, string> = {
    1: `[Planning — single-employee scope] Read the files involved in the task yourself and write a planning note. No code.
     - List the files you expect to change (based on your own reading)
     - List imports you expect to add or remove
     - List edge cases you can identify from the code you read
     - Record in the worklog. Do NOT coordinate with other agents.`,
    2: `[Plan Audit — single-employee scope] Audit the plan you were given. You are the single reviewer — do NOT dispatch other auditors.
     - Read each target file referenced in the plan and check whether the diff applies cleanly (line anchors, surrounding context)
     - Check imports in the diff against the file's existing imports
     - Note any API signatures you cannot verify with the local code (mark as "unverifiable — needs boss follow-up") — do NOT web-search unless the plan explicitly names a new external library
     - Produce a final verdict: PASS (safe to implement) or FAIL (list itemized issues with file:line refs)
     - Record audit results in the worklog.`,
    3: `[Development — single-employee scope] Write the code yourself. No delegation.
     - Apply the diff from the plan to each target file
     - Verify your changes pass local lint/build (run once, report result)
     - Record change log in worklog Execution Log.`,
    4: `[Debug/Check — single-employee scope] Run the local tests yourself, fix the bugs you find.
     - Attach execution output to the worklog
     - If a test reveals a cross-agent issue, write "needs boss follow-up: <reason>" — do NOT try to coordinate it yourself.`,
    5: `[Integration — single-employee scope] Verify your own output integrates with the files the plan references.
     - Run the integration tests specified in the plan
     - Record results. Cross-agent coordination belongs to boss.`,
};

// Boss-scoped phase agenda. This is the *orchestration* view — what the boss
// must confirm before advancing phases. Kept separate so it never leaks into
// employee task prompts. Reserved for future boss prompt wiring.
export const BOSS_PHASE_AGENDA: Record<number, string> = {
    1: `[Planning] Confirm feasibility before dispatching employees. Impact scope, dependency graph, edge cases.`,
    2: `[Plan Audit — Strict] Dispatch reviewer(s) if needed. Cross-reference findings. Use Context7 / web search when external libraries are involved. Conflict scan across agents. Final PASS/FAIL verdict drives transition to Development.`,
    3: `[Development] Dispatch developer(s). Track progress and conflicts.`,
    4: `[Debug/Check] Collect test/debug output from employees. Decide whether to iterate.`,
    5: `[Integration] Verify cross-agent integration. Final docs + changelog.`,
};

// ─── Prompt Context Helpers ──────────────────────────

export function buildParallelContext(ap: Record<string, any>, peers: Record<string, any>[]): string {
    const myFiles = (ap.verification?.affected_files || []).map((f: string) => `- ${f}`).join('\n') || '(no files specified)';
    const peerList = peers
        .filter(p => p.agent !== ap.agent)
        .map(p => `- ${p.agent} (${p.role}): ${(p.verification?.affected_files || []).join(', ') || 'unspecified'}`)
        .join('\n') || '(none)';

    return `## Parallel Execution Mode ⚡
- Other agents are working **simultaneously**.
- Focus only on your area (${ap.role}) and the files listed below.
- **Never** modify files owned by other agents.
- Do not modify shared config files (package.json, tsconfig.json, etc.).

### Your Assigned Files
${myFiles}

### Concurrently Working Agents
${peerList}`;
}

export function buildSequentialContext(ap: Record<string, any>, priorResults: Record<string, any>[]): string {
    const priorSummary = priorResults.length > 0
        ? priorResults.map(r => `- ${r.agent} (${r.role}): ${r.status} — ${r.text.slice(0, 150)}`).join('\n')
        : '(You are the first agent)';

    return `## Sequential Execution Rules
- **Do not touch files already modified by previous agents**
- Focus only on your area (${ap.role})

### Previous Agent Results
${priorSummary}`;
}

// ─── Employee Lookup ─────────────────────────────────

export function findEmployee(emps: Record<string, any>[], ap: Record<string, any>) {
    // Guard: immediately return null if agent name is missing/invalid
    if (!ap.agent || typeof ap.agent !== 'string') {
        console.warn(`[jaw:match] ⚠️ invalid agent name: ${JSON.stringify(ap.agent)}`);
        return null;
    }
    // 1st: exact match (safest)
    const exact = emps.find(e => e.name === ap.agent);
    if (exact) return exact;
    // 2nd: case-insensitive exact match
    const ci = emps.find(e => e.name?.toLowerCase() === ap.agent.toLowerCase());
    if (ci) return ci;
    // 3rd: fallback substring match (with warning)
    const fuzzy = emps.find(e => typeof e.name === 'string' && (e.name.includes(ap.agent) || ap.agent.includes(e.name)));
    if (fuzzy) console.warn(`[jaw:match] ⚠️ Fuzzy match: "${ap.agent}" → "${fuzzy.name}"`);
    return fuzzy ?? null;
}

// ─── Parallel Safety Guard ───────────────────────────

export function validateParallelSafety(agentPhases: Record<string, any>[]): void {
    const parallelAgents = agentPhases.filter(ap => ap.parallel);
    if (parallelAgents.length < 2) return;

    const fileMap = new Map<string, string>();
    for (const ap of parallelAgents) {
        const files: string[] = ap.verification?.affected_files || [];
        for (const file of files) {
            const existing = fileMap.get(file);
            if (existing && existing !== ap.agent) {
                console.warn(
                    `[orchestrator:parallel-guard] File conflict: "${file}" — ` +
                    `"${existing}" and "${ap.agent}" both marked parallel. ` +
                    `Downgrading "${ap.agent}" to sequential.`
                );
                ap.parallel = false;
                break;
            }
            fileMap.set(file, ap.agent);
        }
    }
}

// ─── Per-Agent Execution ─────────────────────────────

export function buildPlanPrompt(prompt: string, worklogPath: string, emps: Record<string, any>[]): string {
    const empList = emps.map(e => `- "${e.name}" (CLI: ${e.cli}, role: ${e.role || 'general developer'})`).join('\n');

    return `## Task Request
${prompt}

## Available Employees
${empList}

**CRITICAL: Agent names in subtask JSON MUST be an exact string match from the list above.**
Using any other name will cause the agent to not be found and the task to be skipped.

## Decision Framework — 3-Tier Dispatch Strategy
First, assess the **complexity** of this request. Minimizing dispatch calls is critical.

### 🟢 Tier 0: Direct Response (0 employees)
**Signals:** <10 files affected, single domain, any task you can handle alone
**Examples:** "fix this typo", "refactor auth module", "add dark mode", "write tests for UserService", "update 5 components"
**Action:** Respond directly — no employees needed. This is the DEFAULT. Most tasks belong here.

Output with empty subtasks and your answer in direct_answer:

\`\`\`json
{
  "direct_answer": "Your direct response here",
  "subtasks": []
}
\`\`\`

### 🟡 Tier 1: Partial Delegation (1-2 employees)
**Signals:** 10+ files affected, but still single domain (frontend OR backend, not both)
**Examples:** "refactor all 15 API route handlers", "update every component to new design system", "migrate all test files to vitest"
**Rule:** YOU do the planning (analysis + file list + approach). Employee does coding (Phase 3) + testing (Phase 4) only.
- Set start_phase = 3 or higher to skip unnecessary phases
- Your plan in this response IS the Phase 1-2 output

### 🔴 Tier 2: Full Delegation (2-4 employees)
**Signals:** Complex cross-domain work (frontend + backend + data), new feature requiring architectural design, or large-scale refactoring spanning multiple unrelated modules
**Examples:** "build a settings page with API + DB migration", "implement OAuth across frontend + backend + database", "migrate entire app from REST to GraphQL"
**Rule:** Each employee gets a **non-overlapping file set**. NEVER assign the same file to 2 agents.

#### Agent Count
- Single domain → **1 agent** only
- Frontend + Backend → **2 agents**
- Large cross-cutting project → 2-3 agents (all 5 agents is extremely rare)
- CRITICAL: No two agents should modify the same file

#### start_phase Selection
- You completed planning → start_phase = 3 (coding onwards)
- Code exists, only tests needed → start_phase = 4 (debugging onwards)
- Analysis required from scratch → start_phase = 1 (full delegation)

#### end_phase Selection (optional, default: role의 마지막 phase)
- 간단한 수정/버그픽스 → end_phase: 3
- 테스트까지 → end_phase: 4
- 전체 → end_phase: 5 또는 생략
- docs role은 [1,3,5]만 존재. end_phase: 2는 3으로 보정됨.

#### checkpoint (optional, default: false)
- true: scope 완료 후 유저에게 보고하고 대기 (세션 보존)
- false: 자동으로 done 처리

#### Dev Skills Reference
Each employee auto-receives role-matched dev skills:
- frontend → dev-frontend SKILL.md (UI/component guide)
- backend → dev-backend SKILL.md (API/server guide)
- research → research-worker SKILL.md (search, codebase exploration, read-only reports)
- data → dev-data SKILL.md (data pipeline guide)
- docs → documentation SKILL.md
These include coding conventions, project structure, and testing rules.

### ⚡ Parallel Execution (Tier 1-2 only)
When 2+ subtasks modify **completely independent file sets**, mark them \`"parallel": true\`.
The orchestrator runs parallel-marked agents concurrently via Promise.all, then runs sequential agents after.

**Default is \`false\`. Only set \`true\` when you are confident there is ZERO file overlap.**

#### Decision Rules
1. Compare \`affected_files\` across ALL subtasks. ANY overlap → both must be \`false\`.
2. Shared config files (\`package.json\`, \`tsconfig.json\`, \`.env\`, \`settings.json\`) count as overlap.
3. Import/export dependencies count as overlap (if A imports from B's files, they conflict).
4. When uncertain → keep \`false\`. Correctness > speed.

#### Quick Reference

| Scenario                                    | parallel | Why                             |
|---------------------------------------------|----------|---------------------------------|
| Frontend components + Documentation         | true     | Zero file overlap               |
| Two backend modules, no shared imports      | true     | Independent code paths          |
| Backend API + Frontend that calls that API  | false    | Consumer depends on producer    |
| Any task + shared config/package.json edit  | false    | Config file conflict risk       |
| Two agents editing same directory           | false    | Likely import/export overlap    |
| Test writing for module A + Feature in B    | true     | Different file sets             |
| Docs agent + anything else                  | true     | Docs never cause code conflicts |

#### Server-Side Safety Net
Even if you mark tasks parallel, the orchestrator validates \`affected_files\` overlap.
If overlap is detected, it automatically downgrades to sequential with a warning.

## Task Instruction Quality Guide
Every task you assign MUST be specific. Vague instructions waste cycles.

❌ Bad: "Build the frontend" (too vague — what component? what design?)
✅ Good: "Create src/components/Settings.tsx. Props: { theme, onSave }. Use Tailwind CSS. Include dark mode toggle."

❌ Bad: "Add backend API" (which endpoint? what schema?)
✅ Good: "Add POST /api/settings endpoint. Body: { theme: string, locale: string }. DB: upsert into settings table."

**Rule:** Every task instruction must include: (1) specific files to create/modify, (2) expected behavior, (3) constraints or libraries to use.

## Output Format (strictly required)
1. Explain your plan in natural language.
2. **Include verification criteria** for each subtask.
3. Subtask JSON:

\`\`\`json
{
  "subtasks": [
    {
      "agent": "ExactAgentName",
      "role": "frontend|backend|research|data|docs",
      "task": "Specific instruction with files, behavior, and constraints",
      "start_phase": 3,
      "end_phase": 3,
      "checkpoint": true,
      "parallel": false,
      "verification": {
        "pass_criteria": "One-line pass condition",
        "fail_criteria": "One-line fail condition",
        "affected_files": ["src/file.js"]
      }
    }
  ]
}
\`\`\`

**parallel field**: Optional, defaults to \`false\`. Set \`true\` only for tasks with zero file overlap.
**affected_files**: REQUIRED for all subtasks. Used by server-side parallel safety validation.

worklog path: ${worklogPath}
Record your plan in this file.`;
}

export async function runSingleAgent(
    ap: Record<string, any>,
    emp: Record<string, any>,
    worklog: Record<string, any>,
    round: number,
    meta: Record<string, any>,
    priorResults: Record<string, any>[],
    parallelPeers: Record<string, any>[] = []
): Promise<Record<string, any>> {
    const instruction = PHASE_INSTRUCTIONS[ap.currentPhase];
    const phaseLabel = PHASES[ap.currentPhase];
    const sysPrompt = getEmployeePromptV2(emp, ap.role, ap.currentPhase);

    const executionContext = ap.parallel
        ? buildParallelContext(ap, parallelPeers)
        : buildSequentialContext(ap, priorResults);

    const remainingPhases = ap.phaseProfile
        .slice(ap.currentPhaseIdx)
        .map((p: number) => `${p}(${PHASES[p]})`)
        .join('→');

    const worklogPath = String(worklog?.path || '').trim();
    const worklogBlock = worklogPath
        ? `## Worklog
Read this file first: ${worklogPath}
After completing your task, record results in the Execution Log section.`
        : '';

    const taskPrompt = `## Task Instruction [${phaseLabel}]
${ap.task}

## ⛔ Isolation Requirements (hard blocks)
You are an isolated employee session. The server will reject (HTTP 403) any of the following:
- \`cli-jaw dispatch ...\`
- \`curl\` / direct POST to \`/api/orchestrate/dispatch\`
Additionally you MUST NOT:
- Use your CLI's Task / Agent / Subagent tool — it creates a hidden sub-agent outside jaw's visibility and conflicts with phase accounting.
- Output subtask JSON or reference the \`dev-code-reviewer\` skill as a delegation target. You are the single reviewer for this task.
If the task seems to require parallel work, stop, write \`needs boss follow-up: <reason>\` in your output, and return. The boss will re-dispatch at the next phase.

## Current Phase: ${ap.currentPhase} (${phaseLabel})
${instruction}

## Remaining Phases: ${remainingPhases}

## Phase Merging (Highly Recommended ⚡)
**Complete as many phases as possible in a single pass.** Doing only 1 phase is allowed only when the task is uncertain.
- Simple fix/bugfix → Phases 3~5 all at once
- Clear feature addition → Phases 1~3 at once
- Code change + tests → Phases 3~4 at once

Example: planning + development together → complete analysis + code in one pass.
In that case, state which phases you completed at the end of your response:

Phases completed: ${ap.phaseProfile.slice(ap.currentPhaseIdx).join(', ')}

Use this exact plain-text format (NOT JSON). If you completed only one phase, you do not need to add this line.

${executionContext}

${worklogBlock}`.trim();

    broadcast('agent_status', {
        agentId: emp.id, agentName: emp.name,
        status: 'running', phase: ap.currentPhase, phaseLabel,
        isEmployee: true,
    });
    updateWorkerPhase(emp.id, String(ap.currentPhase), phaseLabel ?? '');

    const empSession = getEmployeeSession.get(emp.id) as Record<string, any> | undefined;
    const canResume = !!(empSession?.session_id && empSession?.cli === emp.cli);

    const monitor = startWorkerMonitor({
        agentId: emp.id,
        stallThresholdMs: 120_000,
        maxDurationMs: 600_000,
        onStall: (id) => broadcast('worker_stalled', { agentId: id, employeeName: emp.name, isEmployee: true }),
        onDisconnect: (id, code) => broadcast('worker_disconnected', { agentId: id, exitCode: code, isEmployee: true }),
        onTimeout: (id) => {
            broadcast('worker_timeout', { agentId: id, employeeName: emp.name, isEmployee: true });
            killAgentById(id);
        },
    });

    const { promise } = spawnAgent(taskPrompt, {
        agentId: emp.id, cli: emp.cli, model: emp.model,
        forceNew: !canResume,
        employeeSessionId: canResume ? empSession!.session_id : undefined,
        sysPrompt: sysPrompt,
        origin: meta.origin || 'web',
        env: {
            JAW_EMPLOYEE_MODE: '1',
            JAW_EMPLOYEE_NAME: String(emp.name || ''),
            JAW_EMPLOYEE_ROLE: String(ap.role || emp.role || ''),
        },
        lifecycle: {
            onActivity: (source) => monitor.touch(source as 'stdout' | 'stderr' | 'acp' | 'heartbeat'),
            onExit: (code) => monitor.exit(code),
        },
    });
    let r: Record<string, any>;
    try {
        r = await promise as Record<string, any>;
        monitor.stop();
    } catch (err) {
        monitor.stop();
        throw err;
    }
    const isSuccess = r.code === 0 || (r.code == null && (r.text || '').trim().length > 0);
    if (isSuccess && r.sessionId) {
        upsertEmployeeSession.run(emp.id, r.sessionId, emp.cli);
    }
    const result = {
        agent: ap.agent, role: ap.role, id: emp.id,
        phase: ap.currentPhase, phaseLabel,
        status: isSuccess ? 'done' : 'error',
        text: r.text || '',
    };

    // Parse phases_completed from agent output (supports both plain-text and legacy JSON)
    const responseText = r.text || '';

    // Plain-text format: "Phases completed: A, P, B" or "Phases completed: 1, 2, 3"
    const plainMatch = responseText.match(/Phases completed:\s*(.+)/i);
    // Legacy JSON format: { "phases_completed": [1, 2, 3] }
    const jsonMatch = responseText.match(/\{[\s\S]*"phases_completed"\s*:\s*\[[\d,\s]+\][\s\S]*\}/);

    let completedPhases: number[] | null = null;

    if (plainMatch) {
        const parts = plainMatch[1].split(',').map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => !isNaN(n));
        if (parts.length > 1) completedPhases = parts;
    } else if (jsonMatch) {
        try {
            const pc = JSON.parse(jsonMatch[0]);
            if (Array.isArray(pc.phases_completed) && pc.phases_completed.length > 1) {
                completedPhases = pc.phases_completed;
            }
        } catch (e) { console.debug('[orchestrator:phases] JSON parse failed'); }
    }

    if (completedPhases) {
        const maxCompleted = Math.max(...completedPhases);
        const newIdx = ap.phaseProfile.findIndex((p: number) => p > maxCompleted);
        if (newIdx === -1) {
            ap.completed = true;
            console.log(`[claw:phase-skip] ${ap.agent} completed ALL phases in one pass`);
        } else if (newIdx > ap.currentPhaseIdx + 1) {
            ap.currentPhaseIdx = newIdx;
            ap.currentPhase = ap.phaseProfile[newIdx];
            console.log(`[claw:phase-skip] ${ap.agent} jumped to phase ${ap.currentPhase} (completed: ${completedPhases})`);
        }
    }

    broadcast('agent_status', { agentId: emp.id, agentName: emp.name, status: result.status, phase: ap.currentPhase, isEmployee: true });

    if (worklogPath) {
        appendToWorklog(worklogPath, 'Execution Log',
            `### Round ${round} — ${result.agent} (${result.role}, ${result.phaseLabel})\n- Status: ${result.status}\n- Result: ${result.text.slice(0, 500)}`
        );
    }

    return result;
}
