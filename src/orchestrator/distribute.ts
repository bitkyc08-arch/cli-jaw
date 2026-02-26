// ─── Distribute Helpers (parallel/sequential agent execution) ──
// Extracted from pipeline.ts for 500-line compliance.

import { broadcast } from '../core/bus.js';
import { getEmployeeSession, upsertEmployeeSession } from '../core/db.js';
import { getEmployeePromptV2 } from '../prompt/builder.js';
import { spawnAgent } from '../agent/spawn.js';
import { appendToWorklog } from '../memory/worklog.js';

// ─── Phase Constants (shared with pipeline.ts) ───────

export const PHASES: Record<number, string> = { 1: '기획', 2: '기획검증', 3: '개발', 4: '디버깅', 5: '통합검증' };

export const PHASE_INSTRUCTIONS: Record<number, string> = {
    1: `[기획] 이 계획의 실현 가능성을 검증하세요. 코드 작성 금지.
     - 필수: 영향 범위 분석 (어떤 파일들이 변경되는가)
     - 필수: 의존성 확인 (import/export 충돌 없는가)
     - 필수: 엣지 케이스 목록 (null/empty/error 처리)
     - worklog에 분석 결과를 기록하세요.`,
    2: `[기획검증] 설계 문서를 검증하고 누락된 부분을 보완하세요.
     - 필수: 파일 변경 목록과 실제 코드 대조 (함수명, 라인 번호)
     - 필수: 충돌 검사 (다른 agent 작업과 같은 파일 수정하는가)
     - 필수: 테스트 전략 수립 (verifyable 기준 정의)
     - worklog에 검증 결과를 기록하세요.`,
    3: `[개발] 문서를 참조하여 코드를 작성하세요.
     - 필수: 변경된 파일 목록과 단위 당 핵심 변경 설명
     - 필수: 기존 export/import 깨뜨리지 않았는지 확인
     - 필수: 코드가 lint/build 에러 없이 동작하는지 검증
     - worklog Execution Log에 변경 로그를 기록하세요.`,
    4: `[디버깅] 코드를 실행/테스트하고 버그를 수정하세요.
     - 필수: 실행 결과 스크린샷/로그 첨부
     - 필수: 발견된 버그 목록과 수정 내역
     - 필수: 엣지 케이스 테스트 결과 (null/empty/error)
     - worklog에 디버그 로그를 기록하세요.`,
    5: `[통합검증] 다른 영역과의 통합을 검증하세요.
     - 필수: 다른 agent 산출물과의 통합 테스트
     - 필수: 최종 문서 업데이트 (README, 변경로그)
     - 필수: 전체 워크플로우 동작 확인
     - worklog에 최종 검증 결과를 기록하세요.`,
};

// ─── Prompt Context Helpers ──────────────────────────

export function buildParallelContext(ap: Record<string, any>, peers: Record<string, any>[]): string {
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

export function buildSequentialContext(ap: Record<string, any>, priorResults: Record<string, any>[]): string {
    const priorSummary = priorResults.length > 0
        ? priorResults.map(r => `- ${r.agent} (${r.role}): ${r.status} — ${r.text.slice(0, 150)}`).join('\n')
        : '(첫 번째 에이전트입니다)';

    return `## 순차 실행 규칙
- **이전 에이전트가 이미 수정한 파일은 건드리지 마세요**
- 당신의 담당 영역(${ap.role})에만 집중하세요

### 이전 에이전트 결과
${priorSummary}`;
}

// ─── Employee Lookup ─────────────────────────────────

export function findEmployee(emps: Record<string, any>[], ap: Record<string, any>) {
    return emps.find(e => e.name === ap.agent || e.name?.includes(ap.agent) || ap.agent.includes(e.name));
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
      "role": "frontend|backend|data|docs",
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

    const taskPrompt = `## 작업 지시 [${phaseLabel}]
${ap.task}

## 현재 Phase: ${ap.currentPhase} (${phaseLabel})
${instruction}

## 남은 Phase: ${remainingPhases}

## Phase 합치기 (적극 권장 ⚡)
**가능한 한 여러 Phase를 한 번에 완료하세요.** 1 Phase만 하는 것은 작업이 불확실할 때만 허용됩니다.
- 간단한 수정/버그픽스 → Phase 3~5 전부 한 번에
- 명확한 기능 추가 → Phase 1~3 한 번에
- 코드 수정 + 테스트 → Phase 3~4 한 번에

예: 기획과 개발을 동시에 → 기획 분석 + 코드 작성까지 한 번에 완료.
이 경우 응답 마지막에 아래 JSON을 추가하세요:

\`\`\`json
{ "phases_completed": [${ap.phaseProfile.slice(ap.currentPhaseIdx).join(', ')}] }
\`\`\`

한 Phase만 완료한 경우에는 이 JSON을 넣지 않아도 됩니다.

${executionContext}

## Worklog
이 파일을 먼저 읽으세요: ${worklog.path}
작업 완료 후 반드시 Execution Log 섹션에 결과를 기록하세요.`;

    broadcast('agent_status', {
        agentId: emp.id, agentName: emp.name,
        status: 'running', phase: ap.currentPhase, phaseLabel,
    });

    const empSession = getEmployeeSession.get(emp.id) as Record<string, any> | undefined;
    const canResume = !!(empSession?.session_id && empSession?.cli === emp.cli);
    const { promise } = spawnAgent(taskPrompt, {
        agentId: emp.id, cli: emp.cli, model: emp.model,
        forceNew: !canResume,
        employeeSessionId: canResume ? empSession!.session_id : undefined,
        sysPrompt: canResume ? undefined : sysPrompt,
        origin: meta.origin || 'web',
    });

    const r = await promise as Record<string, any>;
    if (r.code === 0 && r.sessionId) {
        upsertEmployeeSession.run(emp.id, r.sessionId, emp.cli);
    }
    const result = {
        agent: ap.agent, role: ap.role, id: emp.id,
        phase: ap.currentPhase, phaseLabel,
        status: r.code === 0 ? 'done' : 'error',
        text: r.text || '',
    };

    // phases_completed 파싱
    const pcMatch = (r.text || '').match(/\{[\s\S]*"phases_completed"\s*:\s*\[[\d,\s]+\][\s\S]*\}/);
    if (pcMatch) {
        try {
            const pc = JSON.parse(pcMatch[0]);
            if (Array.isArray(pc.phases_completed) && pc.phases_completed.length > 1) {
                const maxCompleted = Math.max(...pc.phases_completed);
                const newIdx = ap.phaseProfile.findIndex((p: number) => p > maxCompleted);
                if (newIdx === -1) {
                    ap.completed = true;
                    console.log(`[claw:phase-skip] ${ap.agent} completed ALL phases in one pass`);
                } else if (newIdx > ap.currentPhaseIdx + 1) {
                    ap.currentPhaseIdx = newIdx;
                    ap.currentPhase = ap.phaseProfile[newIdx];
                    console.log(`[claw:phase-skip] ${ap.agent} jumped to phase ${ap.currentPhase} (completed: ${pc.phases_completed})`);
                }
            }
        } catch (e) { console.debug('[orchestrator:phases] JSON parse failed'); }
    }

    broadcast('agent_status', { agentId: emp.id, agentName: emp.name, status: result.status, phase: ap.currentPhase });

    appendToWorklog(worklog.path, 'Execution Log',
        `### Round ${round} — ${result.agent} (${result.role}, ${result.phaseLabel})\n- Status: ${result.status}\n- Result: ${result.text.slice(0, 500)}`
    );

    return result;
}
