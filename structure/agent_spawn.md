---
created: 2026-03-28
tags: [cli-jaw, agent-runtime, orchestration, acp]
aliases: [CLI-JAW Agent Spawn, agent runtime, ACP orchestration]
---

> 📚 [INDEX](INDEX.md) · **동기화 체크리스트** · [커맨드](commands.md) · [서버 API](server_api.md) · [str_func](str_func.md)

# Agent Spawn — agent/ · orchestrator/ · cli/acp-client

> CLI spawn + ACP 분기 + 스트림 + 큐 + 메모리 flush + PABCD 오케스트레이션
> 현재 기준: `src/agent/*` 12개 파일, `src/orchestrator/*` 10개 파일, `src/cli/acp-client.ts`

---

## src/agent/* — Spawn & Session

| File | Line count | Role |
| --- | ---: | --- |
| `src/agent/args.ts` | 104L | CLI별 신규/재개 인자 생성 |
| `src/agent/error-classifier.ts` | 23L | stderr/result 기반 에러 분류 helper |
| `src/agent/events.ts` | 1418L | NDJSON 파서 + ACP `session/update` / subagent lifecycle 매핑 |
| `src/agent/lifecycle-handler.ts` | 395L | child lifecycle, fallback, retry, queue resume orchestration |
| `src/agent/live-run-state.ts` | 53L | active run snapshot / hydrate helper |
| `src/agent/memory-flush-controller.ts` | 157L | memory flush lock + post-response trigger |
| `src/agent/opencode-diagnostics.ts` | 155L | OpenCode binary/permission 점검 + raw event 버퍼 |
| `src/agent/resume-classifier.ts` | 51L | stale resume 판별 |
| `src/agent/session-persistence.ts` | 70L | main session persistence gate |
| `src/agent/smoke-detector.ts` | 141L | smoke response 감지 + auto-continue 판단 |
| `src/agent/spawn-env.ts` | 120L | OpenCode/Gemini 전용 env/permission 보정 |
| `src/agent/spawn.ts` | 1439L | spawn/ACP/stream/DB/broadcast + queue drain 핵심 |

### `spawn.ts` 핵심 흐름

```text
실행 중 체크 → cli/model/effort 결정 (opts → activeOverrides → perCli → default) → origin 설정
→ mainManaged / employeeSessionId / forceNew 판정
→ resume면 buildResumeArgs, 아니면 buildArgs
→ history는 `working_dir` 스코프 + legacy `NULL` row fallback으로 조회
→ employee spawn이면 tmp cwd + AGENTS.md/CLAUDE.md/GEMINI.md/CONTEXT.md + .claude/CLAUDE.md 주입
→ copilot면 ACP branch, 아니면 일반 stdio branch
→ 종료 시 session 저장 / smoke auto-continue / fallback retry / processQueue
```

- `buildHistoryBlock(currentPrompt, workingDir)`는 `getRecentMessages.all(workingDir || null, ...)`로 최근 기록을 읽고, `isCompactMarkerRow()`를 만나면 `row.trace` 요약을 넣은 뒤 중단한다. SQL은 `working_dir = ? OR working_dir IS NULL`이고, 누적 상한은 `maxTotalChars = 8000`이다.
- `workingDir`는 히스토리 조회, 메시지 저장, 세션 persistence, 메모리 flush의 공통 스코프다. `cleanupEmployeeTmpDir()`는 `cwd !== workingDir`일 때만 임시 디렉터리를 지운다.
- `opts.agentId`가 있고 `sysPrompt`가 있으면 employee 전용 tmp cwd를 만들고 `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONTEXT.md`, `.claude/CLAUDE.md`를 모두 덮어쓴다.
- `enqueueMessage()`는 queue push 직후 `processQueue()`를 즉시 한 번 더 호출한다. 게이트웨이의 busy 체크 직후 agent가 종료해 close handler가 빈 큐를 본 경우를 다시 잡기 위한 race fix다.
- `processQueue()`는 `queueProcessing` 플래그와 `queueMicrotask(() => processQueue())` 재드레인으로 중복 drain을 막고, `source+target` 첫 그룹만 처리한 뒤 나머지를 다시 큐에 넣는 fair policy를 유지한다.
- `processQueue()`는 `let inserted = false` 플래그 패턴으로 race condition을 방지한다. `insertMessage.run()`이 아직 실행되지 않았다면 실패 시 requeue가 안전하고, `insertMessage.run()` 이후 setup이 실패하면 broadcast error만 보내고 requeue하지 않아 메시지 중복을 막는다.
- `killProcessTree()`는 `execSync` 대신 `execFileSync`를 사용한다. shell injection 방지를 위해 pid를 문자열 인자로 넘기고, shell을 경유하지 않는다.

### Copilot ACP branch

- `~/.copilot/config.json`에 `model`과 `reasoning_effort`를 먼저 동기화한다. `model === 'default'`면 model 저장은 건너뛴다.
- `AcpClient({ model, workDir: spawnCwd, permissions, env })`를 생성하고, `initialize()` 후 `isResume`면 `loadSession(resumeSessionId)`를 시도한다.
- `loadSession()`이 성공하면 replay 모드를 켜서 `session/update`를 무시하고, `ctx.fullText`, `ctx.toolLog`, `ctx.seenToolKeys`, `ctx.thinkingBuf`를 모두 비운다.
- `loadSession()`이 실패하면 `createSession(spawnCwd)`로 새 세션을 만든 뒤, `needsHistoryFallback`일 때만 `withHistoryPrompt()`로 히스토리를 다시 붙인다.
- `session/update`는 `extractFromAcpUpdate()`로 변환되고, 💭는 버퍼링, non-💭 tool은 `icon:label:stepRef:status` 기준으로 dedupe, 텍스트는 `ctx.fullText`에 누적된다.
- Copilot ACP subagent/task wire shape은 별도 `subagent.*` 이벤트가 아니라 `session/update`의 `tool_call` + `rawInput.agent_type === 'task'`다. 이때 `toolCallId`를 `ctx.acpSubagentToolCallIds`와 `ctx.acpSubagentLabels`에 저장하고, matching `tool_call_update`를 같은 `acp:callid:{toolCallId}` step으로 done/error 갱신한다.
- `stderr_activity`는 진단용 버퍼를 채우고, 가시적 progress가 오래 없으면 `agent_tool`로 ⏳ heartbeat를 보낸다.
- `acp.shutdown()` 전에 `persistMainSession()`를 먼저 호출한다. 이 경로는 SIGTERM으로 종료되기 때문에, 사전 저장하지 않으면 세션 연속성이 끊긴다.

### Standard CLI branch

- `claude`는 stdin에 `withHistoryPrompt(prompt, historyBlock)`를 직접 쓴다.
- `codex`는 resume가 아닐 때만 stdin에 `[User Message]` 블록을 쓴다.
- `gemini`와 `opencode`는 `promptForArgs = withHistoryPrompt(prompt, historyBlock)`를 받아 인자 레벨에서 prompt/history를 합친다.
- stdout NDJSON은 `logEventSummary()` → `extractSessionId()` → `extractFromEvent()` → `extractOutputChunk()` 순으로 처리된다.
- `shouldInvalidateResumeSession()`가 true면 `updateSession.run(cli, null, model, settings.permissions, settings.workingDir, ...)`로 stale resume을 지운다.
- smoke response가 감지되면 세션을 먼저 저장하고, `buildContinuationPrompt()`로 같은 엔진에 재스폰한다.

### Session persistence / resume classifier

| File | Line count | Role |
| --- | ---: | --- |
| `src/agent/session-persistence.ts` | 70L | `ownerGeneration` 가드 + bucket-aware `updateSession.run()` 래퍼 |
| `src/agent/resume-classifier.ts` | 51L | CLI별 stale session regex |

- `persistMainSession()`는 `forceNew`, `employeeSessionId`, `!sessionId`, `isFallback`, 비정상 exit를 모두 차단한다.
- 저장할 때는 `cli`, `sessionId`, `model`, `permissions`, `workingDir`, `effort`를 같이 기록한다.
- `shouldInvalidateResumeSession()`는 `code === 0`이면 무조건 false이고, 실패한 stderr/resultText에서 generic matcher + CLI별 matcher를 함께 검사한다.
- resume 무효화 조건은 `claude`, `codex`, `gemini`, `opencode`, `copilot` 각각 따로 분기된다. copilot은 `session not found`와 `loadSession failed`를 본다.

---

## src/cli/acp-client.ts — Copilot ACP JSON-RPC Client (348L)

| Method | Role |
| --- | --- |
| `buildSpawnArgs()` | `--acp` + model + permission flags |
| `spawn()` | `copilot --acp` 생성 + stdout NDJSON 파싱 |
| `request()` | JSON-RPC request/response |
| `requestWithActivityTimeout()` | idle + absolute 이중 타임아웃 |
| `_handleLine()` | response / notification / agent request 분기 |
| `initialize()` | protocolVersion 1 handshake |
| `createSession()` | `session/new` |
| `loadSession()` | `session/load` |
| `prompt()` | `session/prompt` + activity timeout |
| `shutdown()` | `shutdown` 후 kill |

### ACP 세부

- `permissions === 'auto'` 또는 `'yolo'`이면 `--allow-all-tools --allow-all-paths --allow-all-urls`를 붙인다.
- `spawn()`은 `cwd: workDir`, `stdio: ['pipe', 'pipe', 'pipe']`, `env: { ...process.env, ...env }`로 띄운다.
- stdout은 readline NDJSON 파서로 읽고, stderr는 debug/heartbeat 용도로만 다룬다.
- `_handleLine()`는 유효한 JSON-RPC 메시지마다 `_activityPing()`을 호출해서 idle timer를 리셋한다.
- `session/request_permission`은 항상 자동 승인한다.
- `prompt()`의 activity timeout은 idle 1200000ms, max 14400000ms다.
- `createSession()`과 `loadSession()` 모두 성공 시 `this.sessionId`를 갱신한다. 현재 문맥에서 `AcpClient` 생성자는 `{ model, workDir, permissions, env }`만 받고, 별도 `mcpServers` 인자를 직접 넘기지 않는다.

---

## src/orchestrator/* — PABCD Orchestration

| File | Line count | Role |
| --- | ---: | --- |
| `src/orchestrator/collect.ts` | 65L | orchestrate 결과 수집 |
| `src/orchestrator/distribute.ts` | 485L | employee dispatch + parallel safety |
| `src/orchestrator/gateway.ts` | 153L | queue / intent gateway |
| `src/orchestrator/parser.ts` | 181L | legacy subtask JSON 파서 + intent matcher + numeric reference + verdict 파서 |
| `src/orchestrator/pipeline.ts` | 436L | PABCD sole entry point |
| `src/orchestrator/scope.ts` | 17L | scope stub — 항상 `'default'` 반환 |
| `src/orchestrator/state-machine.ts` | 343L | PABCD state + prompts + audit/verification verdict |
| `src/orchestrator/worker-monitor.ts` | 58L | stall/disconnect/timeout monitor |
| `src/orchestrator/worker-registry.ts` | 167L | worker ownership + replay registry |
| `src/orchestrator/workspace-context.ts` | 65L | task에서 repo path hint 추출, project root resolve |

### `pipeline.ts` 실제 흐름

```text
orchestrate(prompt, meta)
  ├─ pending worker replay drain
  ├─ scope resolution (`workingDir` 포함) + current state read
  ├─ PABCD entry는 explicit only
  ├─ 첫 planning turn이면 `getStatePrompt('P')` + 원본 요청 조합
  ├─ prompt prefix injection
  ├─ `buildMemoryInjection()`에서 boss snapshot 추출
  ├─ spawnAgent(prompt, { origin, _skipInsert, memorySnapshot })
  └─ result broadcast + worklog/state update
```

- PABCD 진입은 이제 명시적이다. `orchestrate()`는 `/orchestrate`, `/pabcd`, 혹은 LLM tool call에서만 들어온다고 전제하고, auto-entry / auto-advance 로직은 없다.
- `orchestrate()`는 실행 전에 `listPendingWorkerResults()`를 먼저 비우고, `claimWorkerReplay()` 성공한 항목만 재주입한다.
- 첫 planning turn에서는 `getStatePrompt('P')`와 `User request` 블록을 조합해 planning prompt를 만든다.
- `state === 'P'`이고 `ctx.plan`이 비어 있으면 `resolveNumericReference()`로 "1번", "2번" 같은 사용자 지시를 직전 assistant numbered list에서 본문으로 치환하고, 매칭이 모호하면 `orchestrate_done`으로 확인 요청을 보내고 종료한다.
- `buildApprovedPlanPromptBlock()`이 `A/B/C` 상태에서 `ctx.plan`을 prompt 최상단에 붙여 worker가 plan을 재구성하지 못하도록 잠근다.
- `memorySnapshot`은 `buildMemoryInjection()`의 advanced snapshot 경로를 재사용해 boss turn에서만 붙인다.
- `orchestrateContinue()`는 active PABCD면 `"Please continue from where you left off."`로 이어가고, IDLE이면 최신 worklog가 `done/reset`이 아닐 때만 worklog-based resume를 한다.
- `orchestrateReset()`는 active agent / worker / queue / worker registry / employee session / state / worklog status를 모두 reset한다.

### Worker registry / monitor

- `claimWorker()`는 worker 슬롯을 `running` 상태로 등록하고, `finishWorker()`는 `done + pendingReplay=true`로 바꾼다.
- `claimWorkerReplay()` / `markWorkerReplayed()` / `releaseWorkerReplay()`로 replay를 관리한다. replay 실패는 3회까지 재시도한다.
- `startWorkerMonitor()`는 `stallThresholdMs: 120_000`, `maxDurationMs: 600_000` 기준으로 stall / disconnect / timeout 콜백을 쏜다.
- `touch()`는 `stdout | stderr | acp | heartbeat` 이벤트마다 호출되고, stall 상태를 해제한다.
- `exit(code)`는 `code !== 0 || code === null`일 때만 disconnect 콜백을 보낸다.

### State machine

- `OrcStateName`은 `IDLE | P | A | B | C | D` 6개. `OrcContext`는 `auditStatus`(pending/pass/fail), `verificationStatus`(pending/done/needs_fix), `userApproved`, `worklogPath`, `planHash`, `planUpdatedAt`, `taskAnchor`, `resolvedSelection`까지 포함한다.
- `getCtx()`는 `workingDir`가 빠진 구형 ctx를 읽어도 `workingDir: null`로 보정한다.
- `setState()`는 worklog title을 최대 두 단어 + ellipsis로 자르고, fallback title은 `PABCD`다.
- 상태 프롬프트는 이제 승인 시 `cli-jaw orchestrate A/B/C/D`를 명시적으로 실행하라고 말한다.

### Parser (`orchestrator/parser.ts`)

- `isContinueIntent` / `isResetIntent` / `isApproveIntent`로 한국어·영어 짧은 명령을 매칭한다.
- `parseSubtasks()` / `parseDirectAnswer()` / `stripSubtaskJSON()`은 patch3 이후 deprecated이지만 하위 호환용으로 남아 있다. `pipeline.ts`는 P 상태 plan 추출 시 `stripSubtaskJSON()`만 사용한다.
- `resolveNumericReference()`는 직전 assistant 메시지의 numbered list에서 항목을 찾는다.
- `parseVerdicts()`는 fenced/raw JSON 양쪽으로 verdict 객체를 추출한다.

### Scope

- `resolveOrcScope()`와 `findActiveScope()`는 항상 `'default'`를 반환한다. 다중 scope 분기는 제거됐고, pipeline은 이 상수를 직접 사용한다.

---

## prompt/builder.ts — System Prompt & Skills (674L)

| Function | Role |
| --- | --- |
| `loadActiveSkills()` | 활성 스킬 로드 |
| `loadSkillRegistry()` | skills_ref registry 로드 |
| `getMergedSkills()` | active + ref 병합 |
| `initPromptFiles()` | A-1/A-2/HEARTBEAT 프롬프트 초기화 + A1 hash migration |
| `getSystemPrompt()` | 메인 시스템 프롬프트 구성 |
| `loadRecentMemories()` | flush memory 로드 |
| `getEmployeePrompt(emp)` | 경량 실행자 프롬프트 |
| `getEmployeePromptV2(emp, role, phase)` | v2 employee prompt |
| `regenerateB()` | B 프롬프트 + workspace `AGENTS.md` 재생성 |

### promptCache 키

`emp:role:phase:workingDir` 4-segment 키를 쓴다. `workingDir`가 들어가므로 프로젝트 전환 시 캐시가 자동으로 분리된다.

### 현재 프롬프트/오케스트레이션 드리프트 메모

- Boss prompt는 더 이상 subtask JSON dispatch를 설명하지 않는다. 현재 기본 경로는 `cli-jaw dispatch --agent ... --task ...`다.
- `orchestrator/parser.ts`에는 legacy `parseSubtasks` / `parseDirectAnswer` / `stripSubtaskJSON`이 남아 있지만, `pipeline.ts`는 이 중 `stripSubtaskJSON`만 plan 추출 단계에서 사용한다.
- employee prompt는 `getEmployeePromptV2()`가 phase/role-aware skill을 덧붙이고, `cli-jaw dispatch`와 subtask JSON 출력만 금지한다. CLI 자체 sub-agent(Task/Agent tool)는 employee 내부 병렬화 용도로 명시적으로 허용된다.
