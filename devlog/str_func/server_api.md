# server.js — Glue + API Routes (949L)

> 라우트 + 초기화 + 커맨드 ctx 구성 + Quota 조회 + CLI Registry API
> Phase 9: `ok()`/`fail()` 표준 응답 13라우트 적용, 보안 가드 4라우트 적용, `mergeSettingsPatch` 호출

---

## 추출 함수

| Function                          | 역할                                    |
| --------------------------------- | --------------------------------------- |
| `getRuntimeSnapshot()`            | 세션/설정/큐/에이전트 상태 스냅샷       |
| `clearSessionState()`             | 세션/메시지/큐 초기화                   |
| `getLatestTelegramChatId()`       | Telegram 최신 활성 chatId 반환          |
| `applySettingsPatch(rawPatch, o)` | 설정 패치 + `mergeSettingsPatch()` 호출 + 저장 + B 재생성 |
| `makeWebCommandCtx()`             | Web 인터페이스용 슬래시 커맨드 ctx 생성 |

### Quota 함수

| Function              | 역할                  |
| --------------------- | --------------------- |
| `readClaudeCreds()`   | Claude API 키 읽기    |
| `fetchClaudeUsage()`  | Claude 사용량 조회    |
| `readCodexTokens()`   | Codex 토큰 읽기       |
| `fetchCodexUsage()`   | Codex 사용량 조회     |
| `readGeminiAccount()` | Gemini 계정 정보 읽기 |

---

## 초기화 순서

```text
ensureDirs() → runMigration() → loadSettings() → initPromptFiles()
→ regenerateB() → listen() → mcp-sync → initTelegram() → startHeartbeat()
```

---

## REST API

| Category       | Endpoints                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Core           | `GET /api/session` `GET /api/messages` `POST /api/message` `POST /api/stop` `POST /api/clear`                 |
| Commands       | `POST /api/command` `GET /api/commands?interface=`                                                            |
| Settings       | `GET/PUT /api/settings` `GET/PUT /api/prompt` `GET/PUT /api/heartbeat-md`                                     |
| **Registry**   | **`GET /api/cli-registry`** — CLI/모델 단일 소스 (cli-registry.js 반환)                                       |
| Memory (DB)    | `GET/POST /api/memory` `DELETE /api/memory/:key`                                                              |
| Memory Files   | `GET /api/memory-files` `GET/DELETE /api/memory-files/:fn` `PUT /api/memory-files/settings`                   |
| Claw Memory    | `GET /api/claw-memory/search,read,list` `POST /api/claw-memory/save,init`                                     |
| Upload & MCP   | `POST /api/upload` `GET/PUT /api/mcp` `POST /api/mcp/sync,install,reset`                                      |
| Status & Quota | `GET /api/cli-status` `GET /api/quota` (Claude/Codex/Gemini/**Copilot**)                                       |
| Skills         | `GET /api/skills` `POST /api/skills/enable,disable` `GET /api/skills/:id` `POST /api/skills/reset`            |
| Employees      | `GET/POST /api/employees` `PUT/DELETE /api/employees/:id` `POST /api/employees/reset`                         |
| Browser        | `POST start,stop,act(+mouse-click),vision-click,navigate,screenshot,evaluate` `GET status,tabs,snapshot,text` |

> 총 40+ 엔드포인트. 13개 라우트에 `ok()`/`fail()` 표준 응답 적용 (Phase 9.2). 4개 라우트에 보안 가드 적용 (Phase 9.1).
>
> **보안 가드 적용 라우트**: memory-files (`assertFilename` + `safeResolveUnder`), upload (`decodeFilenameSafe`), skills (`assertSkillId`), claw-memory (`assertFilename` + `safeResolveUnder`)
>
> **새 import**: `ok`/`fail` (← src/http/response.js), `mergeSettingsPatch` (← src/settings-merge.js), `assertSkillId`/`assertFilename`/`safeResolveUnder` (← src/security/path-guards.js), `decodeFilenameSafe` (← src/security/decode.js)

---

## WebSocket Events

| Type                          | 설명                          |
| ----------------------------- | ----------------------------- |
| `agent_status`                | running/done/error/evaluating |
| `agent_tool` / `agent_done`   | 툴 사용 / 완료 + 결과 + **origin** |
| `round_start` / `round_done`  | 오케스트레이션 라운드         |
| `new_message` / `clear`       | 메시지 추가 / 전체 삭제       |
| `queue_update`                | 큐 상태 변경                  |
| `agent_added/updated/deleted` | 직원 CRUD                     |

---

## bin/commands/ — CLI 명령어

| 명령어        | 설명                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| `serve`       | `--port 3457` `--host 0.0.0.0` `--open`, IPv4 first                                    |
| `chat`        | 3모드 (Default/Raw/Simple), 슬래시명령, 멀티라인, CJK 너비 (832L)                      |
| `init`        | Interactive/`--non-interactive`, 완료 후 postinstall                                   |
| `doctor`      | 11개 체크 (CLI/Telegram/Skills/Chrome 등), `--json`                                    |
| `mcp`         | `install <pkg>` · `sync` · `list` · `reset` (PyPI 자동 감지)                           |
| `skill`       | `install` (Codex→Ref→GitHub) · `remove` · `info` · `list` · `reset`                    |
| `browser`     | 17개 서브커맨드 (start/stop/snapshot/screenshot/click/mouse-click/vision-click/type/…) |
| `memory`      | `search` · `read` · `save` · `list` · `init`                                           |
| `postinstall` | 8단계: dirs → symlinks → heartbeat → MCP → skills → deps → **Copilot PATH 심링크**    |
