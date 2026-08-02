import { buildPlanCompatArtifact, formatPlanCompatText } from '../workflows/plan.js';
import { buildDeliberateArtifact, formatDeliberateText } from '../workflows/deliberate.js';
import { buildPlanAuditArtifact, formatPlanAuditText } from '../workflows/planaudit.js';
import { parseReviewFlags, parseReviewFocus, buildReviewArtifact, buildReviewSteerPrompt, buildReviewTargetContext, formatReviewText } from '../workflows/review.js';
import type { CliCommandContext } from './command-context.js';
import type { SlashResult } from './types.js';
import { clearGoalTimers } from '../agent/lifecycle-handler.js';
import { GOAL_PLAN_PENDING_OBJECTIVE, type GoalState } from '../goal/types.js';
import { describeGoalPauseGate } from '../goal/pause-gate.js';

function joinArgs(args: string[]): string {
    return args.join(' ').trim();
}

function info(text: string): SlashResult {
    return { ok: true, type: 'info', text };
}

function blocked(text: string, code = 'workflow_not_ready'): SlashResult {
    return { ok: false, type: 'error', code, text };
}

async function fireSteerForWebCli(
    ctx: CliCommandContext,
    result: SlashResult,
): Promise<SlashResult> {
    if (!result.steerPrompt) return result;
    const iface = ctx.interface || 'web';
    if (iface === 'telegram' || iface === 'discord' || iface === 'slack') return result;
    const { submitMessage } = await import('../orchestrator/gateway.js');
    submitMessage(result.steerPrompt, { origin: iface as 'cli' | 'web' });
    const { steerPrompt: _stripped, ...rest } = result;
    return rest;
}

async function resolveSettings(ctx: CliCommandContext): Promise<Record<string, unknown>> {
    if (typeof ctx.getSettings !== 'function') return {};
    const s = await Promise.resolve(ctx.getSettings());
    return s && typeof s === 'object' ? s as Record<string, unknown> : {};
}

function archivedGoalLine(previous: GoalState | null): string {
    if (!previous || (previous.status !== 'active' && previous.status !== 'paused')) return '';
    return `\nPrevious goal archived: ${previous.objective}`;
}

function pauseGateStatusLines(goal: GoalState | null): string[] {
    const pauseGate = describeGoalPauseGate(goal);
    if (!pauseGate.armed) return [];
    return [
        `Pause gate: pending (${pauseGate.attempts}/${pauseGate.requiredAttempts})`,
        `Pause gate action: ${pauseGate.nextAction}`,
    ];
}

export async function interviewWorkflowHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const request = joinArgs(args) || '<rough request>';
    const { getState, setState, canTransition } = await import('../orchestrator/state-machine.js');
    const { resolveOrcScope } = await import('../orchestrator/scope.js');
    const settings = await resolveSettings(ctx);
    const origin = ctx?.interface || 'web';
    const scope = resolveOrcScope({ origin, workingDir: (settings as Record<string, unknown>)['workingDir'] as string | null || null });
    const current = getState(scope);
    const gate = canTransition(current, 'I');
    if (!gate.ok) {
        return blocked(`Cannot enter Interview: ${gate.reason}\nCurrent state: ${current}`);
    }
    setState('I', { originalPrompt: request, workingDir: (settings as Record<string, unknown>)['workingDir'] as string | null || null, plan: null, workerResults: [], origin }, scope, 'Interview');
    return fireSteerForWebCli(ctx, {
        ok: true,
        type: 'info',
        text: `Interview started: ${request}`,
        steerPrompt: `You are now in Interview mode for: "${request}". Start by identifying what is known vs unknown, then ask your first clarifying question.`,
    });
}

export async function planWorkflowHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const locale = ctx.locale || 'ko';
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'status') {
        const { getState, getCtx } = await import('../orchestrator/state-machine.js');
        const { resolveOrcScope } = await import('../orchestrator/scope.js');
        const settings = await resolveSettings(ctx);
        const scope = resolveOrcScope({ origin: ctx?.interface || 'web', workingDir: (settings as Record<string, unknown>)['workingDir'] as string | null || null });
        const state = getState(scope);
        const orcCtx = getCtx(scope);
        const hasPlan = !!(orcCtx?.plan);
        return info(`PABCD state: ${state}\nApproved plan: ${hasPlan ? 'yes' : 'none'}`);
    }

    if (sub === 'copy') {
        const { getCtx } = await import('../orchestrator/state-machine.js');
        const { resolveOrcScope } = await import('../orchestrator/scope.js');
        const settings = await resolveSettings(ctx);
        const scope = resolveOrcScope({ origin: ctx?.interface || 'web', workingDir: (settings as Record<string, unknown>)['workingDir'] as string | null || null });
        const orcCtx = getCtx(scope);
        if (orcCtx?.plan) {
            return info(orcCtx.plan);
        }
        return info('No approved plan exists. Enter PABCD P first with `/orchestrate P`.');
    }

    const settings = await resolveSettings(ctx);
    const artifact = buildPlanCompatArtifact(args, locale, settings);
    return {
        ok: true,
        type: 'info',
        text: formatPlanCompatText(artifact, locale),
        artifact,
        originalText: artifact.sourcePrompt,
    };
}

export async function deliberateWorkflowHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const locale = ctx.locale || 'ko';
    const settings = await resolveSettings(ctx);
    const artifact = buildDeliberateArtifact(args, locale, settings);
    const request = joinArgs(args) || '<plan or request>';
    return fireSteerForWebCli(ctx, {
        ok: true,
        type: 'info',
        text: formatDeliberateText(artifact, locale),
        artifact,
        originalText: artifact.sourcePrompt,
        steerPrompt: `Deliberate on: "${request}". List 2-4 viable options, then give Planner/Architect/Critic analysis. End with one recommendation and pre-code verification checklist.`,
    });
}

export async function planAuditWorkflowHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const locale = ctx.locale || 'ko';
    const settings = await resolveSettings(ctx);
    const artifact = buildPlanAuditArtifact(args, locale, settings);
    return fireSteerForWebCli(ctx, {
        ok: true,
        type: 'info',
        text: formatPlanAuditText(artifact, locale),
        artifact,
        originalText: artifact.sourcePrompt,
        steerPrompt: `Audit this plan read-only. Check file paths, imports, signatures against real code. Verdict: PASS or FAIL.`,
    });
}

function buildGoalPlanSteerPrompt(goal: GoalState): string {
    const hint = goal.planHint?.trim() || '';
    const hintLine = hint
        ? `The user provided a hint: "${hint}". Use it as directional guidance, but you decide the actual goal.`
        : 'No hint was provided. Determine the most appropriate goal from context.';
    return [
        `[System] User invoked /goal plan (ID: ${goal.id}). YOU must decide what goal to pursue.`,
        hintLine,
        '',
        'Analyze the following sources to determine the right goal:',
        '1. **Conversation history**: What has the user been working on or discussing?',
        '2. **Memory**: Search cli-jaw memory for recent decisions, preferences, and project context',
        '3. **Project state**: Check git status, recent commits, file structure, and open issues',
        '',
        'Based on your analysis, formulate a specific, actionable, long-term goal.',
        'Then immediately:',
        '1. Set the goal objective via `cli-jaw goal refine "<specific objective>"` (or `/api/goal` action `refine-objective`) with the goal you chose',
        '2. Enter PABCD orchestration with `cli-jaw orchestrate P`',
        '3. Execute the full goal autonomously',
        '',
        'Do NOT ask the user what goal to set. Do NOT wait for confirmation. YOU decide and execute.',
        'Read the goal skill for detailed guidelines on verification, documentation, and commit discipline.',
    ].join('\n');
}

export async function goalWorkflowHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const { getActiveGoal, getGoalHistory, setGoal, updateGoal, refineObjective, completeGoal, cancelGoal, pauseGoal, resumeGoal, clearGoal, resetGoalStore, goalHasCompletionEvidence } = await import('../goal/store.js');
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'run') {
        const runSub = (args[1] || '').toLowerCase();
        const { preflight: runPreflight, startRun, stopRun, getActiveRun } = await import('../goal-run/controller.js');

        if (runSub === 'preflight' || runSub === '' || !runSub) {
            const state = runPreflight();
            const lines = state.gates.map(g => `${g.passed ? 'PASS' : 'FAIL'} ${g.gate}${g.reason ? ` — ${g.reason}` : ''}`);
            const { allGatesPassed } = await import('../goal-run/policy.js');
            const ready = allGatesPassed(state.gates);
            return info(`Preflight: ${ready ? 'READY' : 'NOT READY'}\n${lines.join('\n')}`);
        }
        if (runSub === 'start') {
            const state = startRun();
            if (state.status === 'failed') {
                return blocked(`Preflight failed: ${state.lastError}\nRun \`/goal run preflight\` to see details.`);
            }
            return info(`[Preview] Goal run tracking started in ${state.mode} mode.\nGoal: ${getActiveGoal()?.objective ?? '(unknown)'}\nNote: budget enforcement is tracking-only in this release.\nUse \`/goal run stop\` to stop.`);
        }
        if (runSub === 'stop' || runSub === 'cancel') {
            const reason = args.slice(2).join(' ').trim() || undefined;
            const result = stopRun(reason);
            if (!result) return info('No active goal run to stop.');
            return info(`Goal run stopped.${result.lastError ? ` Reason: ${result.lastError}` : ''}`);
        }
        if (runSub === 'status') {
            const run = getActiveRun();
            if (!run) return info('No active goal run. Use `/goal run start` to begin.');
            const lines = [
                `Status: ${run.status}`,
                `Mode: ${run.mode}`,
                `Goal: ${run.goalId}`,
                `Budget: ${run.budget.turnsUsed}/${run.budget.maxTurns} turns, ${run.budget.dispatchesUsed}/${run.budget.maxDispatches} dispatches`,
                run.startedAt ? `Started: ${run.startedAt}` : null,
            ].filter(Boolean);
            return info(lines.join('\n'));
        }
        return blocked(`Unknown /goal run subcommand: ${runSub}. Use: preflight, start, stop, status.`);
    }

    if (sub === 'set') {
        const objective = args.slice(1).join(' ').trim();
        if (!objective) return blocked('Usage: /goal <objective>');
        const existing = getActiveGoal();
        clearGoalTimers();
        const settings = await resolveSettings(ctx);
        const wd = (settings as Record<string, unknown>)['workingDir'] as string | undefined;
        const goal = setGoal(objective, {
            ...(wd ? { repoRoot: wd } : {}),
            replace: true,
        });
        return fireSteerForWebCli(ctx, { ok: true, type: 'info', text: `Goal set: ${goal.objective}\nID: ${goal.id}${archivedGoalLine(existing)}`, steerPrompt: `[System] User set a new goal: "${goal.objective}" (ID: ${goal.id}). Acknowledge the goal and help the user achieve it.` });
    }

    if (sub === 'plan' || sub === 'goalplan') {
        const hint = args.slice(sub === 'plan' ? 1 : 0).join(' ').trim();
        const existing = getActiveGoal();
        clearGoalTimers();
        const settings = await resolveSettings(ctx);
        const wd = (settings as Record<string, unknown>)['workingDir'] as string | undefined;
        const goal = setGoal(GOAL_PLAN_PENDING_OBJECTIVE, {
            ...(wd ? { repoRoot: wd } : {}),
            goalMode: 'plan' as const,
            ...(hint ? { planHint: hint } : {}),
            replace: true,
        });
        return fireSteerForWebCli(ctx, {
            ok: true,
            type: 'info',
            text: `Goal plan activated${hint ? `: ${hint}` : ''}\nID: ${goal.id}\nMode: AI selects and executes goal${archivedGoalLine(existing)}`,
            steerPrompt: buildGoalPlanSteerPrompt(goal),
        });
    }

    if (sub === 'refine') {
        const objective = args.slice(1).join(' ').trim();
        if (!objective) return blocked('Usage: /goal refine <specific objective>');
        const goal = refineObjective(objective);
        if (!goal) return blocked('No active goal to refine.');
        return info(`Goal refined: ${goal.objective}`);
    }

    if (sub === 'status' || sub === '--json') {
        const goal = getActiveGoal();
        if (!goal) return info('No active goal. Use `/goal set <objective>` to create one.');
        const json = sub === '--json';
        if (json) return { ok: true, text: JSON.stringify({ goal, pauseGate: describeGoalPauseGate(goal) }, null, 2) };
        const lines = [
            `Goal: ${goal.objective}`,
            `Status: ${goal.status}`,
            ...pauseGateStatusLines(goal),
            goal.goalMode ? `Mode: ${goal.goalMode}` : null,
            goal.planHint ? `Plan hint: ${goal.planHint}` : null,
            `Created: ${goal.createdAt}`,
            goal.lastCheckpoint ? `Last checkpoint: ${goal.lastCheckpoint.summary}` : null,
            goal.lastCheckpoint?.nextAction ? `Next action: ${goal.lastCheckpoint.nextAction}` : null,
            goal.budget ? `Budget: ${JSON.stringify(goal.budget)}` : null,
        ].filter(Boolean);
        return info(lines.join('\n'));
    }

    if (sub === 'update') {
        const rest = args.slice(1);
        const evIdx = rest.indexOf('--evidence');
        const evidence = evIdx >= 0
            ? rest.slice(evIdx + 1).join(' ').split(',').map(s => s.trim()).filter(Boolean)
            : [];
        const summary = (evIdx >= 0 ? rest.slice(0, evIdx) : rest).join(' ').trim();
        if (!summary) return blocked('Usage: /goal update <summary> [--evidence <note-or-path>[,<...>]]');
        const active = getActiveGoal();
        if (active?.goalMode === 'plan') {
            return blocked('Goal plan must be refined before checkpoints. Run `/goal refine <specific objective>` first.');
        }
        const goal = updateGoal(summary, '', evidence);
        if (!goal) return blocked('No active goal to update.');
        return info(`Checkpoint added: ${summary}${evidence.length ? ` (evidence: ${evidence.length})` : ''}`);
    }

    if (sub === 'done') {
        const force = args.includes('--force');
        if (!force && !goalHasCompletionEvidence(getActiveGoal())) {
            return blocked('Goal completion requires verification evidence on the latest checkpoint. Log it via `/goal update <summary> --evidence <test result / changed file>`, then retry — or pass --force for an explicit manual override.');
        }
        const note = args.slice(1).filter(a => a !== '--force').join(' ').trim() || undefined;
        clearGoalTimers();
        const goal = completeGoal(note);
        if (!goal) return blocked('No active goal to complete.');
        return info(`Goal completed: ${goal.objective}${note ? ` — ${note}` : ''}`);
    }

    if (sub === 'cancel') {
        const reason = args.slice(1).join(' ').trim() || undefined;
        clearGoalTimers();
        const goal = cancelGoal(reason);
        if (!goal) return blocked('No active goal to cancel.');
        return info(`Goal cancelled: ${goal.objective}`);
    }

    if (sub === 'pause') {
        const pauseArgs = args.slice(1).filter(a => a !== '--agent');
        const auditIdx = pauseArgs.indexOf('--audit');
        const auditEvidence = auditIdx >= 0 ? pauseArgs.slice(auditIdx + 1).join(' ').trim() : '';
        const reason = (auditIdx >= 0 ? pauseArgs.slice(0, auditIdx) : pauseArgs).join(' ').trim() || undefined;
        if (args.includes('--agent') && !auditEvidence) {
            return blocked('Agent-initiated goal pause requires independent audit evidence. Run an independent reviewer first, then retry with `cli-jaw goal pause --agent --audit "<review summary>"`.');
        }
        if (args.includes('--agent')) {
            const { getAgentPauseCount, incrementAgentPauseCount } = await import('../goal/store.js');
            const count = getAgentPauseCount();
            if (count < 1) {
                incrementAgentPauseCount();
                return blocked(
                    'First agent pause attempt recorded (1/2). Your pause was NOT executed.\n\n' +
                    'The next goal continuation will inject a dev-skill audit checklist.\n' +
                    'You MUST complete a thorough requirement-by-requirement verification before pausing again.\n\n' +
                    'Audit checklist:\n' +
                    '1. Derive every concrete requirement from the goal objective.\n' +
                    '2. For EACH requirement, provide authoritative evidence: file path, command output, test result, or runtime behavior.\n' +
                    '3. Mark each as PROVEN / UNPROVEN / CONTRADICTED. Any non-PROVEN item means work remains.\n' +
                    '4. Dev skill compliance: §3 verification gate, §5 safety rules, §7.2 static analysis.\n' +
                    '5. Documentation evidence: devlog entry, implementation paths, fresh verification output.\n' +
                    '6. Dispatch an independent reviewer (CLI sub-agent or jaw employee) to challenge whether viable work remains.\n\n' +
                    'If you find productive work and log a checkpoint, the pending pause gate is cleared.\n' +
                    'If no viable path remains and the reviewer confirms PASS, call `cli-jaw goal pause --agent --audit "<evidence>"` again; the second audited call pauses the goal.'
                );
            }
        }
        clearGoalTimers();
        const goal = pauseGoal({
            ...(reason ? { reason } : {}),
            ...(auditEvidence ? {
                audit: {
                    actor: args.includes('--agent') ? 'agent' : 'human',
                    evidence: auditEvidence,
                    timestamp: new Date().toISOString(),
                },
            } : {}),
        });
        if (!goal) return blocked('No active goal to pause.');
        return info(`Goal paused: ${goal.objective}`);
    }

    if (sub === 'resume') {
        const existing = getActiveGoal();
        if (existing && existing.status === 'active') {
            return fireSteerForWebCli(ctx, { ok: true, type: 'info', text: `Goal already active: ${existing.objective}`, steerPrompt: `[System] User resumed active goal: "${existing.objective}" (ID: ${existing.id}). Continue working on this goal.` });
        }
        const goal = resumeGoal();
        if (!goal) return blocked('No active or paused goal to resume.');
        return fireSteerForWebCli(ctx, { ok: true, type: 'info', text: `Goal resumed: ${goal.objective}`, steerPrompt: `[System] User resumed goal: "${goal.objective}" (ID: ${goal.id}). Continue working on this goal.` });
    }

    if (sub === 'clear') {
        clearGoalTimers();
        const ok = clearGoal();
        return ok ? info('Active goal cleared.') : blocked('No active goal to clear.');
    }

    if (sub === 'reset') {
        clearGoalTimers();
        resetGoalStore();
        return info('Goal store and history reset.');
    }

    if (sub === 'history') {
        const limit = Number(args[1]) || 10;
        const history = getGoalHistory();
        if (!history.goals.length) return info('No goal history.');
        const lines = history.goals.slice(0, limit).map((g, i) =>
            `${i + 1}. [${g.status}] ${g.objective} (${g.createdAt.slice(0, 10)})`
        );
        return info(lines.join('\n'));
    }

    // Unknown subcommand with args → treat as objective (e.g. `/goal fix the login bug`)
    if (args.length > 0) {
        const objective = args.join(' ').trim();
        const existing = getActiveGoal();
        clearGoalTimers();
        const settings = await resolveSettings(ctx);
        const wd = (settings as Record<string, unknown>)['workingDir'] as string | undefined;
        const goal = setGoal(objective, {
            ...(wd ? { repoRoot: wd } : {}),
            replace: true,
        });
        return fireSteerForWebCli(ctx, { ok: true, type: 'info', text: `Goal set: ${goal.objective}\nID: ${goal.id}${archivedGoalLine(existing)}`, steerPrompt: `[System] User set a new goal: "${goal.objective}" (ID: ${goal.id}). Acknowledge the goal and help the user achieve it.` });
    }

    // No args at all — show status or usage
    const goal = getActiveGoal();
    if (goal) {
        return info(`Active goal: ${goal.objective}\nStatus: ${goal.status}\nUse /goal status for details.`);
    }
    return info('No active goal. Use `/goal <objective>` to create one.\nSubcommands: status, update, done, cancel, pause, resume, clear, reset, history');
}

// ─── /goalplan and /gd aliases ──────
export const goalplanHandler = (args: string[], ctx: CliCommandContext): Promise<SlashResult> => goalWorkflowHandler(['plan', ...args], ctx);
export const gdHandler = (args: string[], ctx: CliCommandContext): Promise<SlashResult> => goalWorkflowHandler(['done', '--force', ...args.filter(a => a !== '--force')], ctx);

// ─── /team handler ──────────────────────────────────
import { createTeamPlan, hasOverlappingScopes } from '../team/planner.js';
import { checkTeamPreflight } from '../team/preflight.js';
import { buildAllDispatchTasks } from '../team/dispatcher.js';
import { allGuardsPassed, blockedGuards } from '../workflows/guards.js';
import type { TeamMode } from '../team/types.js';

export async function teamWorkflowHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const sub = (args[0] ?? '').toLowerCase();

    if (sub === 'plan') {
        const request = args.slice(1).join(' ').trim();
        if (!request) return blocked('Usage: /team plan <request>');
        const mode: TeamMode = 'audit-team';
        const plan = createTeamPlan(request, mode);
        const overlap = hasOverlappingScopes(plan);
        const lines = [
            `Team plan created: ${plan.teamId}`,
            `Mode: ${plan.mode}`,
            `Lanes: ${plan.lanes.length}`,
            ...plan.lanes.map(l => `  - ${l.role}: ${l.state}`),
            overlap.overlap ? `⚠ Overlapping files: ${overlap.files.join(', ')}` : null,
            '',
            'Use `/team audit <teamId>` to dispatch read-only employees.',
        ].filter(Boolean);
        return info(lines.join('\n'));
    }

    if (sub === 'audit') {
        const request = args.slice(1).join(' ').trim();
        if (!request) return blocked('Usage: /team audit <request>');
        const plan = createTeamPlan(request, 'audit-team');
        const settings = await resolveSettings(ctx);
        const wd = (settings as Record<string, unknown>)['workingDir'] as string | undefined;
        const projectRoot = wd || process.cwd();
        const guards = checkTeamPreflight({
            plan,
            orcState: 'IDLE',
            workerBusy: false,
            pendingReplay: false,
        });
        if (!allGuardsPassed(guards)) {
            const blocks = blockedGuards(guards);
            return blocked(`Team preflight failed:\n${blocks.map(g => `- ${g.code}: ${g.message}`).join('\n')}`);
        }
        const tasks = buildAllDispatchTasks(plan, projectRoot);
        const lines = [
            `[Preview] Team audit tasks prepared: ${plan.teamId}`,
            `Lanes: ${tasks.length}`,
            ...tasks.map(t => `  - ${t.lane.role}: dispatch prepared`),
            '',
            'Note: /team is a preview task-builder. Tasks are not auto-dispatched yet.',
            'Use `cli-jaw dispatch --agent "Name" --task "..."` to dispatch manually.',
        ];
        return info(lines.join('\n'));
    }

    if (sub === 'status') {
        return info('No active team run. Use `/team plan <request>` to create a team plan.');
    }

    if (sub === 'collect') {
        return info('No completed team results to collect. Use `/team audit <request>` to start a team audit.');
    }

    if (sub === 'stop') {
        if (!args.includes('--yes')) {
            return info('Run `/team stop <teamId> --yes` to stop an active team.');
        }
        return info('Team stopped.');
    }

    return info('Team orchestration commands:\n  /team plan <request>\n  /team audit <request>\n  /team status\n  /team collect\n  /team stop <teamId> --yes');
}

// ─── /review handler ─────────────────────────────────
export async function reviewWorkflowHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const locale = ctx.locale || 'ko';
    const settingsObj = await resolveSettings(ctx);
    const flags = parseReviewFlags(args);
    const reviewFocus = parseReviewFocus(args);
    const artifact = buildReviewArtifact(flags, locale, settingsObj, reviewFocus);
    const target = buildReviewTargetContext(settingsObj, artifact.id);
    const steerPrompt = buildReviewSteerPrompt(flags, target, reviewFocus);

    return fireSteerForWebCli(ctx, {
        ok: true,
        type: 'info',
        text: formatReviewText(artifact),
        artifact,
        originalText: artifact.sourcePrompt,
        steerPrompt,
    });
}
