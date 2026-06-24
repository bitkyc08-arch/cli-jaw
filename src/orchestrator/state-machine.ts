// ─── PABCD State Machine ────────────────────────────
// Sole orchestration state manager. Replaces the old round-loop pipeline entirely.
// State persisted in jaw.db orc_state table.
// CLI (bin/commands/orchestrate.ts) and server share the same DB.

import { getOrcState, setOrcState, resetOrcState, resetAllOrcStates, deleteNonDefaultOrcStates } from '../core/db.js';
import { broadcast } from '../core/bus.js';
import { readLatestWorklog } from '../memory/worklog.js';
import type { RemoteTarget } from '../messaging/types.js';
import type { ResolvedSelection } from './parser.js';
import type { Seed } from './seed.js';

// ─── Types ──────────────────────────────────────────

export type OrcStateName = 'IDLE' | 'I' | 'P' | 'A' | 'B' | 'C' | 'D';

export type AuditVerdict = 'pending' | 'pass' | 'fail';
export type VerificationVerdict = 'pending' | 'done' | 'needs_fix';

// ─── P1-1: Interview Evidence-Ref ──────────────────
export type EvidenceSource = 'user_statement' | 'repo_fact' | 'inference' | 'assumption' | 'default';
export type EvidenceDimension = 'goal' | 'constraint' | 'success' | 'ontology';

export interface InterviewEvidence {
  fact: string;
  source: EvidenceSource;
  confidence: number;
  turnNumber: number;
  dimension?: EvidenceDimension;
}

// ─── P2-2: Dimension Assessment ────────────────────
export type ClarityLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface DimensionAssessment {
  goal: ClarityLevel;
  constraint: ClarityLevel;
  success: ClarityLevel;
  ontology: ClarityLevel;
}

// ─── P1-2: Build Budget Gate ───────────────────────
export interface BuildBudget {
  maxWorkerDispatches: number;
  maxSelfHealRetries: number;
  maxVerificationRounds: number;
  spent: {
    workerDispatches: number;
    selfHealRetries: number;
    verificationRounds: number;
  };
}

export interface OrcContext {
  originalPrompt: string;
  workingDir: string | null;
  scopeId?: string;
  plan: string | null;
  workerResults: string[];
  origin: string;
  target?: RemoteTarget;
  chatId?: string | number;
  // ─── Phase 56.1: Plan lives in worklog ## Plan, not in project-root file ──
  worklogPath?: string;
  planHash?: string;
  planUpdatedAt?: string;
  taskAnchor?: string;
  resolvedSelection?: ResolvedSelection;
  // ─── Phase 58: Phase-transition gates ─────────────
  auditStatus?: AuditVerdict;
  verificationStatus?: VerificationVerdict;
  userApproved?: boolean;
  projectDirs?: string[] | null;
  // ─── Interview state (P1-1: Evidence-Ref) ────────
  interview?: {
    request: string;
    round: number;
    known: InterviewEvidence[];
    unknown: string[];
    assessment?: DimensionAssessment;
    history?: Array<{ round: number; question: string; answer: string }>;
  };
  // ─── Seed (P2-1) ────────────────────────────────
  seedSpec?: Seed;
  // ─── Build budget (P1-2) ─────────────────────────
  buildBudget?: BuildBudget;
  // ─── Reject cycles (P2-4) ───────────────────────
  rejectCycles?: { codeToB: number; planToP: number; specToI: number };
  // ─── Delivery (P3-5) ───────────────────────────
  delivery?: { filesChanged: string[]; acsMet: string[]; acsNotMet: string[] };
  researchReport?: string | null;
}

// ─── State Read/Write (DB-backed) ───────────────────

export function getState(scope = 'default'): OrcStateName {
  const row = getOrcState.get(scope) as { state?: string } | undefined;
  return (row?.state as OrcStateName) || 'IDLE';
}

export function getCtx(scope = 'default'): OrcContext | null {
  const row = getOrcState.get(scope) as { ctx?: string | null } | undefined;
  if (!row?.ctx) return null;
  try {
    const parsed = JSON.parse(row.ctx);
    if (parsed && parsed.workingDir === undefined) parsed.workingDir = null;
    return parsed;
  } catch { return null; }
}

export function setState(
  s: OrcStateName,
  ctx?: OrcContext | null,
  scope = 'default',
  titleOverride?: string | null,
): void {
  const ctxJson = ctx !== undefined
    ? (ctx ? JSON.stringify(ctx) : null)
    : (s === 'P'
      ? null
      : ((getOrcState.get(scope) as { ctx?: string | null } | undefined)?.ctx || null));
  setOrcState.run(scope, s, ctxJson);

  // Parse worklog title (max 2 words + …)
  let title = titleOverride || 'PABCD';
  if (!titleOverride) {
    try {
      const wl = readLatestWorklog();
      if (wl?.content) {
        const firstLine = wl.content.split('\n')[0] || '';
        const raw = firstLine.replace(/^#\s*Work Log:\s*"?/, '').replace(/"?\s*$/, '').trim();
        if (raw) {
          const words = raw.split(/\s+/);
          title = words.slice(0, 2).join(' ') + (words.length > 2 ? '…' : '');
        }
      }
    } catch { /* fallback to PABCD */ }
  }

  broadcast('orc_state', {
    state: s,
    title,
    scope,
    taskAnchor: ctx?.taskAnchor || null,
    resolvedSelection: ctx?.resolvedSelection || null,
    interview: ctx?.interview || null,
    seedSpec: ctx?.seedSpec || null,
    buildBudget: ctx?.buildBudget || null,
  });
}

export function resetState(scope = 'default'): void {
  resetOrcState.run(scope);
  broadcast('orc_state', { state: 'IDLE', title: '', scope });
}

export function resetAllStaleStates(): number {
  // Only resets states older than 24 hours — preserves active PABCD sessions
  const result = resetAllOrcStates.run();
  const cleared = result.changes;
  if (cleared > 0) {
    console.log(`[jaw:pabcd] cleared ${cleared} stale orchestration state(s) (>24h old)`);
    broadcast('orc_state', { state: 'IDLE', title: '', scope: 'all' });
  }
  const pruned = deleteNonDefaultOrcStates.run();
  if (pruned.changes > 0) {
    console.log(`[jaw:pabcd] pruned ${pruned.changes} non-default scope row(s)`);
  }
  return cleared;
}

// ─── Prefix Map ─────────────────────────────────────
// B state: only worker results get Bb2 prefix, user messages get no prefix.

const PREFIXES: Record<string, string> = {
  Ip: `[INTERVIEW MODE — User Response]
The user has answered. Before asking more questions:

1. **Classify the answer**: What did the user confirm? What's still vague? Any hedging language ("아마", "maybe", "~일 수도")?
2. **Check dimensions**: Which of the 4 dimensions (goal/constraint/success/ontology) improved? Which is weakest?
3. **Research if possible**: Can you verify anything in code before asking? Do it.
4. **Steer toward the weakest dimension** — don't keep asking about what's already clear.

Update the <interview_tracker> at the END of your response (hidden from user).
⛔ Do NOT print known/unknown arrays in your visible text. No raw JSON in the response body.

If all dimensions are covered and no blocking unknowns remain, suggest:
"Ready for planning. Run \`cli-jaw orchestrate P\` to proceed."

User says:`,

  Pb2: `[PLANNING MODE — User Feedback]
The user has reviewed your plan. Apply their feedback and present the revised plan.
If user explicitly approves, run \`cli-jaw orchestrate A\` to advance.
Otherwise revise and present again.

⛔ STOP after presenting the revision. WAIT for another user response.

User says:`,

  // Phase 59: A-phase user (non-worker) message — e.g. first entry after P approval.
  // Was previously reusing Ab2 ("Employee Results") which misled the model.
  Ap: `[PLAN AUDIT — User Message]
You are in PLAN AUDIT phase. The approved plan is auto-injected at the top of every
dispatch task body under \`## Approved Plan\` — you do not need to read any file.
Do NOT tell the worker to read a plan file; just write the audit task itself.

⛔ STOP after dispatching and reporting audit results. WAIT for user approval.

User says:`,

  Ab2: `[PLAN AUDIT — Employee Results]
Below are the plan audit results from the verification employee.
If issues found: fix the plan and re-audit (output employee JSON again).
If PASS: report results to the user and wait for approval.
When user approves, run \`cli-jaw orchestrate B\` to advance to Build.

Reporting: distill the verdict and key findings into a concise bullet list (≤5 items).
Use a diagram when the audit covers 3+ files or integration points.
Do NOT paste the full employee output verbatim.

⛔ STOP after reporting. WAIT for user approval.

Employee results:`,

  Bb2: `[IMPLEMENTATION REVIEW — Employee Results]
Below are verification results for your code.
If NEEDS_FIX: fix and re-verify (output employee JSON again).
If DONE: report results to the user and wait for approval.
When user approves, run \`cli-jaw orchestrate C\` to advance to Check.

Reporting: distill the verdict and key findings into a concise bullet list (≤5 items).
Use a diagram when the verification covers 3+ files.
Do NOT paste the full employee output verbatim.

⛔ STOP after reporting. WAIT for user approval.

Employee results:`,
};

export function getPrefix(state: OrcStateName, source: 'user' | 'worker' = 'user', ctx?: OrcContext | null): string | null {
  if (state === 'I') {
    let prefix = PREFIXES["Ip"]!;
    // P3-2: Perspective Rotation based on round + assessment
    const round = ctx?.interview?.round || 1;
    const assessment = ctx?.interview?.assessment;
    if (round <= 2) {
      prefix += '\n[Perspective: RESEARCHER + SIMPLIFIER — gather facts, reduce complexity]';
    } else {
      prefix += '\n[Perspective: ARCHITECT + BREADTH_KEEPER — structural concerns, check blind spots]';
    }
    const closerReady = assessment && Object.values(assessment).every(v => v === 'xhigh' || v === 'max');
    if (closerReady) {
      prefix += '\n[Perspective: SEED_CLOSER — drive toward closure, confirm all assumptions]';
    }
    return prefix;
  }
  if (state === 'P') return PREFIXES["Pb2"]!;
  if (state === 'A') return source === 'worker' ? PREFIXES["Ab2"]! : PREFIXES["Ap"]!;
  if (state === 'B' && source === 'worker') return PREFIXES["Bb2"]!;
  return null;
}

// ─── State Prompts (stdout on transition) ───────────

const STATE_PROMPTS: Record<string, string> = {
  I: `[INTERVIEW — Requirements Clarification]

You are in Interview mode. Your ONLY job is to clarify requirements through structured questioning.

## Approach: Research First, Then Ask

Before asking any question:
1. Read relevant files, grep for patterns, check existing code
2. Use CLI sub-agents for quick lookups if needed
3. Present findings: "조사 결과 현재 이렇고, 이렇게 가려 합니다. 맞습니까?"
4. Then ask focused follow-up questions based on what you found

Do NOT defer research — if something can be checked now, check it now.

## Four Dimensions to Cover

Every interview must explore all four dimensions. Track which are weak and steer questions accordingly:

**Goal** (뭘 만드나): What exactly to build, why it's needed, what NOT to build (scope boundary)
**Constraint** (제약): Tech stack, existing systems, performance needs, timeline
**Success** (성공 기준): Testable completion criteria, "done" definition, edge case expectations
**Ontology** (구조): Core entities, relationships between them, invariants, existing concept overlap

## Questioning Strategy (adapt by round)

**Rounds 1-2** — Gather facts, simplify scope:
- "이건 정확히 뭔가요?" (What is this really?)
- "이게 없으면 어떻게 되나요?" (What happens without it?)
- "지금 뭘 가정하고 있는 건가요?" (What are you assuming?)

**Rounds 3+** — Structural concerns, integration risks:
- "이게 기존 시스템과 어떻게 연결되나요?"
- "이 엔티티들의 관계는?"
- "이건 증상인가요, 원인인가요?"

**When close to ready** — Drive closure, confirm assumptions:
- Flag all source:"assumption" items for explicit confirmation
- Ask: "이 가정들이 맞다면 계획을 시작할 수 있습니다. 맞습니까?"

## Structured Elicitation UI

When a follow-up question has clear choices, you may render it as a short explanation followed by a standalone elicitation fence. Use it for A/B/C decisions, scope/priority/mode choices, or compact requirements clarification. Prefer 1-3 questions; more can parse, but 3 or fewer is the recommended UX.

For simple conditional follow-ups, use visibleWhen with prior question ids and option values, for example visibleWhen: { "scope": ["mvp"] }. Keep this to simple prior-answer branching only; do not use complex expressions or internal tracker fields as conditions.

Keep the JSON complete and small. Do not put raw internal tag strings such as interview tracker XML tags, HTML, or XML-like angle-bracket text inside question, label, or description fields. If the UI may be unavailable, the question is not choice-based, or the payload would be large, fall back to normal text questions.

The visible elicitation UI does not replace the hidden Interview tracker. Continue to append the interview_tracker block at the end of every Interview response exactly as required below.

## Per-turn Routine

1. **Re-assess ambiguity objectively (every round)** — Re-evaluate each dimension from scratch, as a skeptical outsider would. Do NOT just carry forward or inflate prior dimension scores. A dimension resting on assumptions rather than confirmed facts is NOT "high" or above. Downgrade any score you cannot defend with concrete evidence, and never raise a score just to close the interview faster.
2. **Negativity bias (pressure-test every answer)** — Treat every user answer as a claim to challenge. If the answer is vague, hedging ("아마", "maybe", "~일 수도", "몰라", "그냥"), or lacks concrete detail, DOWNGRADE the relevant dimension score. Do NOT accept vague answers at face value. Stay on the same dimension until one layer deeper, one assumption clearer, or one boundary tighter. Do not rotate to a new dimension just for coverage when the current answer is still vague.
3. Analyze previous answers — which dimension improved? Which is still weak?
4. Steer next questions toward the weakest dimension
5. Ask 1–3 questions. For each, suggest 2-3 recommended answer choices
6. Update the tracker (see below)

## Interview Tracker

At the end of every response, include this block (parsed and stripped — the user will NEVER see it):

⛔ IMPORTANT: Do NOT repeat known/unknown arrays in your visible response text.
The tracker block below is machine-parsed and hidden from the user.
Your visible response should contain questions and discussion only — never raw JSON arrays.

<interview_tracker>
assessment: {"goal":"high","constraint":"medium","success":"low","ontology":"low"}
known: [
  {"fact": "confirmed fact", "source": "user_statement", "confidence": 1.0, "turnNumber": 1, "dimension": "goal"}
]
unknown: ["open question"]
</interview_tracker>

Assessment levels (per dimension): low → medium → high → xhigh → max.
"max" means fully confirmed and testable. All dimensions must reach "max" to be Ready.

Each known entry:
- \`fact\`: the confirmed information
- \`source\`: user_statement (1.0), repo_fact (0.9), inference (0.5-0.8), assumption (0.3-0.5), default (0.5)
- \`confidence\`: 0.0-1.0
- \`turnNumber\`: which round
- \`dimension\`: goal, constraint, success, or ontology

Rules:
- Carry forward all prior items cumulatively
- Move resolved unknowns to known with appropriate source
- Mark unverified conclusions as "assumption" — flag for confirmation
- Do NOT invent business decisions

## Ready Criteria

Suggest planning when ALL of these hold:
- **Goal**: "max" — clearly defined with scope boundary
- **Success**: "max" — at least 1 testable completion criterion, fully confirmed
- **All dimensions**: at least "xhigh" or above
- **No blocking unknowns**: no unknown that would make planning impossible
- All "assumption" items either confirmed or explicitly accepted by user

When ready: Summarize known facts (grouped by dimension), remaining unknowns, risky assumptions.
Then suggest: "Ready for planning. Run \`cli-jaw orchestrate P\` to proceed."

The user can exit anytime: \`orchestrate reset\` (→ IDLE) or \`orchestrate P\` (→ Planning).

## Loop / Multi-Pass Tasks

If the user's request contains "loop" / "루프" (or clearly describes work too large for one PABCD cycle), treat it as a MULTI-PASS task:
- Assume PABCD will run several full cycles — one per work-phase.
- An Interview output may be a devlog scaffold: the work-phase decomposition (slice map) and per-phase stub docs using decade numbering (10_phase1, 20_phase2, ...), so the structure is agreed before P.
- A loop may open with a design-only PABCD pass (Phase 0): a code-free whole-system design/documentation cycle that runs before the first implementation work-phase. Note this possibility to the user when the task warrants it.`,

  P: `[PABCD — P: PLANNING]

You are now in Planning mode. Write the complete plan, then report it simply to the user.

Think of this as: a developer reporting a fully-formed plan to the CEO. The plan is already complete internally — your job is to explain it clearly and get approval.

Steps:
1. Read project docs, dev skills, and relevant code. If anything is unclear, return to Interview (\`cli-jaw orchestrate I\`) — do NOT ask questions in P.
2. Write the complete plan internally:
   - Diff-level precision: exact file paths (NEW/MODIFY/DELETE), before/after diffs for MODIFY, complete content for NEW.
   - Save to a devlog plan file using Jawdev decade numbering (see dev-pabcd skill).
   - For a loop / multi-pass task: pre-plan the FULL work-phase slice map up front and scaffold per-phase stub docs (10_phase1, 20_phase2, ...). The first pass MAY be a design-only PABCD pass (Phase 0) whose build output is documentation/architecture, not code.
3. Present to the user in chat:
   - Part 1: Easy, non-developer explanation of what will change and why (≤5 sentences).
   - A Mermaid/SVG diagram showing the file change map.
   - The devlog plan file path.
4. Final confirmation: "혼자 결정하면 안 되는 비즈니스 로직이 있나요?" and "이 방향이 맞습니까?"

⛔ STOP. WAIT for user approval before advancing.
⛔ When approved, run: \`cli-jaw orchestrate A\`

You will receive user feedback with a [PLANNING MODE] prefix. Revise until approved.

IMPORTANT — Project Workspace:
Before writing a plan, confirm the project workspace: "작업할 프로젝트 디렉토리를 확인합니다: <dirs>. 이대로 진행할까요?"
If projectDirs is not set, ask the user to run \`cli-jaw project set /path/to/repo\` before proceeding. Do NOT guess or infer the project path.`,

  A: `[PABCD — A: PLAN AUDIT]

You are now in Plan Audit mode. This phase audits YOUR PLAN — not the code.
An employee must verify that your plan from P phase is feasible and safe before any coding begins.

⚠️ You MUST dispatch an audit employee. Do NOT skip this step.
⚠️ Do NOT say "audit is unnecessary" — every plan must be verified before coding.

FIRST: The approved plan is auto-injected at the top of every \`cli-jaw dispatch\`
task body under \`## Approved Plan\`. Do NOT tell the worker to read any file —
just write the audit task itself.

Run this command now:
\`\`\`bash
cli-jaw dispatch --agent "Backend" --task "Project root: <absolute path to the current working repository from pwd -P>

⛔ READ-ONLY: Do NOT create, modify, or delete ANY files. You are an auditor, not a builder.

The approved plan is already injected above under \`## Approved Plan\` — read it there.

Resolve every repository-relative path against Project root.
Do NOT use ~/.cli-jaw*, JAW_HOME, process.cwd(), or the employee temp cwd as the repository root.

Audit the PLAN (not code). Verify:
1) All imports in the plan resolve to real files.
2) Function signatures match actual code.
3) No copy-paste integration risks.

Report PASS or FAIL with itemized issues. ⛔ REPEAT: Do NOT touch any files."
\`\`\`

The result is returned via stdout. Review it:
- If FAIL: fix the plan and re-dispatch.
- If PASS: report results to the user.

⛔ STOP after reporting. WAIT for user approval.
⛔ When user approves, run: \`cli-jaw orchestrate B\``,

  B: `[PABCD — B: BUILD]

You are now in Build mode. The plan has been audited and approved.

⚠️ By default, YOU (the Boss) implement the code DIRECTLY. Employees are READ-ONLY verifiers.
💡 To delegate writes to a worker, use \`--mutable\` (and optionally \`--scope\`):
   \`cli-jaw dispatch --agent "Frontend" --mutable --scope "src/components" --task "Create button component"\`

⛔ Without --mutable, these are forbidden: "implement the feature", "write the code", "create src/x.ts".
✅ Always allowed: "verify src/x.ts compiles", "check integration of Y reports DONE/NEEDS_FIX".

Steps:
1. Read the approved plan: the orchestrator injects it into Boss prompts and dispatch tasks under \`## Approved Plan\`.
   Before any numeric, path, resource-id, date, limit, or destructive action, compare your intended value against the Approved Plan.
2. Implement ALL changes yourself — create/modify/delete files as specified in the plan.
3. After YOU finish implementing, dispatch a verification employee:

\`\`\`bash
cli-jaw dispatch --agent "Backend" --task "Project root: <absolute path to the current working repository from pwd -P>

⛔ READ-ONLY: Do NOT create, modify, or delete ANY files. You are a verifier, not a builder.

The approved plan is already injected above under \`## Approved Plan\` — read it there.

Resolve every repository-relative path against Project root.
Do NOT use ~/.cli-jaw*, JAW_HOME, process.cwd(), or the employee temp cwd as the repository root.

Verify:
1) Files in plan exist with expected content.
2) No syntax errors (run tsc --noEmit if TS).
3) Imports resolve.
4) No integration conflicts.

Report DONE or NEEDS_FIX. ⛔ Do NOT touch any files — READ and REPORT only."
\`\`\`

Review the stdout result:
- NEEDS_FIX: YOU fix the issues yourself, then re-dispatch verification.
- DONE: Report results to the user.

⛔ STOP after reporting. WAIT for user approval.
⛔ When user approves, run: \`cli-jaw orchestrate C\``,

  C: `[PABCD — C: CHECK + SCRUTINY]

You are now in Check mode. Perform verification in order:

**Stage 1: Mechanical ($0)**
1. Run \`npx tsc --noEmit\` (TypeScript) or equivalent build check.
2. Run tests if they exist.
3. Verify all files saved and consistent.
If Stage 1 fails → report and suggest \`cli-jaw orchestrate B\` (code fix).

**Stage 2: Scrutiny (based on change scope)**

IF 1-2 files changed:
  Quick checklist:
  - Does this change do what was asked?
  - Any obvious regressions?
  - Edge cases handled?

IF 3+ files changed:
  Adversarial review:
  - What does "just" or "simply" hide in this implementation?
  - What happens under concurrent access or race conditions?
  - Are there hardcoded outputs or placeholder logic that passes tests
    but misses the actual intent?
  - What environmental assumptions could break in production?
  - ⚠️ If you cannot identify a concrete risk, silence is valid.
    Do not manufacture issues to fill the checklist.

IF Seed exists:
  For each acceptance criterion in the Seed:
  - Is it implemented? Show evidence (file:line or function).
  - Empty evidence = NOT MET.

**Stage 3: Verdict**
- All passed → RUN \`cli-jaw orchestrate D\` now. Do not merely suggest it or write "C → D"; execute the command before claiming C is complete.
- Code issue → suggest \`cli-jaw orchestrate B\`
- Plan issue (AC not met) → suggest \`cli-jaw orchestrate P\`
- Spec issue (wrong requirements) → suggest \`cli-jaw orchestrate I\``,

  D: `[PABCD — D: DONE + WONDER/REFLECT]

This PABCD cycle is finished. Summarize what was accomplished in this work-phase:
1. Files changed (list)
2. Which acceptance criteria were met (if Seed exists)

Then perform two reflections:

**WONDER** ("What's still missing?"):
- What edge cases were NOT covered by acceptance criteria?
- What assumptions turned out wrong during build?
- Are there integration risks the plan didn't anticipate?
- What could break in production that tests don't catch?

**REFLECT** ("How would we improve the spec?"):
- Which acceptance criteria need sharpening?
- Which constraints were missing?
- What would change if we revised the ontology?

Present findings to user. Then:
- If significant issues: "Seed를 개선하려면: \`cli-jaw orchestrate I\`"
- If a goal is active and the objective still has remaining work-phases: this cycle's D closes the current work-phase; start the next one with \`cli-jaw orchestrate P\` (the legal path is D → IDLE → P). Do not declare the whole goal done yet.
- Otherwise: "완료. D 단계까지 실행했고 오케스트레이션을 마무리했습니다."

Returning to idle after D (next work-phase, if any, re-enters at P).`,
};

export function getStatePrompt(target: string): string {
  return STATE_PROMPTS[target] || '';
}

// ─── Transition Guards ──────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
  IDLE: ['I', 'P'],
  I: ['P', 'IDLE'],
  P: ['I', 'A'],
  A: ['I', 'B'],
  B: ['I', 'C'],
  C: ['I', 'D', 'B', 'P'],   // P2-4: 3-way reject routing
  D: ['I', 'IDLE'],
};

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

export function canTransition(
  from: OrcStateName,
  to: OrcStateName,
  ctx?: OrcContext | null,
): TransitionResult {
  if (!VALID_TRANSITIONS[from]?.includes(to)) {
    return { ok: false, reason: `Invalid transition: ${from} → ${to}. Force cannot skip phases; start from the next valid phase.` };
  }
  // Any state → I: always allowed, context preserved by caller passing undefined ctx.
  if (to === 'I' && from !== 'IDLE') {
    return { ok: true };
  }
  // Phase 2.1: I→P soft gate — warn if no interview context, but don't block.
  if (from === 'I' && to === 'P' && !ctx?.interview) {
    console.warn('[jaw:pabcd] I→P without interview context — proceeding anyway');
  }
  // Phase 58: Gate A→B on audit verdict (strict equality, not truthy).
  if (from === 'A' && to === 'B') {
    if (ctx?.userApproved) return { ok: true };
    if (ctx?.auditStatus !== 'pass') {
      return {
        ok: false,
        reason: `A → B requires audit verdict 'pass' or explicit user approval (current: ${ctx?.auditStatus ?? 'none'}). Run audit worker, use /orchestrate B, or use --force to override this audit gate.`,
      };
    }
  }
  // Phase 58: Gate B→C on verification verdict (strict equality, not truthy).
  if (from === 'B' && to === 'C') {
    if (ctx?.userApproved) return { ok: true };
    if (ctx?.verificationStatus !== 'done') {
      return {
        ok: false,
        reason: `B → C requires verification verdict 'done' or explicit user approval (current: ${ctx?.verificationStatus ?? 'none'}). Run verification worker, use /orchestrate C, or use --force to override this verification gate.`,
      };
    }
  }
  return { ok: true };
}

// ─── Worker Verdict Parser ──────────────────────────
// Phase 58: parses worker stdout for PASS/FAIL/DONE/NEEDS_FIX tokens.
// Input is the worker's text response (string), not the result object.
export type WorkerVerdict = 'pass' | 'fail' | 'done' | 'needs_fix';

export function parseWorkerVerdict(text: string): WorkerVerdict | null {
  if (!text || typeof text !== 'string') return null;
  // NEEDS_FIX must be checked before FAIL because the substring "FIX" can co-occur with "FAIL".
  // Use strict word-boundary matches to avoid catching prose like "passed previously" → 'pass'.
  if (/\bNEEDS_FIX\b/.test(text)) return 'needs_fix';
  if (/\bDONE\b/.test(text)) return 'done';
  if (/\bPASS\b/.test(text)) return 'pass';
  if (/\bFAIL\b/.test(text)) return 'fail';
  return null;
}
