// ─── Orchestration v2 (Plan → Phase-aware Distribute → Quality Gate Review) ──

import { broadcast } from './bus.js';
import { insertMessage, getEmployees } from './db.js';
import { getSubAgentPromptV2 } from './prompt.js';
import { spawnAgent } from './agent.js';
import { createWorklog, readLatestWorklog, appendToWorklog, updateMatrix, updateWorklogStatus, parseWorklogPending } from './worklog.js';

const MAX_ROUNDS = 3;

// ─── Phase 정의 ──────────────────────────────────────
const PHASES = { 1: '기획', 2: '기획검증', 3: '개발', 4: '디버깅', 5: '통합검증' };

// "이어서 해줘" 계열은 명시적인 짧은 명령만 continue intent로 취급
const CONTINUE_PATTERNS = [
    /^\/?continue$/i,
    /^이어서(?:\s*해줘)?$/i,
    /^계속(?:\s*해줘)?$/i,
];

export function isContinueIntent(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return CONTINUE_PATTERNS.some(re => re.test(t));
}

// ─── Message Triage: 복잡한 작업만 orchestrate ───────

const CODE_KEYWORDS = /\.(js|ts|jsx|tsx|py|md|json|css|html|sql|yml|yaml|sh|go|rs|swift)|구현|작성|만들어|수정|코딩|리팩|버그|에러|디버그|테스트|빌드|설치|배포|삭제|추가|변경|생성|개발|엔드포인트|서버|라우트|스키마|컴포넌트|모듈|함수|클래스|\bAPI\b|\bDB\b/i;
const FILE_PATH_PATTERN = /(?:src|bin|public|lib|devlog|config|components?|pages?|api)\//i;
const MULTI_TASK_PATTERN = /(?:그리고|다음에|먼저|또한|추가로|\n\n|\d+\.\s)/;

export function needsOrchestration(text) {
    const t = String(text || '').trim();
    if (!t) return false;

    let signals = 0;

    // Signal 1: 길이 (80자 이상)
    if (t.length >= 80) signals++;

    // Signal 2: 코드 키워드 카운트
    const codeMatches = t.match(CODE_KEYWORDS);
    if (codeMatches) signals++;
    // 2개 이상의 서로 다른 코드 키워드 → 추가 signal
    const allCodeMatches = [...new Set((t.match(new RegExp(CODE_KEYWORDS.source, 'gi')) || []))];
    if (allCodeMatches.length >= 2) signals++;

    // Signal 3: 파일 경로 패턴
    if (FILE_PATH_PATTERN.test(t)) signals++;

    // Signal 4: 멀티 태스크 신호
    if (MULTI_TASK_PATTERN.test(t)) signals++;

    return signals >= 2;
}

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
        try { return JSON.parse(fenced[1]).subtasks || null; } catch (e) { console.debug('[orchestrator:subtask] fenced JSON parse failed', { preview: String(fenced[1]).slice(0, 80) }); }
    }
    const raw = text.match(/(\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*\]\s*\})/);
    if (raw) {
        try { return JSON.parse(raw[1]).subtasks || null; } catch (e) { console.debug('[orchestrator:subtask] raw JSON parse failed', { preview: String(raw[1]).slice(0, 80) }); }
    }
    return null;
}

export function parseDirectAnswer(text) {
    if (!text) return null;
    // Fenced JSON block
    const fenced = text.match(/```json\n([\s\S]*?)\n```/);
    if (fenced) {
        try {
            const obj = JSON.parse(fenced[1]);
            if (obj.direct_answer && (!obj.subtasks || obj.subtasks.length === 0)) {
                return obj.direct_answer;
            }
        } catch { /* expected: fenced JSON may not contain direct_answer */ }
    }
    // Raw JSON
    const raw = text.match(/(\{[\s\S]*"direct_answer"\s*:[\s\S]*\})/);
    if (raw) {
        try {
            const obj = JSON.parse(raw[1]);
            if (obj.direct_answer && (!obj.subtasks || obj.subtasks.length === 0)) {
                return obj.direct_answer;
            }
        } catch { /* expected: raw JSON may not contain direct_answer */ }
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
    } catch { /* expected: fenced JSON may not exist or be malformed */ }
    try {
        const raw = text.match(/\{[\s\S]*"verdicts"[\s\S]*\}/);
        if (raw) return JSON.parse(raw[0]);
    } catch { /* expected: raw JSON may not exist or be malformed */ }
    return null;
}

// ─── Per-Agent Phase Tracking ────────────────────────

function initAgentPhases(subtasks) {
    return subtasks.map(st => {
        const role = (st.role || 'custom').toLowerCase();
        const fullProfile = PHASE_PROFILES[role] || [3];

        // start_phase 지원: planning agent가 지정한 시작 phase부터
        // 잘못된 값은 profile 범위 내로 보정 (예: 99 -> 마지막 phase)
        const rawStart = Number(st.start_phase);
        const minPhase = fullProfile[0];
        const maxPhase = fullProfile[fullProfile.length - 1];
        const startPhase = Number.isFinite(rawStart)
            ? Math.max(minPhase, Math.min(maxPhase, rawStart))
            : minPhase;
        const profile = fullProfile.filter(p => p >= startPhase);
        // profile이 비면 최소한 마지막 phase는 실행
        const effectiveProfile = profile.length > 0 ? profile : [fullProfile[fullProfile.length - 1]];

        if (startPhase > minPhase) {
            console.log(`[claw:phase-skip] ${st.agent} (${role}): skipping to phase ${startPhase}`);
        }

        return {
            agent: st.agent,
            task: st.task,
            role,
            verification: st.verification || null,
            phaseProfile: effectiveProfile,
            currentPhaseIdx: 0,
            currentPhase: effectiveProfile[0],
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

async function phasePlan(prompt, worklog, meta = {}) {
    broadcast('agent_status', { agentId: 'planning', agentName: '🎯 기획', status: 'planning' });

    const planPrompt = `## 작업 요청
${prompt}

## 판단 기준
먼저 이 요청이 **여러 직원에게 분배할 복잡한 개발 작업인지** 판단하세요.

### 직접 응답 (subtasks 불필요):
- 인사, 잡담, 간단한 질문
- 한 줄 대답으로 충분한 요청
- 정보 확인, 상태 질문

이 경우 subtasks를 빈 배열로 하고 direct_answer에 응답을 넣으세요:

\`\`\`json
{
  "direct_answer": "여기에 직접 응답",
  "subtasks": []
}
\`\`\`

### 분배 필요 (subtasks 생성):

#### ⚠️ 에이전트 수 결정 원칙
**필요한 최소한의 에이전트만 배정하세요:**
- 단일 파일/영역 작업 → **1명**만
- 프론트+백엔드 → **2명**
- 대규모 멀티 영역 → 필요한 만큼 (보통 2~3명)
- **5명 전원 투입은 대규모 프로젝트 초기 설계에만 해당**
- 같은 파일을 여러 에이전트가 건드리지 않도록 주의

#### ⚠️ 시작 Phase 결정
작업 유형에 따라 **start_phase**를 지정하세요:
- 신규 개발: start_phase = 1 (기획부터)
- 리팩토링/수정: start_phase = 3 (개발부터)
- 버그 수정/디버깅: start_phase = 4 (디버깅부터)
- 검수/테스트: start_phase = 4 (디버깅부터)
- 문서 작업: start_phase = 3 (개발부터)

## 출력 형식 (반드시 준수)
1. 자연어로 계획을 설명하세요.
2. **검증 기준을 반드시 포함**하세요.
3. subtask JSON:

\`\`\`json
{
  "subtasks": [
    {
      "agent": "직원이름",
      "role": "frontend|backend|data|docs",
      "task": "구체적 지시",
      "start_phase": 3,
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

    const { promise } = spawnAgent(planPrompt, { agentId: 'planning', origin: meta.origin || 'web' });
    const result = await promise;

    // Agent 자율 판단: direct_answer가 있으면 subtask 생략
    const directAnswer = parseDirectAnswer(result.text);
    if (directAnswer) {
        return { planText: directAnswer, subtasks: [], directAnswer };
    }

    const planText = stripSubtaskJSON(result.text);
    appendToWorklog(worklog.path, 'Plan', planText || '(Plan Agent 응답 없음)');

    const subtasks = parseSubtasks(result.text);
    return { planText, subtasks };
}

// ─── Distribute Phase (per-agent phase-aware) ────────

async function distributeByPhase(agentPhases, worklog, round, meta = {}) {
    const emps = getEmployees.all();
    const results = [];

    const active = agentPhases.filter(ap => !ap.completed);
    if (active.length === 0) return results;

    // 순차 실행: 각 에이전트가 이전 에이전트의 변경을 볼 수 있도록
    for (const ap of active) {
        const emp = emps.find(e =>
            e.name === ap.agent || e.name?.includes(ap.agent) || ap.agent.includes(e.name)
        );
        if (!emp) {
            results.push({ agent: ap.agent, role: ap.role, status: 'skipped', text: 'Agent not found' });
            continue;
        }

        const instruction = PHASE_INSTRUCTIONS[ap.currentPhase];
        const phaseLabel = PHASES[ap.currentPhase];
        const sysPrompt = getSubAgentPromptV2(emp, ap.role, ap.currentPhase);

        // 이전 에이전트 결과 요약 (순차 실행이므로 이미 완료된 것들)
        const priorSummary = results.length > 0
            ? results.map(r => `- ${r.agent} (${r.role}): ${r.status} — ${r.text.slice(0, 150)}`).join('\n')
            : '(첫 번째 에이전트입니다)';

        const remainingPhases = ap.phaseProfile.slice(ap.currentPhaseIdx).map(p => `${p}(${PHASES[p]})`).join('→');

        const taskPrompt = `## 작업 지시 [${phaseLabel}]
${ap.task}

## 현재 Phase: ${ap.currentPhase} (${phaseLabel})
${instruction}

## 남은 Phase: ${remainingPhases}

## Phase 유연성
현재 Phase의 작업을 수행하되, **자신있다면 다음 Phase까지 한 번에 처리해도 됩니다.**
예: 기획과 개발을 동시에 → 기획 분석 + 코드 작성까지 한 번에 완료.
이 경우 응답 마지막에 아래 JSON을 추가하세요:

\`\`\`json
{ "phases_completed": [${ap.phaseProfile.slice(ap.currentPhaseIdx).join(', ')}] }
\`\`\`

한 Phase만 완료한 경우에는 이 JSON을 넣지 않아도 됩니다.

## 순차 실행 규칙
- **이전 에이전트가 이미 수정한 파일은 건드리지 마세요**
- 당신의 담당 영역(${ap.role})에만 집중하세요

### 이전 에이전트 결과
${priorSummary}

## Worklog
이 파일을 먼저 읽으세요: ${worklog.path}
작업 완료 후 반드시 Execution Log 섹션에 결과를 기록하세요.`;

        broadcast('agent_status', {
            agentId: emp.id, agentName: emp.name,
            status: 'running', phase: ap.currentPhase, phaseLabel,
        });

        const { promise } = spawnAgent(taskPrompt, {
            agentId: emp.id, cli: emp.cli, model: emp.model,
            forceNew: true, sysPrompt, origin: meta.origin || 'web',
        });

        const r = await promise;
        const result = {
            agent: ap.agent, role: ap.role, id: emp.id,
            phase: ap.currentPhase, phaseLabel,
            status: r.code === 0 ? 'done' : 'error',
            text: r.text || '',
        };

        // phases_completed 파싱: 에이전트가 여러 phase를 한 번에 완료 선언
        const pcMatch = (r.text || '').match(/\{[\s\S]*"phases_completed"\s*:\s*\[[\d,\s]+\][\s\S]*\}/);
        if (pcMatch) {
            try {
                const pc = JSON.parse(pcMatch[0]);
                if (Array.isArray(pc.phases_completed) && pc.phases_completed.length > 1) {
                    const maxCompleted = Math.max(...pc.phases_completed);
                    const newIdx = ap.phaseProfile.findIndex(p => p > maxCompleted);
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

        results.push(result);
        broadcast('agent_status', { agentId: emp.id, agentName: emp.name, status: result.status, phase: ap.currentPhase });

        // 즉시 worklog에 기록
        appendToWorklog(worklog.path, 'Execution Log',
            `### Round ${round} — ${result.agent} (${result.role}, ${result.phaseLabel})\n- Status: ${result.status}\n- Result: ${result.text.slice(0, 500)}`
        );
    }

    return results;
}

// ─── Review Phase (per-agent verdict) ────────────────

async function phaseReview(results, agentPhases, worklog, round, meta = {}) {
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
    const { promise } = spawnAgent(reviewPrompt, { agentId: 'planning', internal: true, origin: meta.origin || 'web' });
    const evalR = await promise;

    const verdicts = parseVerdicts(evalR.text);
    return { verdicts, rawText: evalR.text };
}

// ─── Main Orchestrate v2 ─────────────────────────────

export async function orchestrate(prompt, meta = {}) {
    const origin = meta.origin || 'web';
    const employees = getEmployees.all();

    // Triage: 간단한 메시지는 직접 응답
    if (employees.length > 0 && !needsOrchestration(prompt)) {
        console.log(`[claw:triage] direct response (no orchestration needed)`);
        const { promise } = spawnAgent(prompt, { origin });
        const result = await promise;
        const stripped = stripSubtaskJSON(result.text);
        broadcast('orchestrate_done', { text: stripped || result.text || '', origin });
        return;
    }

    // 직원 없으면 단일 에이전트 모드
    if (employees.length === 0) {
        const { promise } = spawnAgent(prompt, { origin });
        const result = await promise;
        const stripped = stripSubtaskJSON(result.text);
        broadcast('orchestrate_done', { text: stripped || result.text || '', origin });
        return;
    }

    const worklog = createWorklog(prompt);
    broadcast('worklog_created', { path: worklog.path });

    // 1. 기획 (planning agent가 직접 응답할 수도 있음)
    const { planText, subtasks, directAnswer } = await phasePlan(prompt, worklog, { origin });

    // Agent 자율 판단: subtask 불필요 → 직접 응답
    if (directAnswer) {
        console.log('[claw:triage] planning agent chose direct response');
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
            broadcast('orchestrate_done', { text: summary, worklog: worklog.path, origin });
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
            broadcast('orchestrate_done', { text: partial, worklog: worklog.path, origin });
        }
    }
}

// ─── Continue (이어서 해줘) ───────────────────────────

export async function orchestrateContinue(meta = {}) {
    const origin = meta.origin || 'web';
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
${pending.map(p => `- ${p.agent} (${p.role}): Phase ${p.currentPhase}`).join('\n')}

subtask JSON을 출력하세요.`;

    return orchestrate(resumePrompt, meta);
}
