# Phase 100 — 오케스트레이션 세션 아키텍처 종합 문서

> Phase 99(토큰 캐싱) + Phase 99.1(세션 재사용) + Phase 100(종합 아키텍처)
> 작성일: 2026-02-24

---

## 1. 개요

### Phase 99 → 99.1 → 100 관계

```mermaid
graph LR
    subgraph P99["Phase 99 — 프롬프트 캐싱"]
        C1["getEmployeePromptV2()"]
        C2["promptCache Map<br/>(인메모리)"]
        C3["디스크 I/O 1회만"]
        C1 --> C2 --> C3
    end

    subgraph P991["Phase 99.1 — 세션 재사용"]
        S1["employee_sessions DB"]
        S2["resume 시 sysPrompt 스킵"]
        S3["80% 토큰 절감"]
        S1 --> S2 --> S3
    end

    subgraph P100["Phase 100 — 종합 문서"]
        D1["전체 라이프사이클 정리"]
        D2["DB 스키마 ER"]
        D3["안전장치 체크리스트"]
        D1 --> D2 --> D3
    end

    P99 -->|"첫 spawn에서<br/>여전히 필요"| P991
    P991 -->|"설계+구현 완료 후<br/>종합 정리"| P100

    style P99 fill:#ffe0b2
    style P991 fill:#c8e6c9
    style P100 fill:#bbdefb
```

- **Phase 99**: `getEmployeePromptV2()`의 SKILL.md 읽기를 인메모리 캐싱 → 같은 role Employee의 반복 디스크 I/O 제거
- **Phase 99.1**: Employee별 CLI 세션을 DB에 저장 → 다음 Phase에서 resume → sysPrompt 재주입 완전 제거
- **Phase 100**: 위 두 Phase를 포함한 전체 오케스트레이션 아키텍처를 종합 문서화

---

## 2. 쉬운 버전: 서브에이전트 호출 요약

> 초보자를 위한 단순 흐름. "사장님이 직원에게 일을 맡기는 과정"

```mermaid
flowchart TD
    A["👤 사용자가 작업 요청"] --> B["🎯 기획 에이전트가<br/>계획 수립"]
    B --> C["📋 직원 배정<br/>(Frontend, Backend, ...)"]
    C --> D["🔧 각 직원이<br/>순차적으로 작업 수행"]
    D --> E["📝 리뷰 에이전트가<br/>결과 검증"]
    E --> F{통과?}
    F -- "✅ 예" --> G["🎉 완료!<br/>결과를 사용자에게 보고"]
    F -- "❌ 아니오" --> H["🔄 피드백 반영 후<br/>다시 작업"]
    H --> D

    style A fill:#e1f5fe
    style B fill:#fff3e0
    style C fill:#f3e5f5
    style D fill:#e8f5e9
    style E fill:#fff3e0
    style G fill:#c8e6c9
    style H fill:#ffebee
```

| 단계 | 설명 |
|------|------|
| 사용자 요청 | 자연어로 작업 지시 (예: "로그인 기능 만들어줘") |
| 기획 | Planning Agent가 작업을 분석하고 직원별 subtask 생성 |
| 직원 배정 | DB에 등록된 Employee 중 role에 맞는 직원 매칭 |
| 작업 수행 | 각 직원이 Phase(기획→검증→개발→디버깅→통합) 순서로 실행 |
| 리뷰 | Quality Gate에서 각 직원의 산출물을 pass/fail 판정 |
| 완료 | 모든 직원이 모든 Phase를 통과하면 최종 요약 보고 |

---

## 3. 복잡한 버전: 전체 세션 라이프사이클

> 실제 코드 흐름을 따라간 상세 시퀀스 다이어그램

```mermaid
sequenceDiagram
    participant U as 👤 User
    participant O as orchestrate()
    participant PC as promptCache
    participant EDB as employee_sessions
    participant MDB as session (main)
    participant S as spawnAgent()
    participant CLI as CLI Process

    rect rgb(240, 240, 255)
        Note over O: ── 오케스트레이션 초기화 ──
        U->>O: 작업 요청 (prompt)
        O->>EDB: clearAllEmployeeSessions()
        O->>PC: clearPromptCache()
    end

    rect rgb(255, 248, 230)
        Note over O: ── Phase 1: phasePlan ──
        O->>S: spawnAgent(planPrompt, {agentId: 'planning'})
        S->>CLI: planning agent 실행
        CLI-->>S: subtasks[] + planText
        S-->>O: {subtasks, planText}
        O->>O: initAgentPhases(subtasks)
    end

    rect rgb(230, 255, 230)
        Note over O: ── Phase 2: distributeByPhase (Round 1) ──
        loop 각 Employee 순차 실행
            O->>EDB: getEmployeeSession(emp.id)

            alt 세션 없음 (첫 실행)
                EDB-->>O: undefined
                O->>PC: getEmployeePromptV2(emp, role, phase)
                PC-->>O: sysPrompt (캐시 HIT/MISS)
                O->>S: spawnAgent(task, {forceNew:true, sysPrompt})
                S->>CLI: 새 세션 + sysPrompt 주입
            else 세션 있음 + cli 일치
                EDB-->>O: {session_id, cli}
                O->>S: spawnAgent(task, {forceNew:false, employeeSessionId})
                Note over S: sysPrompt 생략!
                S->>CLI: resume (session load)
            end

            CLI-->>S: {code, sessionId, text}

            alt code === 0 && sessionId 존재
                S-->>O: 성공 결과
                O->>EDB: upsertEmployeeSession(emp.id, sessionId, cli)
                Note over MDB: ⛔ main session 안 건드림!
            else 실패
                S-->>O: 에러 결과
                Note over EDB: 세션 저장 안 함
            end
        end
    end

    rect rgb(255, 240, 230)
        Note over O: ── Phase 3: phaseReview ──
        O->>S: spawnAgent(reviewPrompt, {agentId: 'planning', internal: true})
        S->>CLI: 리뷰 에이전트 실행
        CLI-->>S: verdicts[] + allDone
        S-->>O: 판정 결과
        O->>O: advancePhase(ap, v.pass) — 각 agent별
    end

    rect rgb(240, 230, 255)
        Note over O: ── 완료 판정 ──
        alt allDone = true (모든 agent 완료)
            O->>EDB: clearAllEmployeeSessions()
            Note over MDB: ✅ main session 보존!
            O-->>U: 최종 요약 보고
        else 미완료 + round < MAX
            Note over O: 다음 round로 →<br/>distributeByPhase 재실행
        else MAX_ROUNDS 도달
            O-->>U: partial 요약 + "이어서 해줘" 안내
        end
    end
```

### main session vs employee session 분리 원칙

| 항목 | main session (`session` 테이블) | employee session (`employee_sessions` 테이블) |
|------|------|------|
| 소유자 | 사용자의 대화 세션 | 오케스트레이션 직원의 CLI 세션 |
| 수명 | 영구 (명시적 리셋까지) | 오케스트레이션 1회 (allDone 시 삭제) |
| 저장 주체 | `spawnAgent()` → `updateSession.run()` | `pipeline.js` → `upsertEmployeeSession.run()` |
| 삭제 조건 | 사용자 명시 요청 | `orchestrate()` 시작 + `allDone=true` |
| 안전장치 | `empSid` 있으면 `updateSession` 차단 | `clearAllEmployeeSessions`는 이 테이블만 |

---

## 4. DB 스키마 ER 다이어그램

```mermaid
erDiagram
    session {
        TEXT id PK "default"
        TEXT active_cli "claude"
        TEXT session_id "CLI 세션 ID"
        TEXT model "default"
        TEXT permissions "safe"
        TEXT working_dir "~"
        TEXT effort "medium"
        DATETIME updated_at
    }

    employees {
        TEXT id PK "emp_xxx"
        TEXT name "Frontend"
        TEXT cli "copilot"
        TEXT model "default"
        TEXT role "frontend"
        TEXT status "idle"
        DATETIME created_at
    }

    employee_sessions {
        TEXT employee_id PK "FK → employees.id"
        TEXT session_id "CLI가 반환한 세션 ID"
        TEXT cli "세션 생성 시 사용한 CLI"
        DATETIME created_at
    }

    messages {
        INTEGER id PK "AUTO"
        TEXT role "user | assistant"
        TEXT content "메시지 본문"
        TEXT cli "사용 CLI"
        TEXT model "사용 모델"
        TEXT trace "내부 추적 로그"
        REAL cost_usd "API 비용"
        INTEGER duration_ms "소요 시간"
        DATETIME created_at
    }

    memory {
        INTEGER id PK "AUTO"
        TEXT key UK "고유 키"
        TEXT value "저장 값"
        TEXT source "manual"
        DATETIME created_at
        DATETIME updated_at
    }

    employees ||--o| employee_sessions : "1:0..1 세션"
    session ||--o{ messages : "대화 기록"
```

### 테이블별 역할

| 테이블 | 용도 | 오케스트레이션 관여 |
|--------|------|-------------------|
| `session` | 사용자 메인 대화 상태 | ❌ 읽기만 (Employee가 건드리지 않음) |
| `employees` | 등록된 직원 목록 | ✅ 배정 대상 조회 |
| `employee_sessions` | 직원별 CLI 세션 ID 캐시 | ✅ 핵심 — resume/저장/삭제 |
| `messages` | 전체 대화 히스토리 | ⚠️ 오케스트레이터 요약만 저장 |
| `memory` | 영구 기억 (key-value) | ❌ 무관 |

---

## 5. 토큰 절감 파이프라인

> Phase 99(캐시) → Phase 99.1(세션) → Phase 건너뛰기: 3단 최적화

```mermaid
graph TD
    subgraph LAYER1["🔶 Layer 1: 프롬프트 캐싱 (Phase 99)"]
        L1A["getEmployeePromptV2(emp, role, phase)"]
        L1B{"promptCache에<br/>캐시 있음?"}
        L1C["디스크 I/O<br/>(SKILL.md 읽기)"]
        L1D["캐시 반환<br/>(즉시)"]
        L1A --> L1B
        L1B -- MISS --> L1C --> L1D
        L1B -- HIT --> L1D
    end

    subgraph LAYER2["🟢 Layer 2: 세션 재사용 (Phase 99.1)"]
        L2A["distributeByPhase()"]
        L2B{"employee_sessions에<br/>세션 있음?"}
        L2C["forceNew: true<br/>+ sysPrompt 주입"]
        L2D["forceNew: false<br/>+ employeeSessionId<br/>(sysPrompt 스킵!)"]
        L2A --> L2B
        L2B -- 없음 --> L2C
        L2B -- 있음 --> L2D
    end

    subgraph LAYER3["🔵 Layer 3: Phase 건너뛰기"]
        L3A["Phase 합치기 프롬프트"]
        L3B["에이전트가 여러<br/>Phase 한번에 완료"]
        L3C["phases_completed<br/>JSON 파싱"]
        L3D["남은 Phase 스킵"]
        L3A --> L3B --> L3C --> L3D
    end

    L1D -->|"첫 spawn에서<br/>sysPrompt 조립"| L2A
    L2D -->|"resume 성공 시<br/>spawn 횟수 감소"| L3A

    style LAYER1 fill:#fff3e0
    style LAYER2 fill:#e8f5e9
    style LAYER3 fill:#e3f2fd
```

### 토큰 절감 수치 비교

| 시나리오 (3 agents × 5 phases) | spawn 횟수 | sysPrompt 주입 | 총 토큰 (추정) |
|------|------|------|------|
| **최적화 없음** | 15회 | 15 × 8,500 = 127,500 chars | ~44K tokens |
| **Phase 99만** (캐시) | 15회 | 15 × 8,500 (조립은 빠르지만 주입은 동일) | ~44K tokens |
| **Phase 99 + 99.1** (캐시 + 세션) | 15회 | 3 × 8,500 = 25,500 chars | ~38K tokens |
| **99 + 99.1 + Phase 건너뛰기** | ~6회 | 3 × 8,500 = 25,500 chars | **~12K tokens** |

---

## 6. Phase별 세션 상태 변화표

> 3 agents (Frontend, Backend, Docs) 오케스트레이션 시 DB 상태 추적

### Round 1 시나리오

| 시점 | `employee_sessions` 상태 | `session` (main) | 비고 |
|------|--------------------------|------------------|------|
| `orchestrate()` 진입 | `DELETE ALL` → 빈 테이블 | 변경 없음 | 잔여 세션 정리 |
| **Phase 1: Frontend 기획** | | | |
| ├ getEmployeeSession("fe") | → undefined | — | 첫 실행 |
| ├ spawnAgent(forceNew:true) | — | — | sysPrompt 주입 |
| └ 성공 → upsert | `fe → sid_aaa (copilot)` | 변경 없음 | empSid로 main 보호 |
| **Phase 1: Backend 기획** | | | |
| ├ getEmployeeSession("be") | → undefined | — | 첫 실행 |
| ├ spawnAgent(forceNew:true) | — | — | sysPrompt 주입 |
| └ 성공 → upsert | `fe→sid_aaa, be→sid_bbb` | 변경 없음 | |
| **Phase 3: Docs 개발** | | | |
| ├ getEmployeeSession("doc") | → undefined | — | docs는 Phase 1,2 스킵 |
| ├ spawnAgent(forceNew:true) | — | — | sysPrompt 주입 |
| └ 성공 → upsert | `fe→aaa, be→bbb, doc→ccc` | 변경 없음 | |
| **Review → 각 agent PASS** | | | |
| └ advancePhase() | 테이블 변경 없음 | — | 메모리상 phase만 전진 |

### Round 2 시나리오 (세션 재사용 발동!)

| 시점 | `employee_sessions` 상태 | 비고 |
|------|--------------------------|------|
| **Phase 2: Frontend 기획검증** | | |
| ├ getEmployeeSession("fe") | → `{sid_aaa, copilot}` ✅ | 세션 있음! |
| ├ spawnAgent(employeeSessionId: "sid_aaa") | — | **sysPrompt 생략!** |
| └ 성공 → upsert | `fe→sid_aaa` (동일) | resume 성공 |
| **Phase 2: Backend 기획검증** | | |
| ├ getEmployeeSession("be") | → `{sid_bbb, codex}` ✅ | 세션 있음! |
| └ resume 성공 | `be→sid_bbb` | **토큰 절감** |
| **Phase 5: Docs 통합검증** | | |
| ├ getEmployeeSession("doc") | → `{sid_ccc, copilot}` ✅ | Docs는 3→5 (Phase 합치기) |
| └ resume 성공 | `doc→sid_ccc` | |
| **Review → allDone = true** | | |
| └ clearAllEmployeeSessions() | → 빈 테이블 | main session 보존 ✅ |

---

## 7. 안전장치 체크리스트

```mermaid
flowchart TD
    subgraph SAFETY["🛡️ 안전장치 7가지"]
        S1["① main session 보호<br/>empSid 존재 시<br/>updateSession() 차단"]
        S2["② 테이블 격리<br/>clearAllEmployeeSessions는<br/>employee_sessions만 삭제"]
        S3["③ resume 실패 fallback<br/>ACP: loadSession catch →<br/>createSession 자동 전환"]
        S4["④ CLI 불일치 방어<br/>empSession.cli ≠ emp.cli →<br/>새 세션 생성"]
        S5["⑤ 실패 세션 미저장<br/>code ≠ 0 → upsert 안 함"]
        S6["⑥ stale row 정리<br/>orchestrate() 시작마다<br/>clearAll 실행"]
        S7["⑦ continue 안전성<br/>orchestrateContinue →<br/>clearAll → 새 세션 자연 생성"]
    end

    S1 --> S2 --> S3
    S4 --> S5 --> S6 --> S7

    style S1 fill:#ffcdd2
    style S2 fill:#ffcdd2
    style S3 fill:#c8e6c9
    style S4 fill:#c8e6c9
    style S5 fill:#fff9c4
    style S6 fill:#fff9c4
    style S7 fill:#bbdefb
```

| # | 위험 | 대책 | 구현 위치 | 검증 방법 |
|---|------|------|----------|----------|
| ① | Employee 세션이 main session 덮어쓰기 | `empSid` 존재 시 `updateSession()` 차단 | `spawn.js` (close/exit 핸들러) | 정적 코드 검사 |
| ② | main session 삭제 | `clearAllEmployeeSessions`는 `employee_sessions`만 대상 | `db.js` prepared statement | DB 단위 테스트 |
| ③ | resume 실패 (만료/무효 세션) | ACP: `loadSession` → catch → `createSession` fallback | `spawn.js` ACP 브랜치 | 통합 테스트 |
| ④ | CLI 변경 (copilot→codex 등) | `empSession.cli !== emp.cli` → `canResume=false` | `pipeline.js` distributeByPhase | 조건 분기 테스트 |
| ⑤ | 실패한 세션 재사용 | `r.code === 0` 일 때만 `upsert` | `pipeline.js` 결과 처리 | 정적 검사 |
| ⑥ | 이전 오케스트레이션 잔여 세션 | `orchestrate()` 시작 시 `clearAllEmployeeSessions()` | `pipeline.js` 진입점 | DB 테스트 |
| ⑦ | "이어서 해줘" 호출 시 stale 세션 | `orchestrateContinue()` → `orchestrate()` → clearAll | `pipeline.js` | 흐름 테스트 |

---

## 8. Resume 실패 시 자동 fallback 흐름

```mermaid
flowchart TD
    START["distributeByPhase()"] --> QUERY{"getEmployeeSession(emp.id)<br/>결과?"}
    QUERY -- "undefined (첫 실행)" --> NEW["forceNew: true<br/>sysPrompt 전체 주입<br/>새 세션 생성"]
    QUERY -- "session_id 존재" --> CLIMATCH{"cli 일치?"}
    CLIMATCH -- "불일치" --> NEW
    CLIMATCH -- "일치" --> RESUME["forceNew: false<br/>employeeSessionId 전달<br/>resume 시도"]

    RESUME --> RESUMEOK{"resume 성공?"}
    RESUMEOK -- "성공 (code=0)" --> SAVE["upsertEmployeeSession(emp.id, sid, cli)"]
    RESUMEOK -- "실패" --> CLIFB["CLI 자체 fallback<br/>(ACP: loadSession catch →<br/>createSession)"]
    CLIFB --> NEWSAVE["새 sessionId로 저장"]

    NEW --> RUN["CLI 실행"]
    RUN --> RUNOK{"code === 0?"}
    RUNOK -- "성공" --> SAVE2["upsertEmployeeSession()"]
    RUNOK -- "실패" --> SKIP["세션 저장 안 함<br/>(다음 시도에서 새 세션)"]

    style SAVE fill:#c8e6c9
    style SAVE2 fill:#c8e6c9
    style NEWSAVE fill:#c8e6c9
    style SKIP fill:#ffcdd2
```

---

## 검증 포인트 (테스트 매핑)

| 검증 항목 | 테스트 파일 |
|----------|-----------|
| employee_sessions 테이블 존재 | `tests/employee-session.test.js` #1 |
| getEmployeeSession 빈 조회 | `tests/employee-session.test.js` #2 |
| upsertEmployeeSession 저장/조회 | `tests/employee-session.test.js` #3, #4 |
| clearAllEmployeeSessions 전체 삭제 | `tests/employee-session.test.js` #5 |
| main session 보호 | `tests/employee-session.test.js` #6 |
| Phase 합치기 프롬프트 | `tests/employee-session.test.js` #7 |
| pipeline employeeSessionId 분기 | `tests/phase-100/employee-session-reuse.test.js` #1 |
| spawn empSid main 차단 | `tests/phase-100/employee-session-reuse.test.js` #2 |
| db clearAll export | `tests/phase-100/employee-session-reuse.test.js` #3 |
