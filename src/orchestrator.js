// ─── Orchestration v2 (Plan → Phase-aware Distribute → Quality Gate Review) ──

import { broadcast } from './bus.js';
import { insertMessage, getEmployees } from './db.js';
import { getSubAgentPromptV2 } from './prompt.js';
import { spawnAgent } from './agent.js';
import { createWorklog, appendToWorklog, updateMatrix, updateWorklogStatus } from './worklog.js';

const MAX_ROUNDS = 3;

// ─── Phase 정의 ──────────────────────────────────────
const PHASES = { 1: '기획', 2: '기획검증', 3: '개발', 4: '디버깅', 5: '통합검증' };

const PHASE_PROFILES = {
    frontend: [1, 2, 3, 4, 5],
    backend: [1, 2, 3, 4, 5],
    data: [1, 2, 3, 4, 5],
    docs: [1, 3, 5],
    custom: [3],
};

const PHASE_INSTRUCTIONS = {
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

// ─── JSON Parsing (export 유지 — agent.js가 import) ──

export function parseSubtasks(text) {
    if (!text) return null;
    const fenced = text.match(/```json\n([\s\S]*?)\n```/);
    if (fenced) {
        try { return JSON.parse(fenced[1]).subtasks || null; } catch { }
    }
    const raw = text.match(/(\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*\]\s*\})/);
    if (raw) {
        try { return JSON.parse(raw[1]).subtasks || null; } catch { }
    }
    return null;
}

export function stripSubtaskJSON(text) {
    return text
        .replace(/```json\n[\s\S]*?\n```/g, '')
        .replace(/\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*?\]\s*\}/g, '')
        .trim();
}

// ─── Verdict JSON Parsing (이중 전략) ────────────────

function parseVerdicts(text) {
    if (!text) return null;
    try {
        const fenced = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
        if (fenced) return JSON.parse(fenced[1]);
    } catch { }
    try {
        const raw = text.match(/\{[\s\S]*"verdicts"[\s\S]*\}/);
        if (raw) return JSON.parse(raw[0]);
    } catch { }
    return null;
}

// ─── Per-Agent Phase Tracking ────────────────────────

function initAgentPhases(subtasks) {
    return subtasks.map(st => {
        const role = (st.role || 'custom').toLowerCase();  // 정규화: Frontend → frontend
        const profile = PHASE_PROFILES[role] || [3];
        return {
            agent: st.agent,
            task: st.task,
            role,
            verification: st.verification || null,  // pass_criteria/fail_criteria 보존
            phaseProfile: profile,
            currentPhaseIdx: 0,
            currentPhase: profile[0],
            completed: false,
            history: [],
        };
    });
}

function advancePhase(ap, passed) {
    if (!passed) return;
    if (ap.currentPhaseIdx < ap.phaseProfile.length - 1) {
        ap.currentPhaseIdx++;
        ap.currentPhase = ap.phaseProfile[ap.currentPhaseIdx];
    } else {
        ap.completed = true;
    }
}

// ─── Plan Phase ──────────────────────────────────────

async function phasePlan(prompt, worklog) {
    broadcast('agent_status', { agentId: 'planning', agentName: '🎯 기획', status: 'planning' });

    const planPrompt = `## 작업 요청
${prompt}

## 출력 형식 (반드시 준수)
1. 자연어로 계획을 설명하세요.
2. **검증 기준을 반드시 포함**하세요. 각 subtask별로:
   - ✅ 성공 기준 (어떻게 되면 통과인가)
   - ❌ 실패 기준 (어떻게 되면 재시도인가)
   - 파일 변경 범위 (어떤 파일들이 영향받는가)
3. subtask JSON을 아래 형식으로 출력하세요:

\`\`\`json
{
  "subtasks": [
    {
      "agent": "직원이름",
      "role": "frontend|backend|data|docs",
      "task": "구체적 지시",
      "verification": {
        "pass_criteria": "통과 기준 (1줄)",
        "fail_criteria": "실패 기준 (1줄)",
        "affected_files": ["src/file.js"]
      }
    }
  ]
}
\`\`\`

worklog 경로: ${worklog.path}
이 파일에 계획을 기록하세요.`;

    const { promise } = spawnAgent(planPrompt, { agentId: 'planning' });
    const result = await promise;

    const planText = stripSubtaskJSON(result.text);
    appendToWorklog(worklog.path, 'Plan', planText || '(Plan Agent 응답 없음)');

    const subtasks = parseSubtasks(result.text);
    return { planText, subtasks };
}

// ─── Distribute Phase (per-agent phase-aware) ────────

async function distributeByPhase(agentPhases, worklog, round) {
    const emps = getEmployees.all();
    const results = [];

    const active = agentPhases.filter(ap => !ap.completed);
    if (active.length === 0) return results;

    const promises = active.map(ap => {
        const emp = emps.find(e =>
            e.name === ap.agent || e.name?.includes(ap.agent) || ap.agent.includes(e.name)
        );
        if (!emp) {
            results.push({ agent: ap.agent, role: ap.role, status: 'skipped', text: 'Agent not found' });
            return Promise.resolve();
        }

        const instruction = PHASE_INSTRUCTIONS[ap.currentPhase];
        const phaseLabel = PHASES[ap.currentPhase];
        const sysPrompt = getSubAgentPromptV2(emp, ap.role, ap.currentPhase);

        const taskPrompt = `## 작업 지시 [${phaseLabel}]
${ap.task}

## 현재 Phase: ${ap.currentPhase} (${phaseLabel})
${instruction}

## Worklog
이 파일을 먼저 읽으세요: ${worklog.path}
작업 완료 후 반드시 Execution Log 섹션에 결과를 기록하세요.`;

        broadcast('agent_status', {
            agentId: emp.id, agentName: emp.name,
            status: 'running', phase: ap.currentPhase, phaseLabel,
        });

        const { promise } = spawnAgent(taskPrompt, {
            agentId: emp.id, cli: emp.cli, model: emp.model,
            forceNew: true, sysPrompt,
        });

        return promise.then(r => {
            const result = {
                agent: ap.agent, role: ap.role, id: emp.id,
                phase: ap.currentPhase, phaseLabel,
                status: r.code === 0 ? 'done' : 'error',
                text: r.text || '',
            };
            results.push(result);
            broadcast('agent_status', { agentId: emp.id, agentName: emp.name, status: result.status, phase: ap.currentPhase });
        });
    });

    await Promise.all(promises);

    // Orchestrator가 순차적으로 worklog에 기록 (안전)
    for (const r of results) {
        appendToWorklog(worklog.path, 'Execution Log',
            `### Round ${round} — ${r.agent} (${r.role}, ${r.phaseLabel})\n- Status: ${r.status}\n- Result: ${r.text.slice(0, 500)}`
        );
    }

    return results;
}

// ─── Review Phase (per-agent verdict) ────────────────

async function phaseReview(results, agentPhases, worklog, round) {
    const report = results.map(r =>
        `- **${r.agent}** (${r.role}, ${r.phaseLabel}): ${r.status === 'done' ? '✅' : '❌'}\n  ${r.text.slice(0, 400)}`
    ).join('\n');

    const matrixStr = agentPhases.map(ap => {
        const base = `- ${ap.agent}: role=${ap.role}, phase=${ap.currentPhase}(${PHASES[ap.currentPhase]}), completed=${ap.completed}`;
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
    const { promise } = spawnAgent(reviewPrompt, { agentId: 'planning', internal: true });
    const evalR = await promise;

    const verdicts = parseVerdicts(evalR.text);
    return { verdicts, rawText: evalR.text };
}

// ─── Main Orchestrate v2 ─────────────────────────────

export async function orchestrate(prompt) {
    const employees = getEmployees.all();

    // 직원 없으면 단일 에이전트 모드
    if (employees.length === 0) {
        const { promise } = spawnAgent(prompt);
        const result = await promise;
        const stripped = stripSubtaskJSON(result.text);
        broadcast('orchestrate_done', { text: stripped || result.text || '' });
        return;
    }

    const worklog = createWorklog(prompt);
    broadcast('worklog_created', { path: worklog.path });

    // 1. 기획
    const { planText, subtasks } = await phasePlan(prompt, worklog);
    if (!subtasks?.length) {
        broadcast('orchestrate_done', { text: planText || '' });
        return;
    }

    // 2. Per-agent phase 초기화
    const agentPhases = initAgentPhases(subtasks);
    updateMatrix(worklog.path, agentPhases);

    // 3. Round loop
    for (let round = 1; round <= MAX_ROUNDS; round++) {
        updateWorklogStatus(worklog.path, 'round_' + round, round);
        broadcast('round_start', { round, agentPhases });

        const results = await distributeByPhase(agentPhases, worklog, round);
        const { verdicts, rawText } = await phaseReview(results, agentPhases, worklog, round);

        // 4. Per-agent phase advance
        if (verdicts?.verdicts) {
            for (const v of verdicts.verdicts) {
                const ap = agentPhases.find(a => a.agent === v.agent);
                if (ap) {
                    const judgedPhase = ap.currentPhase;  // advance 전 기록
                    advancePhase(ap, v.pass);
                    ap.history.push({ round, phase: judgedPhase, pass: v.pass, feedback: v.feedback });
                }
            }
        }
        updateMatrix(worklog.path, agentPhases);

        // 5. 완료 판정 (agentPhases 기준 우선, allDone은 보조)
        const allDone = agentPhases.every(ap => ap.completed);
        if (allDone) {
            const summary = stripSubtaskJSON(rawText) || '모든 작업 완료';
            appendToWorklog(worklog.path, 'Final Summary', summary);
            updateWorklogStatus(worklog.path, 'done', round);
            insertMessage.run('assistant', summary, 'orchestrator', '');
            broadcast('orchestrate_done', { text: summary, worklog: worklog.path });
            break;
        }

        broadcast('round_done', { round, action: 'next', agentPhases });

        // 6. Max round 도달 → 부분 보고
        if (round === MAX_ROUNDS) {
            const done = agentPhases.filter(ap => ap.completed);
            const pending = agentPhases.filter(ap => !ap.completed);
            const partial = `## 완료 (${done.length})\n${done.map(a => `- ✅ ${a.agent} (${a.role})`).join('\n')}\n\n` +
                `## 미완료 (${pending.length})\n${pending.map(a => `- ⏳ ${a.agent} (${a.role}) — Phase ${a.currentPhase}: ${PHASES[a.currentPhase]}`).join('\n')}\n\n` +
                `이어서 진행하려면 "이어서 해줘"라고 말씀하세요.\nWorklog: ${worklog.path}`;
            appendToWorklog(worklog.path, 'Final Summary', partial);
            updateWorklogStatus(worklog.path, 'partial', round);
            insertMessage.run('assistant', partial, 'orchestrator', '');
            broadcast('orchestrate_done', { text: partial, worklog: worklog.path });
        }
    }
}
