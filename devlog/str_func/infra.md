# 인프라 모듈 — config · db · bus · memory · browser · mcp-sync

> 의존 0 모듈 + 데이터 레이어 + 외부 도구 통합

---

## config.js — 경로, 설정, CLI 탐지 (168L)

**상수**: `CLAW_HOME` · `PROMPTS_DIR` · `DB_PATH` · `SETTINGS_PATH` · `HEARTBEAT_JOBS_PATH` · `UPLOADS_DIR` · `SKILLS_DIR` · `SKILLS_REF_DIR` · `APP_VERSION` (← package.json)

| Function             | 역할                              |
| -------------------- | --------------------------------- |
| `ensureDirs()`       | 필수 디렉토리 생성                |
| `runMigration()`     | 레거시 DB/settings → ~/.cli-claw  |
| `loadSettings()`     | settings.json 로드 + 마이그레이션 |
| `saveSettings(s)`    | 설정 저장                         |
| `replaceSettings(s)` | ESM live binding 대체 (API PUT용) |
| `detectCli(name)`    | `which` 기반 바이너리 존재 확인   |
| `detectAllCli()`     | 4개 CLI 상태 반환                 |

---

## db.js — Database (84L)

```sql
session   (id='default', active_cli, session_id, model, permissions, working_dir, effort)
messages  (id PK, role, content, cli, model, trace, cost_usd, duration_ms, created_at)
memory    (id PK, key UNIQUE, value, source, created_at, updated_at)
employees (id PK, name, cli, model, role, status, created_at)
```

`trace` — Phase 6 추가. cleaned NDJSON 로그 전체 (reasoning + cmd + output). 기존 DB는 PRAGMA migration으로 자동 ALTER.

| Prepared Statement       | 용도                               |
| ------------------------ | ---------------------------------- |
| `insertMessage`          | 4인자 (trace=NULL) — 기존 호환     |
| `insertMessageWithTrace` | 5인자 (trace 포함)                 |
| `getMessages`            | trace 제외 (UI/API 용)             |
| `getMessagesWithTrace`   | trace 포함 (full)                  |
| `getRecentMessages`      | trace 포함 (DESC, 히스토리 빌더용) |

---

## bus.js — Broadcast Bus (18L)

순환 의존 방지 허브. 의존 0.

| Function                    | 역할                       |
| --------------------------- | -------------------------- |
| `setWss(w)`                 | WebSocket 서버 등록        |
| `broadcast(type, data)`     | WS + 내부 리스너 동시 전파 |
| `addBroadcastListener(fn)`  | 내부 리스너 추가           |
| `removeBroadcastListener()` | 내부 리스너 제거           |

---

## memory.js — Persistent Memory (128L)

| Function                        | 역할                           |
| ------------------------------- | ------------------------------ |
| `search(query)`                 | grep -rni                      |
| `read(filename)`                | 파일 읽기                      |
| `save(filename, content)`       | append                         |
| `list()`                        | 파일 목록                      |
| `appendDaily(content)`          | 일별 메모리 추가               |
| `loadMemoryForPrompt(maxChars)` | 문맥 주입용 로드 (기본 1500자) |
| `MEMORY_DIR`                    | `~/.cli-claw/memory/`          |

### 메모리 2-tier 구조

- **시스템 레벨**: `MEMORY.md` → `getSystemPrompt()`에서 1500자 자동 주입 (매 메시지)
- **세션 레벨**: flush 결과 → `loadRecentMemories()` 10000자, `settings.memory.injectEvery` (기본 2) 사이클마다 주입
- **온디맨드**: `cli-claw memory search/read` → AI가 필요시 호출

---

## Browser Module (`src/browser/`) — Chrome CDP 제어

Chrome CDP 제어, 완전 독립 모듈. Phase 7.2: `ariaSnapshot()` 기반.

| connection.js (71L)      | actions.js (182L)                |
| ------------------------ | -------------------------------- |
| `findChrome()`           | `snapshot(port, opts)`           |
| `launchChrome(port)`     | `screenshot(port, opts)` +dpr    |
| `connectCdp(port)`       | `click(port, ref, opts)`         |
| `getActivePage(port)`    | `type(port, ref, text)`          |
| `getCdpSession(port)`    | `press(port, key)`               |
| `listTabs(port)`         | `hover(port, ref)`               |
| `getBrowserStatus(port)` | `navigate(port, url)`            |
| `closeBrowser()`         | `evaluate(port, expr)`           |
|                          | `getPageText(port, fmt)`         |
|                          | `mouseClick(port, x, y)` Phase 1 |

### vision.js (138L) — Vision Click 파이프라인

| Function                           | 역할                                            |
| ---------------------------------- | ----------------------------------------------- |
| `extractCoordinates(path, target)` | 비전 AI로 좌표 추출 (provider 분기)             |
| `codexVision(path, target)`        | Codex exec -i + NDJSON 파싱                     |
| `visionClick(port, target, opts)`  | screenshot → vision → DPR 보정 → click → verify |

`index.js` (13L) — re-export hub (mouseClick + visionClick 포함)

> 👁️ Phase 2: `visionClick()` — 원커맨드 파이프라인. `screenshot()` 는 `{path, dpr, viewport}` 반환. DPR 자동 보정 (coord / devicePixelRatio).

---

## lib/mcp-sync.js — MCP 통합 관리 (482L)

소스: `~/.cli-claw/mcp.json`

| Function                     | 역할                                              |
| ---------------------------- | ------------------------------------------------- |
| `loadUnifiedMcp()`           | 통합 MCP 설정 로드                                |
| `toClaudeMcp(config)`        | Claude/Gemini `.mcp.json` 변환                    |
| `toCodexToml(config)`        | Codex `config.toml` 변환                          |
| `toOpenCodeMcp(config)`      | OpenCode `opencode.json` 변환                     |
| `syncToAll(config, workDir)` | 통합 → 4개 CLI 설정 동기화                        |
| `copyDefaultSkills()`        | 2×3 분류 + Codex 폴백 + registry.json 항상 동기화 |
| `installMcpServers(config)`  | npm -g / uv tool install                          |

## lib/upload.js (70L)

파일 업로드 처리 + Telegram 다운로드.
