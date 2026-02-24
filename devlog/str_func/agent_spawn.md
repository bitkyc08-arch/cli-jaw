# Agent Spawn — agent.js · events.js · orchestrator.js

> CLI spawn + 스트림 + 큐 + 메모리 flush + 멀티에이전트 오케스트레이션

---

## agent.js — CLI Spawn & Queue (409L)

| Function                                   | 역할                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| `killActiveAgent(reason)`                  | SIGTERM → SIGKILL 종료                               |
| `steerAgent(newPrompt, source)`            | kill → 대기 → 새 프롬프트로 restart                  |
| `enqueueMessage(prompt, source)`           | 큐에 메시지 추가                                     |
| `buildHistoryBlock(currentPrompt, ...)`    | **Phase 6** — DB에서 최신 trace 기반 히스토리 8000자 |
| `withHistoryPrompt(prompt, historyBlock)`  | **Phase 6** — 히스토리 + 프롬프트 조합               |
| `buildArgs(cli, model, effort, prompt, …)` | 신규 세션용 CLI args                                 |
| `buildResumeArgs(…)`                       | resume용 args                                        |
| `spawnAgent(prompt, opts)`                 | **핵심** — spawn/stream/DB/broadcast                 |
| `triggerMemoryFlush()`                     | threshold개 메시지 요약 → 메모리 파일 (줄글 1-3문장) |
| `flushCycleCount`                          | flush 사이클 카운터 (x2 주입용)                      |

### spawnAgent 흐름 (Phase 6 업데이트)

```text
실행 중 체크 → cli/model/effort 결정 → resume or new args
→ buildHistoryBlock(prompt) ← 신규 세션만, resume 제외
→ child spawn → CLI별 stdin 주입:
  - Claude: withHistoryPrompt (system은 --append-system-prompt)
  - Codex: 히스토리 + [User Message] (system은 AGENTS.md)
  - Gemini/OpenCode: args에 히스토리 포함
→ stdout NDJSON 파싱 + logEventSummary → ctx.traceLog 누적
→ 종료: insertMessageWithTrace / session 저장 / processQueue
```

### 메모리 flush 상세

- `triggerMemoryFlush()`: `forceNew` spawn → 메인 세션 분리
- threshold개 메시지만 요약 (줄글 1-3문장)
- `flushCycleCount`로 x2 주입 시점 추적

---

## events.js — NDJSON Event Parsing + Trace (185L)

| Function                                        | 역할                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| `extractSessionId(cli, event)`                  | CLI별 세션 ID 추출                                |
| `extractFromEvent(cli, event, ctx, agentLabel)` | 이벤트 → UI 데이터 변환                           |
| `extractToolLabel(cli, event)`                  | 툴 사용 라벨 추출                                 |
| `logEventSummary(agentLabel, cli, event, ctx)`  | **Phase 6** — 이벤트별 한 줄 로그 + traceLog 누적 |
| `pushTrace(ctx, line)`                          | ctx.traceLog에 라인 추가                          |
| `logLine(line, ctx)`                            | console.log + pushTrace 동시                      |
| `toSingleLine(text)` / `toIndentedPreview()`    | 포맷팅 헬퍼                                       |

### CLI별 이벤트 매핑

| CLI      | 이벤트 타입                         |
| -------- | ----------------------------------- |
| claude   | `system` / `assistant` / `result`   |
| codex    | `thread.started` / `item.completed` |
| gemini   | `init` / `message` / `result`       |
| opencode | `text` / `step_finish`              |

### logEventSummary 출력 예시

```text
[main] cmd: /bin/zsh -lc 'cli-claw memory list' → exit 0
  MEMORY.md  0.1 KB  2026-02-23
[main] reasoning: Planning detailed procedure saving
[main] agent: 프로젝트 구조를 분석하고...
[main] tokens: in=1,515,404 (cached=1,200,000) out=12,555
```

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
