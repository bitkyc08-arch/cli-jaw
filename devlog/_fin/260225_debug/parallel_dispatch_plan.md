# Parallel Employee Dispatch — Implementation Plan

> Date: 2026-02-25  
> Target: `src/orchestrator/pipeline.ts`, `src/prompt/builder.ts`  
> Status: **Draft (v2 — reviewed & revised)**

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

## 2. Pre-Existing Issue: Planning Agent Blind Spot

**CRITICAL FIX NEEDED (independent of parallel feature)**

The planning agent is spawned via `spawnAgent()` in `phasePlan()` (L200). This is a **separate** CLI spawn — it does NOT receive the system prompt built by `builder.ts`.

The system prompt (`builder.ts` L316-326) injects the available employees list:
```
### Available Employees
- "Frontend" (CLI: codex) — UI/UX 구현, CSS, 컴포넌트 개발
- "Backend" (CLI: gemini) — API, DB, 서버 로직 구현
...
```

But the **planning prompt** (`phasePlan()` L112-198) does NOT include this list. The planning agent currently has to **guess** agent names, which may not match the DB entries.

### Fix

Inject the available employees list into `phasePlan()` prompt dynamically:

```typescript
// In phasePlan(), before building planPrompt:
const emps = getEmployees.all() as Record<string, any>[];
const empList = emps.map(e => `- "${e.name}" (CLI: ${e.cli}, role: ${e.role || 'general'})`).join('\n');

// Add to planPrompt:
`## Available Employees
${empList}
Agent names in subtask JSON MUST exactly match the names above.`
```

This ensures the planning agent knows **exactly** which agents exist and their correct names.

---

## 3. Pre-Existing Issue: `parseDirectAnswer()` Silent Failure

When the planning agent returns **only natural language** (no JSON block), both `parseDirectAnswer()` and `parseSubtasks()` return `null`.

Current flow (pipeline.ts L204-212):
```typescript
const directAnswer = parseDirectAnswer(result.text);  // null
if (directAnswer) return ...;  // skipped
const subtasks = parseSubtasks(result.text);  // also null
return { planText, subtasks };  // subtasks = null → orchestrate() treats as no work
```

**Result**: The plan text gets logged to worklog but nothing executes. No error, no warning.

### Fix

Add explicit fallback when both parsers return null:

```typescript
const directAnswer = parseDirectAnswer(result.text);
if (directAnswer) {
    return { planText: directAnswer, subtasks: [], directAnswer };
}

const planText = stripSubtaskJSON(result.text);
const subtasks = parseSubtasks(result.text);

// NEW: Fallback — if no JSON found, treat entire response as direct answer
if (!subtasks || subtasks.length === 0) {
    console.warn('[orchestrator:plan] No JSON block found in planning agent response. Treating as direct answer.');
    return { planText: result.text, subtasks: [], directAnswer: result.text };
}

return { planText, subtasks };
```

---

## 4. Design: AI-Driven Concurrency Decision

The planning agent already performs file-level impact analysis (Phase 1). It knows which files each subtask will touch. We leverage this to let the AI decide:

- **parallel: true** → No file overlap with other subtasks, safe to run concurrently
- **parallel: false** (default) → Potential file conflict, must run sequentially

### Why AI Decides (Not Heuristics)

1. AI already lists `affected_files` per subtask (existing field in `verification`)
2. AI understands semantic dependencies beyond file-level (e.g., shared state, API contracts)
3. Simple heuristic (role != role) fails: two `backend` tasks on different modules can be parallel
4. AI can flag human-judgment cases: "parallel but review shared config after"

---

## 5. Subtask JSON Schema Change

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
      "agent": "Frontend",
      "role": "frontend",
      "task": "...",
      "start_phase": 3,
      "parallel": true,
      "verification": { "pass_criteria": "...", "affected_files": ["src/ui/..."] }
    },
    {
      "agent": "Backend",
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

## 6. Prompt Changes — Exact Text Specifications

Three prompt injection points need modification. Each is shown as the **final copy-paste-ready text**.

---

### 6.1 `phasePlan()` Prompt — Planning Agent (pipeline.ts L112–198)

The planning agent's prompt must be updated in 3 places:

#### A. Inject Available Employees (Bug Fix — after `## Decision Framework` header, L115)

**Code change** — before `const planPrompt = ...`:

```typescript
const emps = getEmployees.all() as Record<string, any>[];
const empList = emps.map(e => `- "${e.name}" (CLI: ${e.cli}, role: ${e.role || 'general'})`).join('\n');
```

**Prompt text** — insert between `## Decision Framework` and `### 🟢 Tier 0`:

```markdown
## Available Employees
${empList}

**CRITICAL: Agent names in subtask JSON MUST be an exact string match from the list above.**
Using any other name will cause the agent to not be found and the task to be skipped.
```

#### B. Add Parallel Dispatch Section (after Tier 2, before `## Task Instruction Quality Guide`)

Insert this exact block at L162 (after `These include coding conventions...`):

```markdown
### ⚡ Parallel Execution (Tier 1-2 only)
When 2+ subtasks modify **completely independent file sets**, mark them `"parallel": true`.
The orchestrator runs parallel-marked agents concurrently via Promise.all, then runs sequential agents after.

**Default is `false`. Only set `true` when you are confident there is ZERO file overlap.**

#### Decision Rules
1. Compare `affected_files` across ALL subtasks. ANY overlap → both must be `false`.
2. Shared config files (`package.json`, `tsconfig.json`, `.env`, `settings.json`) count as overlap.
3. Import/export dependencies count as overlap (if A imports from B's files, they conflict).
4. When uncertain → keep `false`. Correctness > speed.

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
Even if you mark tasks parallel, the orchestrator validates `affected_files` overlap.
If overlap is detected, it automatically downgrades to sequential with a warning.
So when genuinely unsure, `true` is safe — but unnecessary downgrades waste a log line.
```

#### C. Update Output Format JSON (L179–195) — Add `parallel` field

Replace the existing example JSON block:

```markdown
## Output Format (strictly required)
1. Explain your plan in natural language.
2. **Include verification criteria** for each subtask.
3. Subtask JSON:

\`\`\`json
{
  "subtasks": [
    {
      "agent": "ExactAgentName",
      "role": "frontend|backend|data|docs",
      "task": "Specific instruction with files, behavior, and constraints",
      "start_phase": 3,
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

**parallel field**: Optional, defaults to `false`. Set `true` only for tasks with zero file overlap.
**affected_files**: REQUIRED for all subtasks. Used by server-side parallel safety validation.
```

---

### 6.2 `distributeByPhase()` Task Prompt — Employee Agent (pipeline.ts L246–278)

The per-employee task prompt needs **two variants** depending on execution mode:

#### Current Text (L269–274):
```markdown
## 순차 실행 규칙
- **이전 에이전트가 이미 수정한 파일은 건드리지 마세요**
- 당신의 담당 영역(${ap.role})에만 집중하세요

### 이전 에이전트 결과
${priorSummary}
```

#### Proposed: Dynamic Context Block

Replace with a conditional block that adapts based on `ap.parallel`:

```typescript
// Build execution context based on parallel/sequential mode
const executionContext = ap.parallel
    ? `## 병렬 실행 모드 ⚡
- 다른 에이전트가 **동시에** 작업 중입니다.
- 당신의 담당 영역(${ap.role})과 지정된 파일에만 집중하세요.
- **절대** 다른 에이전트의 affected_files에 해당하는 파일을 수정하지 마세요.
- 공유 설정 파일(package.json, tsconfig.json 등)을 수정하지 마세요.

### 당신의 담당 파일
${(ap.verification?.affected_files || []).map((f: string) => '- ' + f).join('\n') || '(지정된 파일 없음 — 담당 영역에만 집중)'}

### 동시 작업 중인 에이전트
${parallelPeers.map((p: any) => `- ${p.agent} (${p.role}): ${(p.verification?.affected_files || []).join(', ')}`).join('\n')}`

    : `## 순차 실행 규칙
- **이전 에이전트가 이미 수정한 파일은 건드리지 마세요**
- 당신의 담당 영역(${ap.role})에만 집중하세요

### 이전 에이전트 결과
${priorSummary}`;
```

**Key difference**: Parallel agents get:
- Their own `affected_files` list (boundary enforcement)
- A list of concurrent peers and their files (awareness, not dependency)
- Explicit warning to avoid shared config files

Sequential agents keep the existing behavior (prior results summary).

#### `parallelPeers` Construction

In `distributeByPhase()`, when processing parallel group:

```typescript
// Before spawning parallel agents, build peer list for each
const parallelPeers = parallelGroup.map(ap => ({
    agent: ap.agent,
    role: ap.role,
    verification: ap.verification,
}));
```

Each parallel agent receives the full peer list (including itself — it can filter by own name if needed).

---

### 6.3 `builder.ts` System Prompt — Main Agent (L330–337)

Add 2 lines to the CRITICAL RULES section:

```typescript
prompt += '\n7. Simple questions, single-file edits, or tasks in your expertise → handle directly';
prompt += '\n8. For Tier 1-2 tasks: mark independent subtasks with `"parallel": true` for concurrent execution';
prompt += '\n9. Default is `"parallel": false`. Only use `true` when affected_files have zero overlap';
```

This is the **lightest touch** — the main agent just needs awareness that the field exists. The detailed decision logic is in `phasePlan()` where it matters.

---

## 7. Code Changes — Runtime Logic

### 7.1 `initAgentPhases()` — Add `parallel` field (pipeline.ts L83–93)

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
     history: [] as Record<string, any>[],
 };
```

### 7.2 `distributeByPhase()` — Split parallel/sequential (pipeline.ts L218–336)

**Step 1: Extract `runSingleAgent()`** — move L227-333 into a standalone function:

```typescript
async function runSingleAgent(
    ap: Record<string, any>,
    emp: Record<string, any>,
    worklog: Record<string, any>,
    round: number,
    meta: Record<string, any>,
    priorResults: Record<string, any>[],
    parallelPeers: Record<string, any>[] = []  // empty for sequential
): Promise<Record<string, any>> {
    const instruction = PHASE_INSTRUCTIONS[ap.currentPhase as keyof typeof PHASE_INSTRUCTIONS];
    const phaseLabel = PHASES[ap.currentPhase as keyof typeof PHASES];
    const sysPrompt = getEmployeePromptV2(emp, ap.role, ap.currentPhase);

    // Build execution context (parallel vs sequential — see §6.2)
    const executionContext = ap.parallel
        ? buildParallelContext(ap, parallelPeers)
        : buildSequentialContext(ap, priorResults);

    const remainingPhases = ap.phaseProfile
        .slice(ap.currentPhaseIdx)
        .map((p: number) => `${p}(${PHASES[p as keyof typeof PHASES]})`)
        .join('→');

    const taskPrompt = `## 작업 지시 [${phaseLabel}]
${ap.task}

## 현재 Phase: ${ap.currentPhase} (${phaseLabel})
${instruction}

## 남은 Phase: ${remainingPhases}

## Phase 합치기 (적극 권장 ⚡)
... (existing text unchanged) ...

${executionContext}

## Worklog
이 파일을 먼저 읽으세요: ${worklog.path}
작업 완료 후 반드시 Execution Log 섹션에 결과를 기록하세요.`;

    // ... rest of spawn/session/result logic (L280-332, unchanged) ...
}
```

**Step 2: Rewrite `distributeByPhase()` body:**

```typescript
async function distributeByPhase(agentPhases: Record<string, any>[], worklog: Record<string, any>, round: number, meta: Record<string, any> = {}) {
    const emps = getEmployees.all() as Record<string, any>[];
    const results: Record<string, any>[] = [];
    const active = agentPhases.filter((ap: Record<string, any>) => !ap.completed);
    if (active.length === 0) return results;

    // Validate parallel safety before execution
    validateParallelSafety(active);

    const parallelGroup = active.filter(ap => ap.parallel === true);
    const sequentialGroup = active.filter(ap => ap.parallel !== true);

    // Phase 1: Run parallel group concurrently
    if (parallelGroup.length > 0) {
        console.log(`[orchestrator:parallel] Running ${parallelGroup.length} agents concurrently: ${parallelGroup.map(a => a.agent).join(', ')}`);
        const parallelPeers = parallelGroup.map(ap => ({
            agent: ap.agent, role: ap.role, verification: ap.verification,
        }));
        const parallelPromises = parallelGroup.map(ap => {
            const emp = findEmployee(emps, ap);
            if (!emp) return Promise.resolve({ agent: ap.agent, role: ap.role, status: 'skipped', text: 'Agent not found' });
            return runSingleAgent(ap, emp, worklog, round, meta, [], parallelPeers);
        });
        const parallelResults = await Promise.all(parallelPromises);
        results.push(...parallelResults);
    }

    // Phase 2: Run sequential group one-by-one
    for (const ap of sequentialGroup) {
        const emp = findEmployee(emps, ap);
        if (!emp) {
            results.push({ agent: ap.agent, role: ap.role, status: 'skipped', text: 'Agent not found' });
            continue;
        }
        const result = await runSingleAgent(ap, emp, worklog, round, meta, results);
        results.push(result);
    }

    return results;
}

// Helper: find employee by name (extracted from L227-229)
function findEmployee(emps: Record<string, any>[], ap: Record<string, any>) {
    return emps.find(e => e.name === ap.agent || e.name?.includes(ap.agent) || ap.agent.includes(e.name));
}
```

### 7.3 `validateParallelSafety()` — Server-side guard (new function)

```typescript
function validateParallelSafety(agentPhases: Record<string, any>[]): void {
    const parallelAgents = agentPhases.filter(ap => ap.parallel);
    if (parallelAgents.length < 2) return;  // nothing to validate

    const fileMap = new Map<string, string>();  // file → first agent name

    for (const ap of parallelAgents) {
        const files: string[] = ap.verification?.affected_files || [];
        for (const file of files) {
            const existing = fileMap.get(file);
            if (existing && existing !== ap.agent) {
                console.warn(
                    `[orchestrator:parallel-guard] File conflict detected: "${file}" — ` +
                    `"${existing}" and "${ap.agent}" both marked parallel. ` +
                    `Downgrading "${ap.agent}" to sequential.`
                );
                ap.parallel = false;
                break;  // one conflict is enough to downgrade
            }
            fileMap.set(file, ap.agent);
        }
    }
}
```

### 7.4 `phasePlan()` — No-JSON Fallback (Bug Fix, pipeline.ts L209-213)

```typescript
const planText = stripSubtaskJSON(result.text);
appendToWorklog(worklog.path, 'Plan', planText || '(Plan Agent 응답 없음)');

const subtasks = parseSubtasks(result.text);

// Fallback: if planning agent responded without JSON, treat as direct answer
if (!subtasks || subtasks.length === 0) {
    console.warn('[orchestrator:plan] No JSON block found in planning response. Treating as direct answer.');
    return { planText: result.text, subtasks: [], directAnswer: result.text };
}

return { planText, subtasks };
```

### 7.5 Prompt Helper Functions (new, for §6.2 task prompt)

```typescript
function buildParallelContext(ap: Record<string, any>, peers: Record<string, any>[]): string {
    const myFiles = (ap.verification?.affected_files || []).map((f: string) => `- ${f}`).join('\n') || '(지정된 파일 없음)';
    const peerList = peers
        .filter(p => p.agent !== ap.agent)
        .map(p => `- ${p.agent} (${p.role}): ${(p.verification?.affected_files || []).join(', ') || 'unspecified'}`)
        .join('\n') || '(없음)';

    return `## 병렬 실행 모드 ⚡
- 다른 에이전트가 **동시에** 작업 중입니다.
- 당신의 담당 영역(${ap.role})과 아래 지정 파일에만 집중하세요.
- **절대** 다른 에이전트의 파일을 수정하지 마세요.
- 공유 설정 파일(package.json, tsconfig.json 등)을 수정하지 마세요.

### 당신의 담당 파일
${myFiles}

### 동시 작업 중인 에이전트
${peerList}`;
}

function buildSequentialContext(ap: Record<string, any>, priorResults: Record<string, any>[]): string {
    const priorSummary = priorResults.length > 0
        ? priorResults.map(r => `- ${r.agent} (${r.role}): ${r.status} — ${r.text.slice(0, 150)}`).join('\n')
        : '(첫 번째 에이전트입니다)';

    return `## 순차 실행 규칙
- **이전 에이전트가 이미 수정한 파일은 건드리지 마세요**
- 당신의 담당 영역(${ap.role})에만 집중하세요

### 이전 에이전트 결과
${priorSummary}`;
}
```

---

## 8. Implementation Order

| Step | Section | Change | Risk | Shippable Alone? |
|------|---------|--------|------|-------------------|
| 1 | §6.1A | Inject employee list into `phasePlan()` prompt | Low — additive | ✅ Yes |
| 2 | §7.4 | `parseDirectAnswer` no-JSON fallback | Low — defensive | ✅ Yes |
| 3 | §7.1 | Add `parallel` field to `initAgentPhases()` | None — unused until step 6 | ✅ Yes |
| 4 | §6.1B, §6.1C, §6.3 | Add parallel prompt sections (phasePlan + builder) | None — prompt only | ✅ Yes |
| 5 | §7.5 | Add `buildParallelContext()` + `buildSequentialContext()` helpers | None — unused until step 6 | ✅ Yes |
| 6 | §7.2 | Extract `runSingleAgent()`, rewrite `distributeByPhase()` | **Medium** — behavior change | ❌ Ship with 7 |
| 7 | §7.3 | Add `validateParallelSafety()` | Low — guard | ❌ Ship with 6 |

**Strategy**: Steps 1-5 are zero-risk, ship independently. Steps 6-7 are the core parallel feature, ship together with testing.

---

## 9. Verification Plan

### Automated
```bash
npm run build   # TypeScript compilation
npm test        # Existing tests must pass (backward-compat)
```

### Manual Test Cases

| # | Scenario | Expected | Pass Criteria |
|---|----------|----------|---------------|
| 1 | Dispatch without `parallel` field | Identical sequential behavior | Console shows no `[orchestrator:parallel]` log |
| 2 | 2 independent tasks: Frontend + Docs, both `parallel: true` | Both spawn simultaneously | Console: `Running 2 agents concurrently: Frontend, Docs` |
| 3 | 2 conflicting tasks, same `affected_files`, both `parallel: true` | Server downgrades one to sequential | Console: `[orchestrator:parallel-guard] File conflict detected...` |
| 4 | Mixed: 2 parallel + 1 sequential | Parallel finish first, then sequential | Sequential agent sees parallel results in `priorResults` |
| 5 | Planning agent responds without JSON | Direct answer returned, no error | No crash, worklog has response text |
| 6 | Planning agent uses wrong agent name | Subtask skipped with warning | Result: `{ status: 'skipped', text: 'Agent not found' }` |
| 7 | Parallel session preservation | Employee sessions saved/resumed per agent | `upsertEmployeeSession` called for each parallel agent |

### Log Output Verification
```
[orchestrator:parallel] Running 2 agents concurrently: Frontend, Docs
[orchestrator:sequential] Running 1 agent sequentially: Backend
[orchestrator:parallel-guard] File conflict detected: "src/config.ts" — "Frontend" and "Backend" both marked parallel. Downgrading "Backend" to sequential.
```

---

## 10. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Two parallel agents modify same file | High | `validateParallelSafety()` auto-downgrades + `affected_files` overlap check |
| AI marks everything as parallel | Medium | Prompt: "Default `false`. Correctness > speed." + Decision Matrix table |
| Planning agent uses wrong agent names | Medium | Employee list dynamically injected into planning prompt (§6.1A) |
| Planning agent returns no JSON | Low | Fallback treats response as direct answer (§7.4) |
| Worklog race condition (parallel writes) | Low | `appendToWorklog` uses `fs.appendFileSync` (atomic on POSIX) |
| CLI binary conflict (same binary spawned twice) | None | Each employee has unique `agentId` + `employeeSessionId` |
| Memory/CPU spike from parallel spawns | Low | Max 4 employees already limits concurrency |

---

## 11. Files Changed Summary

| File | Functions Modified | Change Description |
|------|-------------------|-------------------|
| `src/orchestrator/pipeline.ts` | `phasePlan()` | Inject employee list + parallel guidelines + no-JSON fallback |
| `src/orchestrator/pipeline.ts` | `initAgentPhases()` | Add `parallel` field from subtask JSON |
| `src/orchestrator/pipeline.ts` | `distributeByPhase()` | Split into parallel + sequential groups, call `runSingleAgent()` |
| `src/orchestrator/pipeline.ts` | *(new)* `runSingleAgent()` | Extracted per-agent logic from `distributeByPhase()` |
| `src/orchestrator/pipeline.ts` | *(new)* `validateParallelSafety()` | Server-side file overlap guard |
| `src/orchestrator/pipeline.ts` | *(new)* `buildParallelContext()` | Parallel agent task prompt context |
| `src/orchestrator/pipeline.ts` | *(new)* `buildSequentialContext()` | Sequential agent task prompt context (refactored from inline) |
| `src/orchestrator/pipeline.ts` | *(new)* `findEmployee()` | Extracted employee lookup helper |
| `src/prompt/builder.ts` | `getSystemPrompt()` | Add rules 8-9 for parallel dispatch awareness |
