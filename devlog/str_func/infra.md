# 인프라 모듈 — core/ · memory/ · browser/ · security/ · http/ · lib/mcp-sync

> 의존 0 모듈 + 데이터 레이어 + 외부 도구 통합 + Phase 9 보안/응답 유틸
> Phase 20.6: flat src/ → src/core/, src/memory/ 등 서브디렉토리 분리

---

## src/cli/registry.ts — CLI/모델 단일 소스 (89L)

**의존 없음** — core/config.ts, cli/commands.ts, server.ts, 프론트엔드가 모두 이 레지스트리를 참조.

| Export                   | 역할                                                     |
| ------------------------ | -------------------------------------------------------- |
| `CLI_REGISTRY`           | 5개 CLI 정의 (label, binary, defaultModel, defaultEffort, efforts, models) |
| `CLI_KEYS`               | `Object.keys(CLI_REGISTRY)` — 순서 보장 배열               |
| `DEFAULT_CLI`            | 기본 CLI (‘claude’ 우선, 없으면 첨 항목)                |
| `buildDefaultPerCli()`   | registry에서 기본 perCli 객체 빌드 (model + effort)        |
| `buildModelChoicesByCli()` | registry에서 CLI별 모델 목록 맵 빌드                    |

```js
CLI_REGISTRY = {
    claude:   { label: 'Claude',   binary: 'claude',   defaultModel: 'claude-sonnet-4-6', ... },
    codex:    { label: 'Codex',    binary: 'codex',    defaultModel: 'gpt-5.3-codex', ... },
    gemini:   { label: 'Gemini',   binary: 'gemini',   defaultModel: 'gemini-2.5-pro', ... },
    opencode: { label: 'OpenCode', binary: 'opencode', defaultModel: 'anthropic/claude-opus-4-6-thinking', ... },
    copilot:  { label: 'Copilot',  binary: 'copilot',  defaultModel: 'claude-sonnet-4.6', defaultEffort: 'high', efforts: ['low','medium','high'], ... },
};
```

---

## src/core/config.ts — 경로, 설정, CLI 탐지 (215L)

**상수**: `JAW_HOME` (← `CLI_JAW_HOME` env || `~/.cli-jaw`) · `PROMPTS_DIR` · `DB_PATH` · `SETTINGS_PATH` · `HEARTBEAT_JOBS_PATH` · `UPLOADS_DIR` · `SKILLS_DIR` · `SKILLS_REF_DIR` · `LOG_DIR` · `APP_VERSION` (← package.json) · `DEFAULT_PORT` ('3457')

| Function              | 역할                                       |
| --------------------- | ------------------------------------------ |
| `ensureDirs()`        | 필수 디렉토리 생성                         |
| `runMigration()`      | 레거시 DB/settings → ~/.cli-jaw           |
| `loadSettings()`      | settings.json 로드 + 마이그레이션          |
| `saveSettings(s)`     | 설정 저장                                  |
| `replaceSettings(s)`  | ESM live binding 대체 (API PUT용)          |
| `getServerUrl(port)`  | `http://localhost:${port \|\| PORT \|\| 3457}` |
| `getWsUrl(port)`      | WebSocket URL 동적 생성                    |
| `detectCli(name)`     | `which` 기반 바이너리 존재 확인            |
| `detectAllCli()`      | **5개 CLI** 상태 반환 (cli-registry 기반)  |
| `buildDefaultPerCli()`| cli-registry에서 기본 perCli 객체 빌드     |

**Multi-instance**: `JAW_HOME`은 `CLI_JAW_HOME` env var로 오버라이드 가능. `--home` flag는 `cli-jaw.ts`에서 `process.env.CLI_JAW_HOME` 설정 후 config.ts import 전에 적용. 모든 파생 경로(DB, settings, logs 등)가 자동으로 JAW_HOME 기준으로 변경됨.

---

## src/core/db.ts — Database (105L)

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

## src/core/bus.ts — Broadcast Bus (20L)

순환 의존 방지 허브. 의존 0.

| Function                      | 역할                       |
| ----------------------------- | -------------------------- |
| `setWss(w)`                   | WebSocket 서버 등록        |
| `broadcast(type, data)`       | WS + 내부 리스너 동시 전파 |
| `addBroadcastListener(fn)`    | 내부 리스너 추가           |
| `removeBroadcastListener(fn)` | **특정 핸들러** 제거 (named handler 지원) |

> ⚠️ `removeBroadcastListener(fn)` — 인자로 핸들러 참조를 받아 정확히 해당 리스너만 제거. Telegram forwarder lifecycle에서 사용.

---

## src/memory/memory.ts — Persistent Memory (129L)

| Function                        | 역할                           |
| ------------------------------- | ------------------------------ |
| `search(query)`                 | grep -rni                      |
| `read(filename)`                | 파일 읽기                      |
| `save(filename, content)`       | append                         |
| `list()`                        | 파일 목록                      |
| `appendDaily(content)`          | 일별 메모리 추가               |
| `loadMemoryForPrompt(maxChars)` | 문맥 주입용 로드 (기본 1500자) |
| `MEMORY_DIR`                    | `~/.cli-jaw/memory/`          |

### 메모리 2-tier 구조

- **시스템 레벨**: `MEMORY.md` → `getSystemPrompt()`에서 1500자 자동 주입 (매 메시지)
- **세션 레벨**: flush 결과 → `loadRecentMemories()` 10000자, `settings.memory.injectEvery` (기본 2) 사이클마다 주입
- **온디맨드**: `cli-jaw memory search/read` → AI가 필요시 호출

---

## src/browser/ — Chrome CDP 제어

Chrome CDP 제어, 완전 독립 모듈. Phase 7.2: `ariaSnapshot()` 기반.

| connection.ts (113L)     | actions.ts (179L)                |
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

### vision.ts (138L) — Vision Click 파이프라인

| Function                           | 역할                                            |
| ---------------------------------- | ----------------------------------------------- |
| `extractCoordinates(path, target)` | 비전 AI로 좌표 추출 (provider 분기)             |
| `codexVision(path, target)`        | Codex exec -i + NDJSON 파싱                     |
| `visionClick(port, target, opts)`  | screenshot → vision → DPR 보정 → click → verify |

`index.ts` (13L) — re-export hub (mouseClick + visionClick 포함)

---

## lib/mcp-sync.ts — MCP 통합 관리 (661L)

소스: `~/.cli-jaw/mcp.json`

| Function                     | 역할                                              |
| ---------------------------- | ------------------------------------------------- |
| `loadUnifiedMcp()`           | 통합 MCP 설정 로드                                |
| `toClaudeMcp(config)`        | Claude/Gemini `.mcp.json` 변환                    |
| `toCodexToml(config)`        | Codex `config.toml` 변환                          |
| `toOpenCodeMcp(config)`      | OpenCode `opencode.json` 변환                     |
| `toCopilotMcp(config)`       | **Copilot** `~/.copilot/mcp-config.json` 변환     |
| `syncToAll(config, workDir)` | 통합 → **5개 CLI** 설정 동기화                    |
| `copyDefaultSkills()`        | 2×3 분류 + Codex 폴백 + registry.json 항상 동기화 |
| `installMcpServers(config)`  | npm -g / uv tool install                          |
| `ensureSymlinkSafe(target, linkPath, opts)` | **symlink 보호 모드** (backup 우선) |
| `safeMoveToBackup(pathToMove)` | 충돌 디렉토리 백업 이동                         |
| `ensureSkillsSymlinks(workingDir, opts)` | 스킬 심링크 + 보호 결과 반환          |

### symlink 보호 정책

- 실디렉토리 충돌 시 `fs.rmSync` 대신 `renameSync`로 백업
- 백업 경로: `~/.cli-jaw/backups/skills-conflicts/<timestamp>/`
- 결과가 로그/API 응답에 기록됨 (`status: ok/skip`, `action: noop/backup/create/conflict`)

## lib/upload.ts (70L)

파일 업로드 처리 + Telegram 다운로드.

---

## src/security/ — 보안 입력 검증 [P9.1]

**의존 없음** — server.ts에서 라우트 핸들러 진입 시 호출.

### path-guards.ts (60L)

| Function            | 역할                                                  |
| ------------------- | ----------------------------------------------------- |
| `assertSkillId(id)` | `/^[a-z0-9_-]+$/i` 검증 + 길이 제한 (256)            |
| `assertFilename(f, opts)` | 확장자 화이트리스트 + path separator 차단 + 길이 제한 |
| `safeResolveUnder(base, rel)` | `path.resolve` 후 base 디렉토리 탈출 검증         |

### decode.ts (21L)

| Function                | 역할                                                  |
| ----------------------- | ----------------------------------------------------- |
| `decodeFilenameSafe(s)` | `decodeURIComponent` + 길이 제한 (512) + 에러 시 원본 반환 |

#### 적용 라우트

| 라우트                       | 적용 guard                          |
| ---------------------------- | ----------------------------------- |
| `/api/memory-files/:filename` | `assertFilename` + `safeResolveUnder` |
| `/api/upload`                 | `decodeFilenameSafe`                |
| `/api/skills/enable`, `disable` | `assertSkillId`                  |
| `/api/jaw-memory/read`, `save` | `assertFilename` + `safeResolveUnder` |

---

## src/http/ — 응답 계약 [P9.2]

**의존 없음** — Express 라우트에서 직접 사용.

### response.ts (25L)

| Function          | 역할                                          |
| ----------------- | --------------------------------------------- |
| `ok(res, data)`   | `{ ok: true, ...data }` 200 응답              |
| `fail(res, status, error, extra)` | `{ ok: false, error, ...extra }` 에러 응답 |

### async-handler.ts (14L)

| Function             | 역할                                     |
| -------------------- | ---------------------------------------- |
| `asyncHandler(fn)`   | `Promise.catch(next)` 래퍼 — async 에러 전달 |

### error-middleware.ts (26L)

| Function            | 역할                                     |
| ------------------- | ---------------------------------------- |
| `notFoundHandler`   | 404 → `fail(res, 404, 'not_found')`     |
| `errorHandler`      | 글로벌 에러 → 500 + 로깅                |

---

## src/core/settings-merge.ts — 설정 deep merge (45L)

**의존 없음** — server.ts `applySettingsPatch()`에서 호출.

| Function                       | 역할                                           |
| ------------------------------ | ---------------------------------------------- |
| `mergeSettingsPatch(settings, rawPatch)` | perCli/activeOverrides/heartbeat/telegram/memory deep merge |

기존 `applySettingsPatch` 내 30줄 인라인 merge 로직을 추출. 개별 CLI 설정을 덮어쓰지 않고 필드 단위로 병합.

---

## bin/commands/ — CLI Subcommands

### bin/cli-jaw.ts — CLI Entrypoint

> 서브커맨드 라우터 + `--home` flag 처리 (manual `indexOf`, NOT parseArgs)
> `--home` → `process.env.CLI_JAW_HOME` 설정 후 config.ts 동적 import
> known-command guard: `--home` 사용 시 알려진 명령어(start/stop/launchd/clone 등)만 허용

### bin/commands/clone.ts (165L)

> `jaw clone` — JAW_HOME 환경 복제. source 디렉토리 검증(존재 + settings.json 포함).
> `--from <path>`: 소스 지정. `--with-memory`: memory/ 디렉토리도 복사. `--link-ref`: skills_ref/ 심볼릭 링크.
> 복제 후 subprocess `regenerateB` 호출로 프롬프트/스킬 재생성.

| Function            | 역할                                          |
| ------------------- | --------------------------------------------- |
| `cloneHome(args)`   | 소스 검증 → 디렉토리 복사 → regenerateB 호출  |

### bin/commands/launchd.ts (179L)

> macOS launchd 서비스 관리. Multi-instance 지원.

| Function              | 역할                                          |
| --------------------- | --------------------------------------------- |
| `instanceId()`        | JAW_HOME → label 식별자 (`default` / `<name>-<md5hash8>`) |
| `xmlEsc(s)`           | XML 특수문자 이스케이프 (&, <, >, ", ')        |
| `generatePlist(port)` | launchd plist XML 생성 (CLI_JAW_HOME env, --home/--port pass-through) |

- `parseArgs({ strict: false })` + manual unknown-key guard (unknown flag → error + exit 1)
- PLIST_PATH 더블-쿼팅 (경로에 공백 포함 시 안전)
- `launchctl load/unload` 명령으로 서비스 시작/중지

### bin/commands/browser.ts / memory.ts

- `getServerUrl(undefined)` 패턴: PORT env var 우선, 없으면 DEFAULT_PORT('3457')
- memory.ts: init 경로 `${JAW_HOME}/memory/` (하드코딩 `~/.cli-jaw` 제거)
