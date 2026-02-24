# server.js — Glue + API Routes (686L)

> 라우트 + 초기화 + 커맨드 ctx 구성 + Quota 조회

---

## 추출 함수

| Function                          | 역할                                    |
| --------------------------------- | --------------------------------------- |
| `getRuntimeSnapshot()`            | 세션/설정/큐/에이전트 상태 스냅샷       |
| `clearSessionState()`             | 세션/메시지/큐 초기화                   |
| `applySettingsPatch(rawPatch, o)` | 설정 패치 + 검증 + 저장 + B 재생성      |
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

| Category       | Endpoints                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Core           | `GET /api/session` `GET /api/messages` `POST /api/message` `POST /api/stop` `POST /api/clear`    |
| Commands       | `POST /api/command` `GET /api/commands?interface=`                                               |
| Settings       | `GET/PUT /api/settings` `GET/PUT /api/prompt` `GET/PUT /api/heartbeat-md`                        |
| Memory (DB)    | `GET/POST /api/memory` `DELETE /api/memory/:key`                                                 |
| Memory Files   | `GET /api/memory-files` `GET/DELETE /api/memory-files/:fn` `PUT /api/memory-files/settings`      |
| Claw Memory    | `GET /api/claw-memory/search,read,list` `POST /api/claw-memory/save,init`                        |
| Upload & MCP   | `POST /api/upload` `GET/PUT /api/mcp` `POST /api/mcp/sync,install,reset`                         |
| Status & Quota | `GET /api/cli-status` `GET /api/quota`                                                           |
| Employees      | `GET/POST /api/employees` `PUT/DELETE /api/employees/:id`                                        |
| Skills         | `GET /api/skills` `POST /api/skills/enable,disable` `GET /api/skills/:id`                        |
| Browser        | `POST start,stop,act(+mouse-click),navigate,screenshot,evaluate` `GET status,tabs,snapshot,text` |

> 총 40+ 엔드포인트. 모든 응답은 JSON.

---

## WebSocket Events

| Type                          | 설명                          |
| ----------------------------- | ----------------------------- |
| `agent_status`                | running/done/error/evaluating |
| `agent_tool` / `agent_done`   | 툴 사용 / 완료 + 결과         |
| `round_start` / `round_done`  | 오케스트레이션 라운드         |
| `new_message` / `clear`       | 메시지 추가 / 전체 삭제       |
| `queue_update`                | 큐 상태 변경                  |
| `agent_added/updated/deleted` | 직원 CRUD                     |

---

## bin/commands/ — CLI 명령어

| 명령어        | 설명                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| `serve`       | `--port 3457` `--host 0.0.0.0` `--open`, IPv4 first                       |
| `chat`        | 3모드 (Default/Raw/Simple), 슬래시명령, 멀티라인, CJK 너비 (832L)         |
| `init`        | Interactive/`--non-interactive`, 완료 후 postinstall                      |
| `doctor`      | 11개 체크 (CLI/Telegram/Skills/Chrome 등), `--json`                       |
| `mcp`         | `install <pkg>` · `sync` · `list` · `reset` (PyPI 자동 감지)              |
| `skill`       | `install` (Codex→Ref→GitHub) · `remove` · `info` · `list` · `reset`       |
| `browser`     | 16개 서브커맨드 (start/stop/snapshot/screenshot/click/mouse-click/type/…) |
| `memory`      | `search` · `read` · `save` · `list` · `init`                              |
| `postinstall` | 8단계: dirs → symlinks → heartbeat → MCP → skills → deps                  |
