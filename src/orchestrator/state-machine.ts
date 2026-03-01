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
If user approves (OK, next, lgtm), call \`cli-jaw orchestrate A\`.
Otherwise revise and present again.

User says:`,

  Ab2: `[PLAN AUDIT — Worker Results]
Below are audit results from the verification worker.
If issues found: fix plan and re-audit. If PASS: report to user and wait for approval.
Once approved, call \`cli-jaw orchestrate B\`.

Worker results:`,

  Bb2: `[IMPLEMENTATION REVIEW — Worker Results]
Below are verification results for your code.
If NEEDS_FIX: fix and re-verify. If DONE: report to user.
Once approved, call \`cli-jaw orchestrate C\`.

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
  P: `[PABCD ACTIVATED — PLANNING MODE]

Read the project's structural documentation and dev skill docs first.
Write a plan in devlog/_plan/ with two parts:

Part 1: Easy explanation of what will be built (non-developer friendly).
Part 2: Diff-level precision — exact file paths (NEW/MODIFY/DELETE),
before/after diffs for MODIFY, complete content for NEW.

After writing the plan, ask the user:
1. "Any business logic I shouldn't decide on my own?"
2. "Please confirm Part 1 matches your intent."

Refine until user approves.
Preferred: call \`cli-jaw orchestrate A\`.
Fallback: if shell command is unavailable, wait for explicit user approval and the system may auto-advance to A.`,

  A: `[PLAN AUDIT MODE]

Your plan is approved. Now verify it before coding.
Output a worker JSON to audit the diff-level plan:
\`\`\`json
{"subtasks":[{"agent":"Data","task":"Audit the plan at devlog/_plan/. Verify: 1) All imports resolve to real files. 2) Function signatures match actual code. 3) No copy-paste integration risks. Report PASS or FAIL with itemized issues.","priority":1}]}
\`\`\`
The system spawns the worker and returns results automatically.`,

  B: `[IMPLEMENTATION MODE]

The plan has been audited and verified. Now implement it.
Rules: follow dev skill conventions, no TODOs, all imports must resolve.

After implementation, output a worker JSON to verify:
\`\`\`json
{"subtasks":[{"agent":"Data","task":"Verify the implemented code: 1) Integrates cleanly with existing modules. 2) No runtime issues. 3) All exports used correctly. Report DONE or NEEDS_FIX.","priority":1}]}
\`\`\``,

  C: `[FINAL CHECK]

Perform final audit:
1. Update str_func reflecting all changes.
2. Verify all files saved and consistent.
3. Run \`npx tsc --noEmit\` for build verification.
4. Report completion summary.

When done, call \`cli-jaw orchestrate D\`.
If shell command is unavailable, clearly report completion and ask the user to finalize.`,

  D: `[PABCD COMPLETE]
All phases finished. Returning to idle.
Summarize: what was planned, audited, implemented, verified. List changed files.`,
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
