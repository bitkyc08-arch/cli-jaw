---
created: 2026-03-28
tags: [cli-jaw, prompt, cache, system-prompt]
aliases: [B prompt cache, CLI-JAW B prompt, regenerated prompt]
---

> 📚 [INDEX](INDEX.md) · [프롬프트 흐름 ↗](prompt_flow.md) · [A1](prompt_basic_A1.md) · [A2](prompt_basic_A2.md) · **B 조립 결과**

# prompt_basic_B — 조립 결과 + 스킬/MCP/하트비트 기본값

> B.md = `getSystemPrompt({ forDisk: true })` 결과 캐시
> 경로: `~/.cli-jaw/prompts/B.md` + `{workDir}/AGENTS.md`
> 구현: `src/prompt/builder.ts` → `getSystemPrompt()` + `regenerateB()`
> 관련 템플릿: `a1-system.md` (283L), `a2-default.md` (25L), `orchestration.md` (95L), `heartbeat-jobs.md` (4L), `heartbeat-default.md` (4L), `skills.md` (18L), `employee.md` (86L), `worker-context.md` (11L), `control-system.md` (56L), `vision-click.md` (3L)

---

## 현재 생성 경로

`regenerateB()`는 캐시를 지우고 `getSystemPrompt({ forDisk: true })`를 다시 조립한 뒤 두 곳에 저장한다.

| 출력 대상 | 역할 |
|---|---|
| `~/.cli-jaw/prompts/B.md` | 디스크 캐시 |
| `{workDir}/AGENTS.md` | 현재 워크스페이스용 지침 파일 |

`AGENTS.md`는 Codex, Copilot, OpenCode가 직접 읽는 런타임 지침이라서, B.md와 같은 본문을 공유한다.

---

## 조립 순서

현재 `getSystemPrompt({ forDisk: true })`의 실제 순서는 다음과 같다.

1. `A-1.md` 파일 우선, 없으면 `a1-system.md` 렌더 결과
2. `A-2.md` 파일 우선, 없으면 빈 문자열
3. legacy 세션 메모리 보강 (`appendLegacyMemoryContext()`)
4. `MEMORY.md` 코어 메모리
5. forDisk 전용 `## Core Memory` 보강 — `loadProfileSummary(600)` + `buildTaskSnapshot('current session context', 1500)` 결과를 추가 (advanced memory가 준비된 경우에만)
6. 직원이 있을 때 orchestration prompt + PABCD guide
7. 활성 heartbeat job이 있을 때 heartbeat 섹션 (`heartbeat.json` 기준)
8. active skills + reference skills 섹션
9. Codex 활성 CLI일 때 vision-click legacy fallback hint
10. delegation rules

이전 버전에 있던 timestamp stamp는 현재 `getSystemPrompt()`에서 제거됐다.

---

## 현재 핵심 동작

### Memory

- `appendLegacyMemoryContext()`는 `flushEvery`의 절반 간격으로 최근 세션 메모리를 주입한다
- `forDisk: true` 경로는 advanced memory injection 블록(`## Memory Runtime`)은 쓰지 않지만, 끝부분에 `loadProfileSummary(600)` + `buildTaskSnapshot('current session context', 1500)` 결과를 `## Core Memory` 아래에 덧붙인다
- `MEMORY.md`는 50자 이상일 때만 읽고, 1500자를 넘으면 잘라서 넣는다

### Orchestration

- 직원이 1명 이상이면 `orchestration.md`가 렌더된다
- 그 뒤에 `dev-pabcd/SKILL.md`가 있으면 `PABCD Orchestration Guide`가 추가된다
- `Completion Protocol`은 orchestration 템플릿 내부에 포함된 현재 규칙이다

### Heartbeat

- 잡이 1개 이상이면 `heartbeat-jobs.md`가 붙는다
- 각 잡은 enabled 상태와 스케줄 설명, 앞부분 prompt 미리보기를 포함한다
- `HEARTBEAT.md`는 별도 편집 파일로 유지되지만, 현재 B 조립에는 직접 포함되지 않는다

### Skills

- active skills는 `{{JAW_HOME}}/skills/`
- reference skills는 `{{JAW_HOME}}/skills_ref/registry.json`
- 둘 중 하나만 있어도 `Skills System` 섹션이 생성된다

### Vision Click

- active CLI가 `codex`일 때만 `vision-click.md`가 추가된다
- 이는 `snapshot`에 ref가 없을 때만 쓰는 fallback 힌트를 제공한다
- 현재 의미는 범용 브라우저 제어가 아니라 Codex provider(`codex exec -i`) 기반 legacy fallback이다. 일반 DOM/Web UI 작업은 빠른 `cli-jaw browser` 경로를 우선하고, desktop/non-DOM 작업은 Codex/Control의 Computer Use 경로를 우선한다.

### Delegation Rules

- Boss는 `cli-jaw dispatch`로 jaw employees를 보낸다
- CLI sub-agents는 내부 병렬 작업용이다
- 둘은 서로 다른 시스템이며, 서로를 대체하지 않는다
- 이 규칙 블록은 orchestration 템플릿이 없어도 항상 B 프롬프트 끝에 붙는다

---

## Employee Prompt

`getEmployeePromptV2()`는 boss prompt와 별개로 직원용 추가 레이어를 쌓는다.

- static employee system patch + declared skill inline injection (예: `Control` → `control-system.md` + `desktop-control` skill)
- 공통 `dev/SKILL.md`
- `dev-scaffolding`
- role별 skill (`dev-frontend`, `dev-backend`, `dev-data`, `documentation`)
- phase 2일 때 `dev-code-reviewer`
- phase 4일 때 `dev-testing`
- `worker-context.md`에서 phase별 worker context 추출 (Phase 1~4)
- 실행 규칙 + delegation 규칙: `cli-jaw dispatch`와 subtask JSON은 금지지만, CLI 자체 sub-agent(Task/Agent tool)는 내부 병렬 작업용으로 명시적으로 허용

이 구조 때문에 B.md는 단순한 "완성본"이 아니라, 현재 시스템 프롬프트가 어떻게 합성되는지 보여주는 캐시 스냅샷이다. forDisk 경로가 advanced `## Memory Runtime` 블록 대신 legacy fallback + 축약 profile/snapshot 보강을 사용한다는 점은 같이 봐야 한다.
