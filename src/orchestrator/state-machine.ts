// ─── PABCD State Machine ────────────────────────────
// Sole orchestration state manager. Replaces the old round-loop pipeline entirely.
// State persisted in jaw.db orc_state table.
// CLI (bin/commands/orchestrate.ts) and server share the same DB.

import { getOrcState, setOrcState, resetOrcState, resetAllOrcStates, deleteNonDefaultOrcStates } from '../core/db.js';
import { broadcast } from '../core/bus.js';
import { readLatestWorklog } from '../memory/worklog.js';
import type { RemoteTarget } from '../messaging/types.js';
import type { ResolvedSelection } from './parser.js';

// ─── Types ──────────────────────────────────────────

export type OrcStateName = 'IDLE' | 'P' | 'A' | 'B' | 'C' | 'D';

export type AuditVerdict = 'pending' | 'pass' | 'fail';
export type VerificationVerdict = 'pending' | 'done' | 'needs_fix';

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
  });
}

export function resetState(scope = 'default'): void {
  resetOrcState.run(scope);
  broadcast('orc_state', { state: 'IDLE', title: '', scope });
}

export function resetAllStaleStates(): number {
  const result = resetAllOrcStates.run();
  const cleared = result.changes;
  if (cleared > 0) {
    console.log(`[jaw:pabcd] cleared ${cleared} stale orchestration state(s)`);
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

⛔ STOP after reporting. WAIT for user approval.

Employee results:`,

  Bb2: `[IMPLEMENTATION REVIEW — Employee Results]
Below are verification results for your code.
If NEEDS_FIX: fix and re-verify (output employee JSON again).
If DONE: report results to the user and wait for approval.
When user approves, run \`cli-jaw orchestrate C\` to advance to Check.

⛔ STOP after reporting. WAIT for user approval.

Employee results:`,
};

export function getPrefix(state: OrcStateName, source: 'user' | 'worker' = 'user'): string | null {
  if (state === 'P') return PREFIXES.Pb2!;
  // Phase 59: distinguish first-entry user message (Ap) from worker verdict (Ab2).
  if (state === 'A') return source === 'worker' ? PREFIXES.Ab2! : PREFIXES.Ap!;
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
⛔ WAIT for the user to review and approve your plan.
⛔ When user approves, run: \`cli-jaw orchestrate A\`

You will receive user feedback with a [PLANNING MODE] prefix. Revise until approved.`,

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
cli-jaw dispatch --agent "Backend" --task "⛔ READ-ONLY: Do NOT create, modify, or delete ANY files. You are an auditor, not a builder.

The approved plan is already injected above under \`## Approved Plan\` — read it there.

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

⚠️ YOU (the Boss) must implement the code DIRECTLY. Write every file yourself.
⚠️ Do NOT delegate implementation to an employee. Employees are READ-ONLY verifiers.

⛔ Forbidden dispatch examples: "implement the feature", "write the code", "create src/x.ts".
✅ Allowed dispatch examples: "verify src/x.ts compiles", "check integration of Y reports DONE/NEEDS_FIX".

Steps:
1. Read the approved plan: the orchestrator injects it into Boss prompts and dispatch tasks under \`## Approved Plan\`.
   Before any numeric, path, resource-id, date, limit, or destructive action, compare your intended value against the Approved Plan.
2. Implement ALL changes yourself — create/modify/delete files as specified in the plan.
3. After YOU finish implementing, dispatch a verification employee:

\`\`\`bash
cli-jaw dispatch --agent "Backend" --task "⛔ READ-ONLY: Do NOT create, modify, or delete ANY files. You are a verifier, not a builder.

The approved plan is already injected above under \`## Approved Plan\` — read it there.

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
