# prompt_basic_B — 조립 결과 + 스킬/MCP/하트비트 기본값

> B.md = `getSystemPrompt()` 결과 캐시
> 경로: `~/.cli-claw/prompts/B.md` + `{workDir}/AGENTS.md`
> 소스: `src/prompt.js` → `regenerateB()` (Line 480–501)

---

## B.md 조립 순서

```
┌──────────────────────────────────────────────────┐
│ getSystemPrompt() 조립 순서                       │
├──────────────────────────────────────────────────┤
│ 1. A-1.md (시스템 규칙)                  ← 항상  │
│ 2. A-2.md (사용자 설정)                  ← 항상  │
│ 3. Telegram File Delivery (Active)       ← 조건  │
│    └ telegram-send 스킬 설치 시                  │
│ 4. Session Memory                        ← 조건  │
│    └ counter % ⌈threshold/2⌉ === 0 일 때        │
│ 5. MEMORY.md (Core Memory)               ← 항상  │
│    └ 50자↑, 1500자 제한                          │
│ 6. Employees + Orchestration             ← 조건  │
│    └ 직원 1+ 명 등록 시                          │
│ 7. Heartbeat Jobs                        ← 조건  │
│    └ 잡 1+ 개 등록 시                            │
│ 8. Skills (Active + Ref + Discovery)     ← 조건  │
│    └ 스킬 1+ 개 있을 때                          │
│ 9. Vision Click Hint                     ← 조건  │
│    └ Codex CLI + vision-click 스킬              │
├──────────────────────────────────────────────────┤
│ → B.md 저장  (디버그용)                           │
│ → {workDir}/AGENTS.md  (Codex/Copilot/OpenCode)  │
│ → session_id = null  (세션 무효화)                │
└──────────────────────────────────────────────────┘
```

---

## 스킬 기본값

### Active Skills (자동 활성화 세트)

코드: `mcp-sync.js` → `copyDefaultSkills()` (Line 505–621)

| 출처 | 자동 활성화 ID |
|---|---|
| **CODEX_ACTIVE** | `pdf`, `openai-docs`, `imagegen` |
| **OPENCLAW_ACTIVE** | `browser`, `notion`, `memory`, `vision-click`, `screen-capture`, `docx`, `xlsx`, `github`, `telegram-send` |
| **Orchestration** | `registry.json`에서 `category=orchestration`인 스킬 자동 추가 |

현재 활성 스킬 (17개): browser, dev, dev-backend, dev-data, dev-frontend, dev-testing, docx, github, imagegen, memory, notion, openai-docs, pdf, screen-capture, telegram-send, vision-click, xlsx

### Reference Skills (비활성, 요청 시 사용)

- 소스: `~/.cli-claw/skills_ref/` (번들 + Codex 스킬)
- 레지스트리: `~/.cli-claw/skills_ref/registry.json`
- 현재 87개 (프롬프트에 compact CSV로 주입)

### 스킬 주입 포맷

```markdown
## Skills System

### Active Skills (17)
These skills are installed and triggered automatically by the CLI.
- browser (browser)
- dev (dev)
...

### Available Skills (87)
These are reference skills — not active yet, but ready to use on demand.
**How to use**: read `~/.cli-claw/skills_ref/<name>/SKILL.md` and follow its instructions.
**To activate permanently**: `cli-claw skill install <name>`

trello, obsidian, things-mac, ...

### Skill Discovery
If a requested task is not covered by any active or available skill:
1. Search the system for relevant CLI tools
2. Create new SKILL.md
3. Use skill-creator reference
```

### 스킬 리셋 시 동작

1. `~/.cli-claw/skills/` 비움 → `copyDefaultSkills()` 재실행 시 CODEX_ACTIVE + OPENCLAW_ACTIVE 자동 복원
2. `registry.json`은 번들에서 항상 덮어쓰기 (사용자 편집 아님)
3. dev, dev-backend, dev-frontend, dev-data, dev-testing은 **자동 활성화 세트에 없음** → 수동 설치 필요

---

## MCP 기본값

### Source of Truth

```
~/.cli-claw/mcp.json
```

### 코드 기본 서버

소스: `mcp-sync.js` → `DEFAULT_MCP_SERVERS` (Line 382–387)

```json
{
    "context7": {
        "command": "npx",
        "args": ["-y", "@upstash/context7-mcp"]
    }
}
```

### 현재 실제 mcp.json

```json
{
    "servers": {
        "context7": {
            "command": "context7-mcp",
            "args": []
        }
    }
}
```

> `npx` → 글로벌 설치 완료 (`context7-mcp` 바이너리) → `installMcpServers()`가 변환

### CLI별 동기화 대상

| CLI | 경로 | 포맷 |
|---|---|---|
| Claude | `{workDir}/.mcp.json` | `{ mcpServers: {...} }` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.name]` TOML |
| Gemini | `~/.gemini/settings.json` | `{ mcpServers: {...} }` |
| OpenCode | `~/.config/opencode/opencode.json` | `{ mcp: {...} }` |
| Copilot | `~/.copilot/mcp-config.json` | `{ mcpServers: {...} }` |

### 동기화 커맨드

- CLI: `cli-claw mcp sync`
- API: `POST /api/mcp/sync`
- 자동: 서버 시작 시 `initMcpConfig()` → `syncToAll()`

---

## 하트비트 기본값

### HEARTBEAT.md (프롬프트 파일)

경로: `~/.cli-claw/prompts/HEARTBEAT.md`

```markdown
# Heartbeat checklist

<!-- Keep this empty to skip heartbeat API calls -->
<!-- Add tasks below when you want periodic checks -->
```

> HEARTBEAT.md는 프롬프트 조립에 직접 사용되지 않음.
> 하트비트 잡은 `heartbeat.json`에서 관리됨.

### heartbeat.json (실제 잡 등록)

경로: `~/.cli-claw/heartbeat.json`

**최초 설치 기본값**: `{ "jobs": [] }` (빈 배열 — 잡 없음)

- `loadHeartbeatFile()`에서 파일 없으면 `{ jobs: [] }` 반환 (`config.js:149–155`)
- 잡이 0개이면 프롬프트에 하트비트 섹션 자체가 주입되지 않음
- 에이전트에게 `heartbeat.json` 편집을 요청하면 잡이 추가됨 (auto-reload)

### 현재 사용자 잡 (주니 커스텀)

| 잡 이름 | 간격 | 상태 | 내용 (요약) |
|---|---|---|---|
| mersoom_recommended | 240분 | ✅ 활성 | Mersoom 동기화 + 닉네임 규칙 + 게시판 참여 |
| notion_hourly_upgrade | 120분 | ✅ 활성 | Notion 작고 안전한 개선 1건 |

> ⚠️ 위 잡들은 기본값이 아닌 **사용자가 등록한 커스텀 잡**임

### 프롬프트 주입 포맷 (잡 1+개일 때만)

```markdown
## Current Heartbeat Jobs
- ✅ "잡이름" — every Nmin: 프롬프트 앞 50자...

Active: N, Total: N
To modify: edit ~/.cli-claw/heartbeat.json (auto-reloads on save)
```

---

## Settings 기본값

### 코드 기본값 (`config.js:createDefaultSettings`)

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
    "heartbeat": { "enabled": false, "every": "30m", "activeHours": {"start":"08:00","end":"22:00"}, "target": "all" },
    "telegram":  { "enabled": false, "token": "", "allowedChatIds": [] },
    "memory":    { "enabled": true, "flushEvery": 10, "cli": "", "model": "", "retentionDays": 30 },
    "employees": [],
    "locale": "ko"
}
```

### 현재 사용자 설정 (settings.json)

| 항목 | 기본값 | 현재 값 | 비고 |
|---|---|---|---|
| cli | claude | **copilot** | 활성 CLI 변경됨 |
| fallbackOrder | [] | ["codex","claude"] | 폴백 설정됨 |
| permissions | safe | **auto** | 자동 승인 |
| workingDir | ~ | /Users/junny | 동일 |
| perCli.gemini.model | gemini-2.5-pro | **gemini-3.1-pro-preview** | 업그레이드 |
| perCli.opencode.effort | "" | **max** | 변경 |
| perCli.copilot.model | claude-sonnet-4.6 | **claude-opus-4.6-fast** | 업그레이드 |
| telegram.enabled | false | **true** | 활성화됨 |
| locale | ko | ko | 동일 |

---

## 요약: 리셋 후 복구 체크리스트

| 항목 | 리셋 시 동작 | 자동 복구? | 수동 필요? |
|---|---|---|---|
| A-1.md 삭제 | initPromptFiles()에서 A1_CONTENT로 재생성 | ✅ | ❌ |
| A-1.md 내용 축소 | 기존 파일 유지 (덮어쓰지 않음) | ❌ | ✅ 재작성 필요 |
| A-2.md 삭제 | A2_DEFAULT(영어)로 재생성 | ✅ | ✅ 커스텀 재설정 |
| skills/ 비움 | copyDefaultSkills()에서 12개 자동 활성화 | ✅ | ✅ dev 계열 5개 수동 |
| heartbeat.json 삭제 | { jobs: [] }로 시작 | ❌ | ✅ 잡 재등록 |
| mcp.json 삭제 | context7 기본 서버로 재생성 | ✅ | ❌ |
| settings.json 삭제 | 기본값으로 재생성 | ✅ | ✅ 커스텀 재설정 |
