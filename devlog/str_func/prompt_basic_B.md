# prompt_basic_B — 조립 결과 + 스킬/MCP/하트비트 기본값

> B.md = `getSystemPrompt()` 결과 캐시
> 경로: `~/.cli-claw/prompts/B.md` + `{workDir}/AGENTS.md`
> 소스: `src/prompt/builder.js` → `regenerateB()` (L502–523)
> Phase 20.6: `src/prompt.js` → `src/prompt/builder.js` 이동

---

## B.md 조립 순서

```
┌──────────────────────────────────────────────────┐
│ getSystemPrompt() 조립 순서 (builder.js L250–396)│
├──────────────────────────────────────────────────┤
│ 1. A-1.md (시스템 규칙)                  ← 항상  │
│    └ 파일 우선, A1_CONTENT 폴백                  │
│ 2. A-2.md (사용자 설정)                  ← 항상  │
│ 3. Session Memory                        ← 조건  │
│    └ counter % ⌈threshold/2⌉ === 0 일 때        │
│ 4. MEMORY.md (Core Memory)               ← 항상  │
│    └ 50자↑, 1500자 제한                          │
│ 5. Employees + Orchestration             ← 조건  │
│    └ 직원 1+ 명 등록 시                          │
│    └ ★ Completion Protocol 포함 (NEW)            │
│ 6. Heartbeat Jobs                        ← 조건  │
│    └ 잡 1+ 개 등록 시                            │
│ 7. Skills (Active + Ref + Discovery)     ← 조건  │
│    └ 스킬 1+ 개 있을 때                          │
│ 8. Vision Click Hint                     ← 조건  │
│    └ Codex CLI + vision-click 스킬              │
├──────────────────────────────────────────────────┤
│ → B.md 저장  (디버그용)                           │
│ → {workDir}/AGENTS.md  (Codex/Copilot/OpenCode)  │
│ → session_id = null  (세션 무효화)                │
└──────────────────────────────────────────────────┘
```

### regenerateB() 호출 시점 (server.js, 10곳)

| 호출 위치 | 트리거 |
|---|---|
| L95 | 서버 시작 |
| L277 | 설정 저장 (`applySettingsPatch`) |
| L311 | CLI 전환 |
| L428 | 직원 생성 |
| L629, L641, L647 | 직원 삭제/수정 |
| L692 | 스킬 변경 |

---

## Orchestration 프롬프트 (NEW — Completion Protocol)

`getSystemPrompt()`에서 직원 1+명일 때 주입 (builder.js L296–325):

```markdown
## Orchestration System
(직원 목록 + 디스패치 포맷 + CRITICAL RULES 7항)

### Completion Protocol   ← NEW
- 5-phase 파이프라인: 기획→기획검증→개발→디버깅→통합검증
- phases_completed JSON으로 phase 스킵
- allDone 시그널 → 자연어 요약
```

### Employee Prompt (getEmployeePrompt, L395–449)

직원 에이전트에게 주입되는 프롬프트:

| 섹션 | 내용 |
|---|---|
| Rules | 직접 실행, JSON 디스패치 금지, git 안전장치 |
| Browser Control | snapshot→act→verify 패턴 |
| Telegram File Delivery | POST /api/telegram/send |
| Active Skills | 동적 로딩 (name list) |
| Memory | cli-claw memory commands |
| **Task Completion Protocol** | `phases_completed` JSON 출력 규칙 (NEW) |

### Employee Prompt V2 (getEmployeePromptV2, L442–498)

V1 + 추가 주입:

| 추가 섹션 | 내용 |
|---|---|
| Dev Guide (Common) | `dev/SKILL.md` 항상 주입 |
| Dev Guide (Role) | role별 (dev-frontend/backend/data/docs) |
| Dev Testing (Phase 4) | 디버깅 phase일 때만 dev-testing 추가 |
| Phase Context | 현재 phase + Quality Gate 조건 |
| Sequential Execution | 이전 agent 결과 참조 규칙 |

---

## 스킬 기본값

### Active Skills (자동 활성화)

소스: `lib/mcp-sync.js` → `copyDefaultSkills()`

| 출처 | 자동 활성화 ID |
|---|---|
| **CODEX_ACTIVE** | `pdf`, `openai-docs`, `imagegen` |
| **OPENCLAW_ACTIVE** | `browser`, `notion`, `memory`, `vision-click`, `screen-capture`, `docx`, `xlsx`, `github`, `telegram-send` |
| **Orchestration** | `registry.json`에서 `category=orchestration` 자동 추가 |

현재 17개: browser, dev, dev-backend, dev-data, dev-frontend, dev-testing, docx, github, imagegen, memory, notion, openai-docs, pdf, screen-capture, telegram-send, vision-click, xlsx

> dev 계열 5개(dev, dev-backend, dev-frontend, dev-data, dev-testing)는 자동 활성화 세트에 **없음** → 수동 설치 또는 orchestration category 등록 필요

### Reference Skills (비활성, 요청 시 사용)

- 소스: `~/.cli-claw/skills_ref/` (번들 + Codex 스킬)
- 레지스트리: `~/.cli-claw/skills_ref/registry.json`
- 현재 87개 (프롬프트에 compact CSV로 주입)

---

## Orchestration Plan Prompt (pipeline.js L112–185)

planning agent에게 보내는 프롬프트. **3-tier 호출 전략**:

| Tier | 호출 수 | 기준 |
|:---:|:---:|---|
| 🟢 0 | 0회 | 단순 질문, 한 파일 수정 → `direct_answer` |
| 🟡 1 | 2~3회 | 기획 직접 처리 → `start_phase=3` 이상으로 위임 |
| 🔴 2 | 전체 | 대규모 개발 → `start_phase=1`부터 2~4명 |

Dev Skills 참고 안내 포함: role별 자동 주입 스킬 목록 (dev-frontend, dev-backend 등)

---

## MCP 기본값

### Source of Truth: `~/.cli-claw/mcp.json`

코드 기본 서버: `lib/mcp-sync.js` → `DEFAULT_MCP_SERVERS`

```json
{ "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } }
```

### CLI별 동기화 대상

| CLI | 경로 | 포맷 |
|---|---|---|
| Claude | `{workDir}/.mcp.json` | `{ mcpServers: {...} }` |
| Codex | `~/.codex/config.toml` | TOML `[mcp_servers.name]` |
| Gemini | `~/.gemini/settings.json` | `{ mcpServers: {...} }` |
| OpenCode | `~/.config/opencode/opencode.json` | `{ mcp: {...} }` |
| Copilot | `~/.copilot/mcp-config.json` | `{ mcpServers: {...} }` |

---

## 하트비트 기본값

- HEARTBEAT.md: `~/.cli-claw/prompts/HEARTBEAT.md` (empty template)
- heartbeat.json: `~/.cli-claw/heartbeat.json` (잡 등록, auto-reload)
- 잡 0개 → 프롬프트에 하트비트 섹션 미주입
- 잡 1+개 → `## Current Heartbeat Jobs` 섹션 주입

---

## Settings 기본값 (`core/config.js` → `createDefaultSettings`)

```json
{
    "cli": "claude",
    "fallbackOrder": [],
    "permissions": "safe",
    "workingDir": "~",
    "perCli": {
        "claude":   { "model": "claude-sonnet-4-6",   "effort": "medium" },
        "codex":    { "model": "gpt-5.3-codex",       "effort": "medium" },
        "gemini":   { "model": "gemini-2.5-pro",      "effort": "" },
        "opencode": { "model": "anthropic/claude-opus-4-6-thinking", "effort": "" },
        "copilot":  { "model": "claude-sonnet-4.6",   "effort": "high" }
    },
    "heartbeat": { "enabled": false, "every": "30m", ... },
    "telegram":  { "enabled": false, "token": "", ... },
    "memory":    { "enabled": true, "flushEvery": 10, ... },
    "employees": [],
    "locale": "ko"
}
```

---

## 리셋 후 복구 체크리스트

| 항목 | 리셋 시 동작 | 자동 복구? |
|---|---|---|
| A-1.md 삭제 | A1_CONTENT 폴백 사용 | ✅ |
| A-1.md 내용 축소 | 축소된 내용 그대로 사용 | ❌ 수동 복원 |
| A-2.md 삭제 | A2_DEFAULT(영어)로 재생성 | ✅ (커스텀 재설정 필요) |
| skills/ 비움 | copyDefaultSkills()에서 12개 자동 활성화 | ✅ (dev 5개 수동) |
| heartbeat.json 삭제 | { jobs: [] }로 시작 | ❌ 잡 재등록 |
| mcp.json 삭제 | context7 기본 서버 재생성 | ✅ |
| settings.json 삭제 | 기본값으로 재생성 | ✅ (커스텀 재설정 필요) |
