# Agent Spawn — agent.js · events.js · orchestrator.js

> CLI spawn + 스트림 + 큐 + 메모리 flush + 멀티에이전트 오케스트레이션

---

## agent.js — CLI Spawn & Queue (363L)

| Function                                   | 역할                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| `killActiveAgent(reason)`                  | SIGTERM → SIGKILL 종료                               |
| `steerAgent(newPrompt, source)`            | kill → 대기 → 새 프롬프트로 restart                  |
| `enqueueMessage(prompt, source)`           | 큐에 메시지 추가                                     |
| `buildArgs(cli, model, effort, prompt, …)` | 신규 세션용 CLI args                                 |
| `buildResumeArgs(…)`                       | resume용 args                                        |
| `spawnAgent(prompt, opts)`                 | **핵심** — spawn/stream/DB/broadcast                 |
| `triggerMemoryFlush()`                     | threshold개 메시지 요약 → 메모리 파일 (줄글 1-3문장) |
| `flushCycleCount`                          | flush 사이클 카운터 (x2 주입용)                      |

### spawnAgent 흐름

```text
실행 중 체크 → cli/model/effort 결정 → resume or new args
→ child spawn → stdin 주입 (context + prompt + history)
→ stdout NDJSON 파싱 → 종료: session 저장 / agent_done / processQueue
```

### 메모리 flush 상세

- `triggerMemoryFlush()`: `forceNew` spawn → 메인 세션 분리
- threshold개 메시지만 요약 (줄글 1-3문장)
- `flushCycleCount`로 x2 주입 시점 추적

---

## events.js — NDJSON Event Extraction (96L)

| Function                                        | 역할                    |
| ----------------------------------------------- | ----------------------- |
| `extractSessionId(cli, event)`                  | CLI별 세션 ID 추출      |
| `extractFromEvent(cli, event, ctx, agentLabel)` | 이벤트 → UI 데이터 변환 |
| `extractToolLabel(cli, event)`                  | 툴 사용 라벨 추출       |

### CLI별 이벤트 매핑

| CLI      | 이벤트 타입                         |
| -------- | ----------------------------------- |
| claude   | `system` / `assistant` / `result`   |
| codex    | `thread.started` / `item.completed` |
| gemini   | `init` / `message` / `result`       |
| opencode | `text` / `step_finish`              |

---

## orchestrator.js — Multi-Agent (130L)

| Function                      | 역할                         |
| ----------------------------- | ---------------------------- |
| `parseSubtasks(text)`         | 텍스트 → JSON subtask 파싱   |
| `stripSubtaskJSON(text)`      | subtask JSON 제거            |
| `distributeAndWait(subtasks)` | 서브태스크 분배 + 완료 대기  |
| `orchestrate(prompt)`         | **메인** — MAX 3 라운드 실행 |

### 오케스트레이션 플로우

```text
직원 0명 → 단일 agent (bypass)
직원 1+명:
  planning 먼저 실행 → JSON subtask 파싱
  → distribute → 각 직원 spawnAgent
  → 보고 수집 → 재평가 (최대 3라운드)
```

---

## prompt.js — System Prompt & Skills (413L)

| Function                 | 역할                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `loadActiveSkills()`     | 활성 스킬 로드                                                                             |
| `loadSkillRegistry()`    | 스킬 레지스트리 로드                                                                       |
| `getMergedSkills()`      | 번들 + 사용자 스킬 병합                                                                    |
| `initPromptFiles()`      | A-1, A-2, HEARTBEAT 프롬프트 초기화                                                        |
| `getSystemPrompt()`      | A-1 + A-2 + MEMORY.md + session memory + skills + employees + heartbeat + vision-click힌트 |
| `loadRecentMemories()`   | flush 메모리 최신순 로드 (10000자 제한)                                                    |
| `getSubAgentPrompt(emp)` | 실행자용 경량 프롬프트                                                                     |
| `regenerateB()`          | B 프롬프트 재생성                                                                          |
