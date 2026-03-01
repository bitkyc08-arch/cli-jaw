// ─── PABCD State Machine ────────────────────────────
// Sole orchestration state manager. Replaces the old round-loop pipeline entirely.
// State persisted in jaw.db orc_state table.
// CLI (bin/commands/orchestrate.ts) and server share the same DB.

import { getOrcState, setOrcState, resetOrcState } from '../core/db.js';
import { broadcast } from '../core/bus.js';

// ─── Types ──────────────────────────────────────────

export type OrcStateName = 'IDLE' | 'P' | 'A' | 'B' | 'C' | 'D';

export interface OrcContext {
  originalPrompt: string;
  plan: string | null;
  workerResults: string[];
  origin: string;
  chatId?: string | number;
}

// ─── State Read/Write (DB-backed) ───────────────────

export function getState(): OrcStateName {
  const row = getOrcState();
  return (row?.state as OrcStateName) || 'IDLE';
}

export function getCtx(): OrcContext | null {
  const row = getOrcState();
  if (!row?.ctx) return null;
  try { return JSON.parse(row.ctx); } catch { return null; }
}

export function setState(s: OrcStateName, ctx?: OrcContext | null): void {
  const ctxJson = ctx !== undefined
    ? (ctx ? JSON.stringify(ctx) : null)
    : getOrcState()?.ctx || null;
  setOrcState.run(s, ctxJson, 'default');
  broadcast('orc_state', { state: s });
}

export function resetState(): void {
  resetOrcState();
  broadcast('orc_state', { state: 'IDLE' });
}

// ─── Prefix Map ─────────────────────────────────────
// B state: only worker results get Bb2 prefix, user messages get no prefix.

const PREFIXES: Record<string, string> = {
  Pb2: `[PLANNING MODE — User Feedback]
The user has reviewed your plan. Apply their feedback and present the revised plan.
If user explicitly approves (OK, next, lgtm, 진행해), advance to Plan Audit phase.
Otherwise revise and present again.

⛔ STOP after presenting the revision. WAIT for another user response.

User says:`,

  Ab2: `[PLAN AUDIT — Worker Results]
Below are the plan audit results. The worker checked YOUR PLAN for feasibility — not the code.
If issues found: fix the plan and re-audit (output worker JSON again).
If PASS: report results to the user.

⛔ STOP after reporting. WAIT for user approval before advancing to Build.

Worker results:`,

  Bb2: `[IMPLEMENTATION REVIEW — Worker Results]
Below are verification results for your code.
If NEEDS_FIX: fix and re-verify (output worker JSON again).
If DONE: report results to the user.

⛔ STOP after reporting. WAIT for user approval before advancing to Check.

Worker results:`,
};

export function getPrefix(state: OrcStateName, source: 'user' | 'worker' = 'user'): string | null {
  if (state === 'P') return PREFIXES.Pb2!;
  if (state === 'A') return PREFIXES.Ab2!;
  if (state === 'B' && source === 'worker') return PREFIXES.Bb2!;
  return null;
}

// ─── State Prompts (stdout on transition) ───────────

const STATE_PROMPTS: Record<string, string> = {
  P: `[PABCD — P: PLANNING]

You are now in Planning mode. Your ONLY job right now is to write a plan.

Steps:
1. Read the project's structural documentation and dev skill docs.
2. Write a plan with TWO parts:
   - Part 1: Easy explanation of what will be built (non-developer friendly).
   - Part 2: Diff-level precision — exact file paths (NEW/MODIFY/DELETE),
     before/after diffs for MODIFY, complete content for NEW.
3. Present the plan to the user.
4. Ask: "Any business logic I shouldn't decide alone?" and "Does Part 1 match your intent?"

⛔ STOP HERE. Do NOT proceed to the next phase.
⛔ Do NOT call cli-jaw orchestrate A yet.
⛔ WAIT for the user to review and approve your plan.
⛔ Only after explicit user approval (OK, lgtm, 진행, etc.) should you advance.

You will receive user feedback with a [PLANNING MODE] prefix. Revise until approved.`,

  A: `[PABCD — A: PLAN AUDIT]

You are now in Plan Audit mode. This phase audits YOUR PLAN — not the code.
A worker must verify that your plan from P phase is feasible and safe before any coding begins.

⚠️ You MUST output a worker JSON to audit the plan. Do NOT skip this step.
⚠️ Do NOT say "audit is unnecessary" — every plan must be verified before coding.
⚠️ The worker checks: import paths exist, function signatures match real code, no integration risks.

Output this worker JSON now:
\`\`\`json
{"subtasks":[{"agent":"Data","task":"⛔ READ-ONLY: Do NOT create, modify, or delete ANY files. You are an auditor, not a builder. Audit the PLAN (not code). Verify: 1) All imports in the plan resolve to real files. 2) Function signatures match actual code. 3) No copy-paste integration risks. Report PASS or FAIL with itemized issues. ⛔ REPEAT: Do NOT touch any files.","priority":1}]}
\`\`\`

The system spawns the worker automatically. Wait for results.
After receiving worker results:
- If FAIL: fix the plan and re-audit (output worker JSON again).
- If PASS: report results to the user.

⛔ STOP after reporting. WAIT for user approval before advancing to B.`,

  B: `[PABCD — B: BUILD]

You are now in Build mode. The plan has been audited. Implement it now.

Rules:
- Follow dev skill conventions strictly.
- No TODOs or placeholders — every file must be complete.
- All imports must resolve.

After implementation, output a worker JSON to verify your code:
\`\`\`json
{"subtasks":[{"agent":"Data","task":"⛔ READ-ONLY: Do NOT create, modify, or delete ANY files. You are a verifier, not a builder. Verify the implemented code: 1) Integrates cleanly with existing modules. 2) No runtime issues. 3) All exports used correctly. Report DONE or NEEDS_FIX with details. ⛔ REPEAT: Do NOT touch any files.","priority":1}]}
\`\`\`

Wait for worker results. Fix any NEEDS_FIX items.
Once DONE, report results to the user.

⛔ STOP after reporting. WAIT for user approval before advancing to C.`,

  C: `[PABCD — C: CHECK]

You are now in Check mode. Perform final verification:
1. Verify all files saved and consistent.
2. Run \`npx tsc --noEmit\` for build verification (if TypeScript project).
3. Update project structure documentation if applicable.
4. Report completion summary to the user.

Once verified, call \`cli-jaw orchestrate D\` to finalize.
If shell command unavailable, report completion and ask user to finalize.`,

  D: `[PABCD — D: DONE]
All phases finished. Returning to idle.
Summarize what was accomplished:
- What was planned (P), audited (A), implemented (B), verified (C).
- List of files changed.
- Any follow-up items.`,
};

export function getStatePrompt(target: string): string {
  return STATE_PROMPTS[target] || '';
}

// ─── Transition Guards ──────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
  IDLE: ['P'],
  P: ['A'],
  A: ['B'],
  B: ['C'],
  C: ['D'],
  D: ['IDLE'],
};

export function canTransition(from: OrcStateName, to: OrcStateName): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
