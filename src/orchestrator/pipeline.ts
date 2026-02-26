// ─── Orchestration v2 (Plan → Phase-aware Distribute → Quality Gate Review) ──

import { broadcast } from '../core/bus.js';
import {
    insertMessage, getEmployees,
    clearAllEmployeeSessions,
} from '../core/db.js';
import { clearPromptCache } from '../prompt/builder.js';
import { spawnAgent } from '../agent/spawn.js';
import { createWorklog, readLatestWorklog, appendToWorklog, updateMatrix, updateWorklogStatus, parseWorklogPending } from '../memory/worklog.js';
import {
    PHASES, PHASE_INSTRUCTIONS,
    findEmployee, validateParallelSafety, runSingleAgent,
    buildPlanPrompt,
} from './distribute.js';

const MAX_ROUNDS = 3;

// ─── Parsing/Triage (extracted to orchestrator-parser.js) ──
import {
    isContinueIntent, needsOrchestration,
    parseSubtasks, parseDirectAnswer, stripSubtaskJSON, parseVerdicts,
} from './parser.js';
export { isContinueIntent, needsOrchestration, parseSubtasks, parseDirectAnswer, stripSubtaskJSON };

// ─── Phase 정의 (constants in distribute.ts) ─────────

const PHASE_PROFILES = {
    frontend: [1, 2, 3, 4, 5],
    backend: [1, 2, 3, 4, 5],
    data: [1, 2, 3, 4, 5],
    docs: [1, 3, 5],
    custom: [3],
};

// PHASE_INSTRUCTIONS moved to distribute.ts

// ─── Per-Agent Phase Tracking ────────────────────────

export function initAgentPhases(subtasks: any[]) {
    return subtasks.map((st: Record<string, any>) => {
        const role = (st.role || 'custom').toLowerCase();
        const fullProfile = PHASE_PROFILES[role as keyof typeof PHASE_PROFILES] || [3];

        // start_phase / end_phase 지원: planning agent가 지정한 범위
        // 잘못된 값은 profile 범위 내로 보정 (예: 99 -> 마지막 phase)
        const rawStart = Number(st.start_phase);
        const rawEnd = Number(st.end_phase);
        const minPhase = fullProfile[0]!;
        const maxPhase = fullProfile[fullProfile.length - 1]!;
        const startPhase: number = Number.isFinite(rawStart)
            ? Math.max(minPhase, Math.min(maxPhase, rawStart))
            : minPhase;
        const endPhase: number = Number.isFinite(rawEnd)
            ? Math.max(startPhase, Math.min(maxPhase, rawEnd))
            : maxPhase;
        const profile = fullProfile.filter((p: number) => p >= startPhase && p <= endPhase);
        // sparse fallback: 빈 profile이면 startPhase 이상 가장 가까운 phase 사용
        const effectiveProfile = profile.length > 0
            ? profile
            : [fullProfile.find((p: number) => p >= startPhase) || fullProfile[fullProfile.length - 1]!];
        if (profile.length === 0) {
            console.warn(`[jaw:phase] ${st.agent}: no phases in [${startPhase},${endPhase}], fallback to [${effectiveProfile[0]}]`);
        }

        if (startPhase > minPhase) {
            console.log(`[jaw:phase-skip] ${st.agent} (${role}): skipping to phase ${startPhase}`);
        }

        return {
            agent: st.agent,
            task: st.task,
            role,
            parallel: st.parallel === true,
            checkpoint: st.checkpoint === true,
            checkpointed: false,
            verification: st.verification || null,
            phaseProfile: effectiveProfile,
            currentPhaseIdx: 0,
            currentPhase: effectiveProfile[0],
            completed: false,
            history: [] as Record<string, any>[],
        };
    });
}

function advancePhase(ap: Record<string, any>, passed: boolean) {
    if (!passed) return;
    if (ap.currentPhaseIdx < ap.phaseProfile.length - 1) {
        ap.currentPhaseIdx++;
        ap.currentPhase = ap.phaseProfile[ap.currentPhaseIdx];
    } else {
        ap.completed = true;
    }
}

// ─── Plan Phase ──────────────────────────────────────

async function phasePlan(prompt: string, worklog: Record<string, any>, meta: Record<string, any> = {}) {
    broadcast('agent_status', { agentId: 'planning', agentName: '🎯 기획', status: 'planning' });

    const emps = getEmployees.all() as Record<string, any>[];
    const planPrompt = buildPlanPrompt(prompt, worklog.path, emps);

    const { promise } = spawnAgent(planPrompt, { agentId: 'planning', _skipInsert: true, origin: (meta as Record<string, any>).origin || 'web' });
    const result = await promise as Record<string, any>;

    // Agent 자율 판단: direct_answer가 있으면 subtask 생략
    const directAnswer = parseDirectAnswer(result.text);
    if (directAnswer) {
        return { planText: directAnswer, subtasks: [], directAnswer };
    }

    const planText = stripSubtaskJSON(result.text);
    appendToWorklog(worklog.path, 'Plan', planText || '(Plan Agent 응답 없음)');

    const subtasks = parseSubtasks(result.text);

    // §7.4: Fallback — if planning agent responded without JSON, treat as direct answer
    if (!subtasks || subtasks.length === 0) {
        console.warn('[orchestrator:plan] No JSON block found in planning response. Treating as direct answer.');
        return { planText: result.text, subtasks: [], directAnswer: result.text };
    }

    return { planText, subtasks };
}

// ─── Distribute Phase (per-agent phase-aware) ────────
// Helper functions (buildParallelContext, buildSequentialContext, findEmployee,
// validateParallelSafety, runSingleAgent) extracted to distribute.ts

async function distributeByPhase(agentPhases: Record<string, any>[], worklog: Record<string, any>, round: number, meta: Record<string, any> = {}) {
    const emps = getEmployees.all() as Record<string, any>[];
    const results: Record<string, any>[] = [];

    const active = agentPhases.filter((ap: Record<string, any>) => !ap.completed);
    if (active.length === 0) return results;

    // §7.3: Validate parallel safety before execution
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
            if (!emp) return Promise.resolve({ agent: ap.agent, role: ap.role, status: 'skipped', text: 'Agent not found' } as Record<string, any>);
            return runSingleAgent(ap, emp, worklog, round, meta, [], parallelPeers);
        });
        const parallelResults = await Promise.all(parallelPromises);
        results.push(...parallelResults);
    }

    // Phase 2: Run sequential group one-by-one (sees parallel results as prior)
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

// ─── Review Phase (per-agent verdict) ────────────────

async function phaseReview(results: Record<string, any>[], agentPhases: Record<string, any>[], worklog: Record<string, any>, round: number, meta: Record<string, any> = {}) {
    const report = results.map((r: Record<string, any>) =>
        `- **${r.agent}** (${r.role}, ${r.phaseLabel}): ${r.status === 'done' ? '✅' : '❌'}\n  ${r.text.slice(0, 400)}`
    ).join('\n');

    const matrixStr = agentPhases.map((ap: Record<string, any>) => {
        const base = `- ${ap.agent}: role=${ap.role}, phase=${ap.currentPhase}(${PHASES[ap.currentPhase as keyof typeof PHASES]}), completed=${ap.completed}`;
        if (ap.verification) {
            return `${base}\n  pass_criteria: ${ap.verification.pass_criteria || 'N/A'}\n  fail_criteria: ${ap.verification.fail_criteria || 'N/A'}`;
        }
        return base;
    }).join('\n');

    const reviewPrompt = `## 라운드 ${round} 결과 리뷰

### 실행 결과
${report}

### 현재 Agent 상태
${matrixStr}

### Worklog
${worklog.path} — 이 파일의 변경사항도 확인하세요.

## 판정 (각 agent별로 개별 판정)

### Quality Gate 루브릭
각 agent의 현재 phase에 따라 아래 기준으로 판정:

- **Phase 1 (기획)**: 영향 범위 분석 + 의존성 확인 + 엣지 케이스 목록 있는가?
- **Phase 2 (기획검증)**: 실제 코드와 대조 확인 + 충돌 검사 + 테스트 전략 수립됐는가?
- **Phase 3 (개발)**: 변경 파일 목록 + export/import 무결성 + 빌드 에러 없는가?
- **Phase 4 (디버깅)**: 실행 결과 증거 + 버그 수정 내역 + 엣지 케이스 테스트 결과 있는가?
- **Phase 5 (통합검증)**: 통합 테스트 + 문서 업데이트 + 워크플로우 동작 확인?

### 판정 규칙
- **PASS**: 해당 phase의 필수 항목 모두 충족. 구체적 근거 제시.
- **FAIL**: 필수 항목 중 하나라도 미충족. **구체적 수정 지시** 제공 ("더 노력하세요" 금지, 구체적 행동 제시).

JSON으로 출력:
\`\`\`json
{
  "verdicts": [
    { "agent": "이름", "pass": true, "feedback": "통과 근거: ..." },
    { "agent": "이름", "pass": false, "feedback": "수정 필요: 1. ... 2. ..." }
  ],
  "allDone": false
}
\`\`\`

모든 작업이 완료되면 allDone: true + 사용자에게 보여줄 자연어 요약을 함께 작성.`;

    broadcast('agent_status', { agentId: 'planning', agentName: '🎯 기획', status: 'reviewing' });
    const { promise } = spawnAgent(reviewPrompt, { agentId: 'planning', internal: true, origin: (meta as Record<string, any>).origin || 'web' });
    const evalR = await promise as Record<string, any>;

    const verdicts = parseVerdicts(evalR.text);
    return { verdicts, rawText: evalR.text };
}

// ─── Main Orchestrate v2 ─────────────────────────────

export async function orchestrate(prompt: string, meta: Record<string, any> = {}) {
    clearAllEmployeeSessions.run();
    clearPromptCache();

    const origin = meta.origin || 'web';
    const employees = getEmployees.all();

    // Triage: 간단한 메시지는 직접 응답
    if (employees.length > 0 && !needsOrchestration(prompt)) {
        console.log(`[jaw:triage] direct response (no orchestration needed)`);
        const { promise } = spawnAgent(prompt, { origin });
        const result = await promise as Record<string, any>;
        const lateSubtasks = parseSubtasks(result.text);
        if (lateSubtasks?.length) {
            console.log(`[jaw:triage] agent chose to dispatch (${lateSubtasks.length} subtasks)`);
            const worklog = createWorklog(prompt);
            broadcast('worklog_created', { path: worklog.path });
            clearAllEmployeeSessions.run();
            const planText = stripSubtaskJSON(result.text);
            appendToWorklog(worklog.path, 'Plan', planText || '(Agent-initiated dispatch)');
            const agentPhases = initAgentPhases(lateSubtasks);
            updateMatrix(worklog.path, agentPhases);
            // Round loop (same as L508-553)
            for (let round = 1; round <= MAX_ROUNDS; round++) {
                updateWorklogStatus(worklog.path, 'round_' + round, round);
                broadcast('round_start', { round, agentPhases });
                const results = await distributeByPhase(agentPhases, worklog, round, { origin });
                const { verdicts, rawText } = await phaseReview(results, agentPhases, worklog, round, { origin });
                if (verdicts?.verdicts) {
                    for (const v of verdicts.verdicts) {
                        const ap = agentPhases.find((a: Record<string, any>) => a.agent === v.agent);
                        if (ap) {
                            const judgedPhase = ap.currentPhase;
                            advancePhase(ap, v.pass);
                            ap.history.push({ round, phase: judgedPhase, pass: v.pass, feedback: v.feedback });
                        }
                    }
                } else {
                    console.warn(`[jaw:review] verdict parse failed — skipping phase advance (round ${round})`);
                }
                updateMatrix(worklog.path, agentPhases);

                // 완료 판정
                const scopeDone = agentPhases.every((ap: Record<string, any>) => ap.completed)
                    || verdicts?.allDone === true;
                const hasCheckpoint = agentPhases.some((ap: Record<string, any>) => ap.checkpoint && !ap.checkpointed);

                if (scopeDone && hasCheckpoint) {
                    // CHECKPOINT: completed 마킹 안 함, 세션 보존
                    agentPhases.forEach((ap: Record<string, any>) => {
                        if (ap.checkpoint) ap.checkpointed = true;
                    });
                    updateMatrix(worklog.path, agentPhases);
                    const summary = stripSubtaskJSON(rawText) || '요청된 scope 완료';
                    appendToWorklog(worklog.path, 'Final Summary', summary);
                    updateWorklogStatus(worklog.path, 'checkpoint', round);
                    insertMessage.run('assistant', summary + '\n\n다음: "리뷰해봐", "이어서 해줘", "리셋해"', 'orchestrator', '');
                    broadcast('orchestrate_done', { text: summary, worklog: worklog.path, origin, checkpoint: true });
                    return;
                }

                if (scopeDone) {
                    // DONE: 진짜 완료
                    agentPhases.forEach((ap: Record<string, any>) => { ap.completed = true; });
                    updateMatrix(worklog.path, agentPhases);
                    const summary = stripSubtaskJSON(rawText) || '모든 작업 완료';
                    appendToWorklog(worklog.path, 'Final Summary', summary);
                    updateWorklogStatus(worklog.path, 'done', round);
                    clearAllEmployeeSessions.run();
                    insertMessage.run('assistant', summary, 'orchestrator', '');
                    broadcast('orchestrate_done', { text: summary, worklog: worklog.path, origin });
                    return;
                }

                broadcast('round_done', { round, action: 'next', agentPhases });
                if (round === MAX_ROUNDS) {
                    const done = agentPhases.filter((ap: Record<string, any>) => ap.completed);
                    const pending = agentPhases.filter((ap: Record<string, any>) => !ap.completed);
                    const partial = `## 완료 (${done.length})\n${done.map((a: Record<string, any>) => `- ✅ ${a.agent} (${a.role})`).join('\n')}\n\n` +
                        `## 미완료 (${pending.length})\n${pending.map((a: Record<string, any>) => `- ⏳ ${a.agent} (${a.role}) — Phase ${a.currentPhase}: ${PHASES[a.currentPhase as keyof typeof PHASES]}`).join('\n')}\n\n` +
                        `이어서 진행하려면 "이어서 해줘"라고 말씀하세요.\nWorklog: ${worklog.path}`;
                    appendToWorklog(worklog.path, 'Final Summary', partial);
                    updateWorklogStatus(worklog.path, 'partial', round);
                    // partial: 세션 보존 (이어서 해줘 대비, 새 orchestrate() 시 L228에서 자동 정리)
                    insertMessage.run('assistant', partial, 'orchestrator', '');
                    broadcast('orchestrate_done', { text: partial, worklog: worklog.path, origin });
                }
            }
            return;
        }

        const stripped = stripSubtaskJSON(result.text);
        broadcast('orchestrate_done', { text: stripped || result.text || '', origin });
        return;
    }

    // 직원 없으면 단일 에이전트 모드
    if (employees.length === 0) {
        const { promise } = spawnAgent(prompt, { origin });
        const result = await promise as Record<string, any>;
        const stripped = stripSubtaskJSON(result.text);
        broadcast('orchestrate_done', { text: stripped || result.text || '', origin });
        return;
    }

    const worklog = createWorklog(prompt);
    broadcast('worklog_created', { path: worklog.path });
    clearAllEmployeeSessions.run();

    // 1. 기획 (planning agent가 직접 응답할 수도 있음)
    const { planText, subtasks, directAnswer } = await phasePlan(prompt, worklog, { origin });

    // Agent 자율 판단: subtask 불필요 → 직접 응답
    if (directAnswer) {
        console.log('[jaw:triage] planning agent chose direct response');
        broadcast('agent_done', { text: directAnswer, origin });
        broadcast('orchestrate_done', { text: directAnswer, origin });
        return;
    }

    if (!subtasks?.length) {
        broadcast('orchestrate_done', { text: planText || '', origin });
        return;
    }

    // 2. Per-agent phase 초기화
    const agentPhases = initAgentPhases(subtasks);
    updateMatrix(worklog.path, agentPhases);

    // 3. Round loop
    for (let round = 1; round <= MAX_ROUNDS; round++) {
        updateWorklogStatus(worklog.path, 'round_' + round, round);
        broadcast('round_start', { round, agentPhases });

        const results = await distributeByPhase(agentPhases, worklog, round, { origin });
        const { verdicts, rawText } = await phaseReview(results, agentPhases, worklog, round, { origin });

        // 4. Per-agent phase advance
        if (verdicts?.verdicts) {
            for (const v of verdicts.verdicts) {
                const ap = agentPhases.find((a: Record<string, any>) => a.agent === v.agent);
                if (ap) {
                    const judgedPhase = ap.currentPhase;  // advance 전 기록
                    advancePhase(ap, v.pass);
                    ap.history.push({ round, phase: judgedPhase, pass: v.pass, feedback: v.feedback });
                }
            }
        } else {
            console.warn(`[jaw:review] verdict parse failed — skipping phase advance (round ${round})`);
        }
        updateMatrix(worklog.path, agentPhases);

        // 5. 완료 판정
        const scopeDone = agentPhases.every((ap: Record<string, any>) => ap.completed)
            || verdicts?.allDone === true;
        const hasCheckpoint = agentPhases.some((ap: Record<string, any>) => ap.checkpoint && !ap.checkpointed);

        if (scopeDone && hasCheckpoint) {
            // CHECKPOINT: completed 마킹 안 함, 세션 보존
            agentPhases.forEach((ap: Record<string, any>) => {
                if (ap.checkpoint) ap.checkpointed = true;
            });
            updateMatrix(worklog.path, agentPhases);
            const summary = stripSubtaskJSON(rawText) || '요청된 scope 완료';
            appendToWorklog(worklog.path, 'Final Summary', summary);
            updateWorklogStatus(worklog.path, 'checkpoint', round);
            insertMessage.run('assistant', summary + '\n\n다음: "리뷰해봐", "이어서 해줘", "리셋해"', 'orchestrator', '');
            broadcast('orchestrate_done', { text: summary, worklog: worklog.path, origin, checkpoint: true });
            break;
        }

        if (scopeDone) {
            // DONE: 진짜 완료
            agentPhases.forEach((ap: Record<string, any>) => { ap.completed = true; });
            updateMatrix(worklog.path, agentPhases);
            const summary = stripSubtaskJSON(rawText) || '모든 작업 완료';
            appendToWorklog(worklog.path, 'Final Summary', summary);
            updateWorklogStatus(worklog.path, 'done', round);
            clearAllEmployeeSessions.run();
            insertMessage.run('assistant', summary, 'orchestrator', '');
            broadcast('orchestrate_done', { text: summary, worklog: worklog.path, origin });
            break;
        }

        broadcast('round_done', { round, action: 'next', agentPhases });

        // 6. Max round 도달 → 부분 보고
        if (round === MAX_ROUNDS) {
            const done = agentPhases.filter((ap: Record<string, any>) => ap.completed);
            const pending = agentPhases.filter((ap: Record<string, any>) => !ap.completed);
            const partial = `## 완료 (${done.length})\n${done.map((a: Record<string, any>) => `- ✅ ${a.agent} (${a.role})`).join('\n')}\n\n` +
                `## 미완료 (${pending.length})\n${pending.map((a: Record<string, any>) => `- ⏳ ${a.agent} (${a.role}) — Phase ${a.currentPhase}: ${PHASES[a.currentPhase as keyof typeof PHASES]}`).join('\n')}\n\n` +
                `이어서 진행하려면 "이어서 해줘"라고 말씀하세요.\nWorklog: ${worklog.path}`;
            appendToWorklog(worklog.path, 'Final Summary', partial);
            updateWorklogStatus(worklog.path, 'partial', round);
            // partial: 세션 보존 (이어서 해줘 대비, 새 orchestrate() 시 L228에서 자동 정리)
            insertMessage.run('assistant', partial, 'orchestrator', '');
            broadcast('orchestrate_done', { text: partial, worklog: worklog.path, origin });
        }
    }
}

// ─── Continue (이어서 해줘) ───────────────────────────

export async function orchestrateContinue(meta: Record<string, any> = {}) {
    const origin = (meta as Record<string, any>).origin || 'web';
    const latest = readLatestWorklog();
    if (!latest) {
        broadcast('orchestrate_done', { text: '이어갈 worklog가 없습니다.', origin });
        return;
    }

    const pending = parseWorklogPending(latest.content);
    if (!pending.length) {
        broadcast('orchestrate_done', { text: '모든 작업이 이미 완료되었습니다.', origin });
        return;
    }

    const resumePrompt = `## 이어서 작업
이전 worklog를 읽고 미완료 항목을 이어서 진행하세요.

Worklog: ${latest.path}

미완료 항목:
${pending.map((p: Record<string, any>) => `- ${p.agent} (${p.role}): Phase ${p.currentPhase}`).join('\n')}

subtask JSON을 출력하세요.`;

    return orchestrate(resumePrompt, meta);
}
