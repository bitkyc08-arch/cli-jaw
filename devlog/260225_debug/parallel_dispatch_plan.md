# Parallel Employee Dispatch — Implementation Plan

> Date: 2026-02-25  
> Target: `src/orchestrator/pipeline.ts`, `src/prompt/builder.ts`  
> Status: **Draft**

---

## 1. Problem Statement

Currently, `distributeByPhase()` (pipeline.ts L226) executes all employees **strictly sequentially** using a `for...of` loop with `await`. This is safe but slow — when employees work on completely independent file sets (e.g., frontend UI + documentation), they wait unnecessarily for each other.

### Current Flow

```
Employee A (frontend) ──────────────> done
                                       Employee B (docs) ──────────────> done
                                                                          Employee C (backend) ──> done
Total: A + B + C time
```

### Desired Flow

```
Employee A (frontend) ──────────────> done ─┐
Employee B (docs)     ──────────────> done ─┤──> review
                                             │
Employee C (backend)  ─────(sequential, depends on A)──> done ─┘
Total: max(A, B) + C time
```

---

## 2. Design: AI-Driven Concurrency Decision

The planning agent already performs file-level impact analysis (Phase 1). It knows which files each subtask will touch. We leverage this to let the AI decide:

- **parallel: true** → No file overlap with other subtasks, safe to run concurrently
- **parallel: false** (default) → Potential file conflict, must run sequentially

### Why AI Decides (Not Heuristics)

1. AI already lists `affected_files` per subtask (existing field in `verification`)
2. AI understands semantic dependencies beyond file-level (e.g., shared state, API contracts)
3. Simple heuristic (role != role) fails: two `backend` tasks on different modules can be parallel
4. AI can flag human-judgment cases: "parallel but review shared config after"

---

## 3. Subtask JSON Schema Change

### Current

```json
{
  "subtasks": [
    {
      "agent": "FE-Dev",
      "role": "frontend",
      "task": "...",
      "start_phase": 3,
      "verification": { "pass_criteria": "...", "affected_files": ["src/ui/..."] }
    }
  ]
}
```

### Proposed (additive, backward-compatible)

```json
{
  "subtasks": [
    {
      "agent": "FE-Dev",
      "role": "frontend",
      "task": "...",
      "start_phase": 3,
      "parallel": true,
      "verification": { "pass_criteria": "...", "affected_files": ["src/ui/..."] }
    },
    {
      "agent": "BE-Dev",
      "role": "backend",
      "task": "...",
      "start_phase": 3,
      "parallel": false,
      "verification": { "pass_criteria": "...", "affected_files": ["src/server.ts"] }
    }
  ]
}
```

- `parallel` field is **optional**, defaults to `false` (safe sequential execution)
- Backward-compatible: existing JSON without `parallel` keeps working identically

---

## 4. Code Changes

### 4.1 `src/orchestrator/pipeline.ts` — `distributeByPhase()`

**Current** (L226–334): Single `for...of` loop, sequential `await`.

**Proposed**: Split active agents into two groups, run parallel group with `Promise.all`, then sequential group one-by-one.

```typescript
async function distributeByPhase(agentPhases, worklog, round, meta) {
    const emps = getEmployees.all();
    const results = [];
    const active = agentPhases.filter(ap => !ap.completed);
    if (active.length === 0) return results;

    // ── NEW: Split into parallel and sequential groups ──
    const parallelGroup = active.filter(ap => ap.parallel === true);
    const sequentialGroup = active.filter(ap => ap.parallel !== true);

    // 1. Run parallel group concurrently (no file conflicts guaranteed by planner)
    if (parallelGroup.length > 0) {
        const parallelPromises = parallelGroup.map(ap =>
            runSingleAgent(ap, emps, worklog, round, meta, [])
        );
        const parallelResults = await Promise.all(parallelPromises);
        results.push(...parallelResults);
    }

    // 2. Run sequential group one-by-one (may depend on parallel results)
    for (const ap of sequentialGroup) {
        const result = await runSingleAgent(ap, emps, worklog, round, meta, results);
        results.push(result);
    }

    return results;
}
```

**Extract helper**: Refactor the per-agent logic (L228–333) into `runSingleAgent()`:

```typescript
async function runSingleAgent(
    ap: AgentPhase,
    emps: Employee[],
    worklog: Worklog,
    round: number,
    meta: Record<string, any>,
    priorResults: Result[]
): Promise<Result> {
    // ... existing logic from L228-333, parameterized with priorResults
}
```

### 4.2 `src/orchestrator/pipeline.ts` — `initAgentPhases()`

Add `parallel` field to the agent phase object:

```diff
 return {
     agent: st.agent,
     task: st.task,
     role,
+    parallel: st.parallel === true,
     verification: st.verification || null,
     phaseProfile: effectiveProfile,
     currentPhaseIdx: 0,
     currentPhase: effectiveProfile[0],
     completed: false,
     history: [],
 };
```

### 4.3 `src/orchestrator/pipeline.ts` — `phasePlan()` prompt

Add parallel dispatch guidelines to the planning prompt (L112–199):

```markdown
### Parallel Dispatch (NEW)
When subtasks modify **completely independent file sets**, mark them as `"parallel": true`.
The orchestrator will run parallel-marked agents concurrently using Promise.all.

#### When to use `parallel: true`
- Frontend UI changes + Documentation updates (zero file overlap)
- Two backend modules with no shared imports
- Test writing + unrelated feature development

#### When to keep `parallel: false` (default)
- Two agents modifying the same file or module
- Agent B depends on Agent A's output (e.g., API consumer depends on API provider)
- Shared state/config files are involved
- When uncertain — sequential is always safe

#### Rules
1. If `affected_files` arrays overlap between any two subtasks → both MUST be `parallel: false`
2. When in doubt, default to `false` — correctness over speed
3. At least one agent should be `parallel: false` if there's a "main" task that others depend on
4. Documentation-only tasks (`role: "docs"`) are almost always safe to parallelize
```

### 4.4 `src/prompt/builder.ts` — System Prompt (Orchestration Section)

Update the orchestration description in `getSystemPrompt()` (L310–333) to mention parallel capability:

```diff
 prompt += '\n4. Dispatch employees ONLY when the task genuinely needs multiple specialists or parallel work';
+prompt += '\n8. Mark independent subtasks with "parallel": true for concurrent execution';
+prompt += '\n9. Keep "parallel": false (default) when file conflicts or dependencies exist';
```

---

## 5. Planning Prompt — Full English Guidelines (for A1 injection)

This is the exact text to add to the planning agent's dispatch prompt:

```
## Concurrency Control

You control whether employees run in parallel or sequentially.

### Decision Matrix

| Condition                                      | parallel | Reason                        |
|------------------------------------------------|----------|-------------------------------|
| Different roles, zero file overlap             | true     | Safe: independent workspaces  |
| Same role, different modules/directories       | true     | Safe: no import/export clash  |
| Any shared file in affected_files              | false    | Risk: merge conflict          |
| Consumer depends on producer output            | false    | Risk: race condition          |
| Modifying shared config (settings, package)    | false    | Risk: overwrite               |
| Documentation + any other task                 | true     | Safe: docs never conflict     |
| Uncertain about overlap                        | false    | Default: correctness > speed  |

### JSON Field

Add `"parallel": true` to each independent subtask:

```json
{
  "subtasks": [
    { "agent": "FE", "role": "frontend", "task": "...", "parallel": true,
      "verification": { "affected_files": ["src/ui/Button.tsx"] } },
    { "agent": "Docs", "role": "docs", "task": "...", "parallel": true,
      "verification": { "affected_files": ["README.md"] } },
    { "agent": "BE", "role": "backend", "task": "...", "parallel": false,
      "verification": { "affected_files": ["src/server.ts"] } }
  ]
}
```

FE + Docs run simultaneously. BE waits for both to finish before starting.

### Safety Guarantee
- `parallel` defaults to `false` if omitted — no existing behavior changes
- The orchestrator validates: if two parallel agents share an affected_file, it falls back to sequential and logs a warning
```

---

## 6. Safety: Server-Side Validation

Even if the AI marks two conflicting tasks as parallel, add a server-side guard:

```typescript
function validateParallelSafety(agentPhases: AgentPhase[]): void {
    const parallelAgents = agentPhases.filter(ap => ap.parallel);
    const fileMap = new Map<string, string>(); // file → agent

    for (const ap of parallelAgents) {
        const files = ap.verification?.affected_files || [];
        for (const file of files) {
            if (fileMap.has(file)) {
                console.warn(`[orchestrator:parallel] File conflict: ${file} — ` +
                    `${fileMap.get(file)} and ${ap.agent} both marked parallel. ` +
                    `Falling back to sequential for ${ap.agent}.`);
                ap.parallel = false;
            } else {
                fileMap.set(file, ap.agent);
            }
        }
    }
}
```

Call this in `orchestrate()` after `initAgentPhases()`, before the round loop.

---

## 7. Verification Plan

### Automated Tests

```bash
# Existing tests should still pass (backward-compat)
npm test

# Build check
npm run build
```

### Manual Verification

1. **Sequential fallback**: Dispatch without `parallel` field → confirm identical behavior
2. **Parallel execution**: Dispatch 2 independent tasks (frontend + docs) → confirm both spawn simultaneously (check timestamps in console log)
3. **Safety guard**: Intentionally mark two conflicting tasks as parallel → confirm server downgrades to sequential with warning
4. **Session preservation**: Confirm employee sessions are still saved/resumed correctly in parallel mode

### Log Verification

```
[orchestrator:parallel] Running 2 agents in parallel: FE-Dev, Docs
[orchestrator:sequential] Running 1 agent sequentially: BE-Dev
```

---

## 8. Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Two parallel agents modify same file | Server-side `validateParallelSafety()` guard |
| AI marks everything as parallel | Prompt says "default false, correctness > speed" |
| Session conflict (same CLI binary) | Each employee has its own `agentId` and `employeeSessionId` |
| Memory/CPU spike from parallel spawns | Max 4 employees already limits concurrency |
| Worklog race condition (parallel writes) | `appendToWorklog` uses `fs.appendFileSync` (atomic on most OS) |

---

## 9. Files Changed Summary

| File | Change |
|------|--------|
| `src/orchestrator/pipeline.ts` | `distributeByPhase()` split into parallel+sequential, extract `runSingleAgent()`, `initAgentPhases()` adds `parallel` field, `phasePlan()` prompt update |
| `src/prompt/builder.ts` | Orchestration section in `getSystemPrompt()` mentions parallel dispatch |
| `devlog/str_func/memory_architecture.md` | (optional) Add orchestration concurrency note |
