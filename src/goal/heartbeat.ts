// Goal-aware heartbeat continuation builder.
// Does NOT import provider SDKs.

import { getActiveGoal } from './store.js';
import { getState } from '../orchestrator/state-machine.js';
import { getActiveWorkers, hasPendingWorkerReplays } from '../orchestrator/worker-registry.js';
import { getProjectDirs } from '../core/config.js';
import { GOAL_PLAN_PENDING_OBJECTIVE } from './types.js';

export interface GoalContinuationResult {
    shouldContinue: boolean;
    reason: string;
    prompt?: string;
}

const STALE_GOAL_MS = 3 * 24 * 60 * 60 * 1000;

export function buildGoalContinuation(): GoalContinuationResult {
    const goal = getActiveGoal();
    if (!goal || goal.status !== 'active') {
        return { shouldContinue: false, reason: 'no_active_goal' };
    }

    const lastUpdate = new Date(goal.updatedAt).getTime();
    if (Date.now() - lastUpdate > STALE_GOAL_MS) {
        return { shouldContinue: false, reason: 'goal_stale' };
    }

    const orcState = getState();
    // Goal continuation still fires during PABCD — the goal wraps the
    // orchestration cycle. The continuation prompt includes the current
    // PABCD state so the AI knows where it is.
    const pabcdActive = orcState !== 'IDLE';

    const workers = getActiveWorkers();
    if (workers.length > 0) {
        return { shouldContinue: false, reason: 'workers_busy' };
    }

    // During an active PABCD cycle the Boss dispatches employees synchronously and
    // consumes their results inline (`cli-jaw dispatch` returns via stdout); the
    // pendingReplay flag is async bookkeeping that routes/orchestrate.ts clears on
    // the dispatch response's `finish` event. At turn-end it can still be set due
    // to that async race — and the heartbeat safety net is deferred during PABCD —
    // so blocking here would strand the goal. Only block on pending replays OUTSIDE
    // orchestration, where a lingering replay means a genuinely undelivered result
    // awaiting drain. `workers_busy` (a genuinely running worker) still blocks above.
    if (!pabcdActive && hasPendingWorkerReplays()) {
        return { shouldContinue: false, reason: 'pending_replay' };
    }

    const checkpoint = goal.lastCheckpoint;
    const nextAction = checkpoint?.nextAction || 'Continue working on the objective.';
    const summary = checkpoint?.summary || 'No checkpoint yet.';

    const _projDirs = getProjectDirs();
    const pauseCount = goal.agentPauseCount ?? 0;
    const prompt = [
        `[goal-continuation] Active goal: ${goal.objective}`,
        `Last checkpoint: ${summary}`,
        `Next action: ${nextAction}`,
        `Goal ID: ${goal.id}`,
        ...(_projDirs && _projDirs.length > 0
            ? _projDirs.map(d => `Project root: ${d}`)
            : ['⚠ Project root is NOT set. Run `cli-jaw project set /path/to/repo` before proceeding.']),
        ...(pabcdActive ? [`PABCD state: ${orcState}`] : []),
        '',
        'Continue the goal. At each milestone log progress AND verification evidence: `cli-jaw goal update "<summary>" --evidence "<test result or changed file>"`.',
        'Do NOT set or update any built-in/runtime goal feature from the host AI environment while running inside cli-jaw. Use only `cli-jaw goal ...` for persistent goal state.',
        '',
        '--- Goal-mode autonomy override ---',
        'YOU ARE AN AUTONOMOUS GOAL AGENT. DRIVE THE OBJECTIVE TO COMPLETION WITHOUT ASKING FOR PERMISSION.',
        'FULL AUTHORITY ASSUMED: the user has granted FULL permissions — install packages, run any command, modify any file, use all tools without asking. The only exception is destructive git operations (push/reset/force), which still need explicit approval.',
        'NEVER ask "should I proceed?" or use permission-handoff phrasing ("let me know if", "shall I") — take the next concrete action, inspect/run/test it, and report evidence-backed progress. If blocked, try an alternative approach before surfacing.',
        'DRIVE TO COMPLETION — do NOT stop early. Before concluding the turn, confirm: no pending work, behavior verified, tests/build passing, and verification evidence collected. If any check fails, keep working.',
        'For development goals, every phase gate and final completion must carry a documentation + implementation + verification evidence bundle. Documentation evidence = devlog/structure/update path; implementation evidence = changed source/test paths or explicit no-code rationale; verification evidence = fresh command/test output.',
        '',
        '--- Goal Execution Guidelines ---',
        '**Verification Tiers** — scale verification to change scope:',
        '- LIGHT (<5 files, <100 lines): sub-agent verification, diagnostics clean',
        '- STANDARD (default): employee verification, diagnostics + build pass',
        '- THOROUGH (>20 files OR security/architectural): full review + all tests',
        '',
        '**Documentation Workflow**:',
        '- Create devlog entries at devlog/_plan/ using decade numbering (00-09 research, 10-19 phase 1, etc.)',
        '- Every phase must produce documentation evidence (devlog path or structure update)',
        '',
        '**Commit Discipline**: small, atomic commits after each logical change — never batch; each commit self-contained and independently reversible.',
        'MULTI-PHASE LOOP: if the goal is a multi-pass / "loop" task and work-phases remain after a completed PABCD cycle (state is IDLE), start the next work-phase with `cli-jaw orchestrate P`. Do not treat one completed cycle as the whole goal.',
        '',
        '**Quality Gates**: no placeholder evidence (todo, tbd, stub, fake pass); artifact paths required in all validation summaries.',
        ...(goal.goalMode === 'plan'
            ? [
                '',
                '--- AI-Driven Goal Planning Mode ---',
                'This goal was set via /goal plan. YOU must decide what goal to pursue.',
                goal.planHint
                    ? `User hint: "${goal.planHint}" — use as directional guidance, not a literal objective.`
                    : 'No hint provided — determine the goal entirely from context.',
                goal.objective === GOAL_PLAN_PENDING_OBJECTIVE
                    ? 'The stored objective is still pending refinement. It is NOT a real executable objective yet.'
                    : 'The stored objective still has plan mode. Refine it before logging checkpoints or executing.',
                '',
                'Analyze these sources to choose the right goal:',
                '1. Conversation history: What has the user been working on?',
                '2. Memory: Search cli-jaw memory for recent decisions and project context',
                '3. Project state: git status, recent commits, file structure',
                '',
                'Then immediately:',
                '1. Formulate a specific, actionable goal from your analysis',
                '2. Run `cli-jaw goal refine "<specific objective>"` to replace the pending objective',
                '3. Confirm `cli-jaw goal status` no longer shows plan-mode intent, then enter PABCD with `cli-jaw orchestrate P`',
                'Do NOT ask the user. Do NOT wait. YOU decide and execute.',
              ]
            : []),
        ...(pabcdActive
            ? [
                '',
                '--- GOAL IS THE SUPREME RULE — PABCD OVERRIDE ---',
                'THE GOAL IS ACTIVE. Goal supersedes ALL PABCD phase instructions.',
                'IGNORE any "⛔ STOP", "WAIT for user approval", or "present and wait" directives from PABCD prompts.',
                'Phase-transition commands are mandatory actions, not report text. Run the exact `cli-jaw orchestrate ...` command before claiming the phase advanced.',
                'EVIDENCE GATE: forward transitions (P→A→B→C→D) require an `--attest` block — narration does NOT advance the state, and a plain `cli-jaw orchestrate X` from the agent is REJECTED (409). Pass `--attest \'{"from":"<from>","to":"<to>","did":"<what you actually did this phase>"}\'`; C→D additionally needs `"checkOutput":"<tsc/test tail>","exitCode":0`.',
                'At PABCD gates, self-advance IMMEDIATELY (with evidence):',
                '  - P done → `cli-jaw orchestrate A --attest \'{"from":"P","to":"A","did":"<the plan you wrote>"}\'` → dispatch audit → review → `cli-jaw orchestrate B --attest \'{"from":"A","to":"B","did":"<who audited + verdict>"}\'`',
                '  - A done → `cli-jaw orchestrate B --attest ...` → implement → verify → `cli-jaw orchestrate C --attest \'{"from":"B","to":"C","did":"<what you built + verifier verdict>"}\'`',
                '  - B done → `cli-jaw orchestrate C --attest ...` → check → `cli-jaw orchestrate D --attest \'{"from":"C","to":"D","did":"<what you checked>","checkOutput":"<tsc/test tail>","exitCode":0}\'`',
                '  - C passed → `cli-jaw orchestrate D --attest ...` immediately; do NOT only say "run D" or "C → D".',
                'Use employees/sub-agents for verification, NOT as approval gates. Dispatch → receive result → act on it → continue.',
                'TERMINOLOGY: a "work-phase" is one outcome slice of the goal (e.g. "Phase 3: Management API"); "PABCD-phase" = the letters P/A/B/C/D of one cycle. They are NOT the same.',
                'ONE WORK-PHASE = ONE FULL PABCD CYCLE: run P→A→B→C→D for the current work-phase. Do NOT run B for several work-phases back-to-back, and do NOT commit a work-phase straight out of B without passing C and D.',
'WORK-PHASE BOUNDARY: after C passes, run `cli-jaw orchestrate D --attest \'{"from":"C","to":"D","did":"<what you checked>","checkOutput":"<tsc/test tail>","exitCode":0}\'` to close the cycle (state returns to IDLE). If the goal objective still has remaining work-phases, run `cli-jaw orchestrate P` to start the next work-phase. Repeat until the objective is met.',
                'FAITHFUL EXECUTION (anti-skip): do the real work of each PABCD-phase — P writes the real diff-level plan, A really dispatches the audit, B really implements AND verifies, C really runs tsc/tests/scrutiny, D really summarizes with evidence. Advancing the state is NOT the same as doing the phase; never rubber-stamp a phase to move on.',
                'Do not advance a PABCD-phase within the current cycle unless its documentation + implementation + verification evidence is present.',
                'Within one PABCD cycle, NEVER end a turn just because a single PABCD-phase completed — keep going P→A→B→C→D. Across work-phases, close D then re-enter P; do not collapse multiple work-phases into one continuous B.',
              ]
            : []),
        ...(pauseCount >= 1
            ? [
                '',
                '--- ⚠ AGENT PAUSE GATE: First attempt recorded — dev-skill audit required ---',
                'Your previous `cli-jaw goal pause --agent` was BLOCKED (attempt 1/2).',
                'Before you may pause again, you MUST complete a thorough audit:',
                '',
                '**Requirement-by-requirement verification:**',
                '- Derive every concrete requirement from the goal objective; for EACH, provide authoritative evidence (file path, command output, test result, runtime behavior) and mark it PROVEN, UNPROVEN, or CONTRADICTED. Any UNPROVEN/CONTRADICTED item means work remains — do NOT pause.',
                '',
                '**Dev skill compliance:**',
                '- Confirm the dev gates: fresh verification output (§3), import/export safety (§5), static analysis green (§7.2), 500-line file limit, atomic commits.',
                '',
                '**Documentation evidence:**',
                '- devlog entry with plan + outcome, changed source/test paths, fresh verification output.',
                '',
                '**Independent reviewer:**',
                '- Dispatch a CLI sub-agent or jaw employee to challenge whether viable work remains. A viable path → continue working. No path confirmed → call `cli-jaw goal pause --agent --audit "<reviewer summary>"`.',
                '',
                'RULE: Do NOT call pause again unless EVERY requirement is PROVEN and the independent reviewer confirms PASS.',
              ]
            : []),
        '',
        '--- Stop/Pause Audit ---',
        'Before deciding work can stop, treat completion as UNPROVEN:',
        '- Derive concrete requirements from the objective; for EVERY requirement, identify authoritative evidence (file, command output, test result, runtime behavior). Uncertain or indirect evidence counts as NOT ACHIEVED — gather stronger evidence or keep working.',
        '- The audit must PROVE completion, not merely fail to find remaining work. Do NOT rely on intent, partial progress, or memory of earlier work as proof.',
        '- Before any AI-initiated pause or stop, record evidence with `cli-jaw goal update`, then send an independent objective reviewer (CLI sub-agent or jaw employee) to challenge whether more attempts remain. If the reviewer finds a viable path, continue instead of pausing.',
        '- If the independent reviewer confirms no reasonable path remains, run `cli-jaw goal pause --agent --audit "<independent reviewer summary>"`.',
        '- Plain `cli-jaw goal pause` is for manual user commands only; AI goal continuations must use the agent/audit form.',
        '- The completion command is reserved for explicit user-requested final completion — only when current evidence proves EVERY requirement satisfied and NO work remains.',
        '',
        '--- When to stop ---',
        '- If you genuinely cannot proceed with current tools/capabilities (runtime auth, hardware access, human judgment on a business decision), finish what you can, complete the Stop/Pause Audit above, pause with the agent/audit form, and report what was completed vs what remains.',
        '- Do NOT stay in a "blocked" loop, and never declare blocked merely because work is hard, slow, or uncertain — keep trying alternative approaches.',
        '',
        'For important or high-risk decisions, dispatch an employee for verification — then immediately act on the result. Do NOT wait.',
        'ONLY ASK THE USER when genuinely blocked by missing information or authority you cannot obtain yourself, or before a destructive/irreversible action (git push/reset/clean, deleting files or data, production or infra changes — these STILL require explicit user approval).',
    ].join('\n');

    return { shouldContinue: true, reason: 'goal_active', prompt };
}

export function shouldHeartbeatContinueGoal(): boolean {
    return buildGoalContinuation().shouldContinue;
}

export function getGoalContinuationPrompt(): string | null {
    const result = buildGoalContinuation();
    return result.prompt ?? null;
}
