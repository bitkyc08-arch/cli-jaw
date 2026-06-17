---
created: 2026-03-28
tags: [cli-jaw, infra, runtime, core]
aliases: [CLI-JAW Infra, infrastructure modules, core runtime]
---

> 📚 [INDEX](INDEX.md) · [에이전트 실행 ↗](agent_spawn.md) · [서버 API ↗](server_api.md) · **인프라 모듈**

# 인프라 모듈 — core/ · messaging/ · telegram/ · discord/ · memory/ · browser/ · routes/ · security/ · http/ · lib/mcp-sync

> 의존 0 모듈 + 데이터 레이어 + 멀티 채널 메시징 + 외부 도구 통합
> 현재 tree 기준으로 `src/core/`는 support cluster, `src/messaging/`는 Telegram/Discord 공통 런타임, `src/telegram/`·`src/discord/`는 각 채널 transport 구현으로 분리됨

---

## 실제 실행/배포 표면 — `package.json` · Docker · CLI

### Package metadata

| 항목 | 현재 값 |
| --- | --- |
| package | `cli-jaw` |
| version | `2.1.3` |
| type | `module` |
| Node engine | `>=22.4.0` |
| bin | `cli-jaw` → `dist/bin/cli-jaw.js`, `jaw` → `dist/bin/cli-jaw.js` |
| published files | `dist/`, `public/`, `scripts/`, `package.json` |

### `package.json` scripts

| script | command |
| --- | --- |
| `dev` | `tsx --env-file=.env server.ts` |
| `ensure:native` | `node scripts/ensure-native-modules.cjs` |
| `rebuild:native` | `npm rebuild better-sqlite3` |
| `postinstall` | `node scripts/postinstall-guard.cjs` |
| `clean:dist` | `node -e "const fs=require('fs');fs.rmSync('dist',{recursive:true,force:true});"` |
| `check:copilot-gap` | `tsx scripts/check-copilot-gap.ts` |
| `check:deps` | `tsx scripts/check-deps-offline.ts` |
| `check:frontend-build-output` | `tsx scripts/check-web-ui-build-output.ts` |
| `check:strict-baseline` | `node scripts/check-strict-baseline.mjs` |
| `i18n:registry` | `tsx scripts/i18n-registry.ts` |
| `check:deps:online` | `bash scripts/check-deps-online.sh` |
| `prebuild`, `pretest`, `pretest:all`, `pretest:integration`, `pretest:smoke` | `npm run ensure:native` |
| `test` | `tsx --import ./tests/setup/test-home.ts --experimental-test-module-mocks --test tests/*.test.ts tests/unit/*.test.ts` |
| `test:all` | `tsx --import ./tests/setup/test-home.ts --experimental-test-module-mocks --test tests/*.test.ts tests/**/*.test.ts` |
| `test:integration` | `tsx --experimental-test-module-mocks --test tests/integration/*.test.ts` |
| `test:coverage` | `tsx --import ./tests/setup/test-home.ts --experimental-test-module-mocks --test --experimental-test-coverage tests/*.test.ts tests/**/*.test.ts` |
| `test:watch` | `tsx --import ./tests/setup/test-home.ts --test --watch tests/*.test.ts tests/unit/*.test.ts` |
| `test:web-ui-runtime` | `tsx --import ./tests/setup/test-home.ts --experimental-test-module-mocks --test tests/unit/web-ui-runtime-*.test.ts tests/unit/web-ui-processblock-runtime.test.ts tests/unit/web-ui-mermaid-runtime.test.ts tests/unit/web-ui-sanitizer.test.ts tests/unit/web-ui-build-output-guard.test.ts` |
| `test:events` | `tsx --test tests/events.test.ts` |
| `test:telegram` | `tsx --test tests/telegram-forwarding.test.ts` |
| `test:manager:browser` | `tsx --test tests/browser/manager-layout-smoke.test.ts` |
| `test:smoke` | `TEST_PORT=3457 tsx --test tests/integration/api-smoke.test.ts` |
| `smoke:opencode` | `tsx scripts/smoke/opencode-external-dir-smoke.ts` |
| `verify:fresh-install` | `bash scripts/verify-fresh-install.sh` |
| `collect:fresh-install-evidence` | `bash scripts/collect-fresh-install-evidence.sh` |
| `audit:fresh-install-evidence` | `node scripts/audit-fresh-install-evidence.mjs` |
| `verify:release-evidence` | `node scripts/verify-release-evidence.mjs` |
| `test:fresh-install` | `tsx scripts/fresh-install-smoke.ts` |
| `test:install-risk` | `node scripts/install-risk-gate.mjs` |
| `check:cli-bin-links` | `node scripts/check-cli-bin-links.cjs` |
| `test:claude-exec` | `cargo test --manifest-path native/jaw-claude-i/Cargo.toml` |
| `test:claude-e` | compatibility alias for `test:claude-exec` |
| `build` | `bash scripts/atomic-build.sh` — staged `dist/bin/cli-jaw.js` 실행권한을 보장한 뒤 atomic swap |
| `build:claude-exec` | `cargo build --release --manifest-path native/jaw-claude-i/Cargo.toml` |
| `build:claude-e` | compatibility alias for `build:claude-exec` |
| `postbuild` | `node scripts/link-current-nvm-bin.cjs` — non-NVM Node에서는 링크를 skip하되 `dist/bin/cli-jaw.js` chmod repair는 먼저 수행 |
| `build:frontend` | `vite build --config vite.config.ts` |
| `qa:manager-frontend` | `npm run build:frontend && npm run typecheck:frontend` |
| `dev:frontend` | `vite --config vite.config.ts` |
| `preview:frontend` | `vite preview --config vite.config.ts` |
| `typecheck` | `tsc --noEmit` |
| `typecheck:frontend` | `tsc --noEmit -p tsconfig.frontend.json` |
| `gate:typecheck` / `gate:tests` / `gate:*` | `node scripts/release-gates.mjs <gate>` |
| `gate:all` | `node scripts/release-gates.mjs` |
| `prepublishOnly` | `npm run build && npm run build:frontend` |
| `electron:dev` | `concurrently -k -n jaw,electron "node scripts/electron-dev-manager.mjs" "npm --prefix electron run dev"` |
| `electron:build` | `npm --prefix electron run build` |
| `sidecar:bundle` | `bash scripts/bundle-sidecar.sh darwin arm64` |
| `electron:dist:mac` | `npm run build:frontend && npm run sidecar:bundle && npm --prefix electron run build && CSC_IDENTITY_AUTO_DISCOVERY=false npm --prefix electron run dist:mac && npm run check:electron-dist-mac-jwc && npm run check:app-icons` |
| `electron:start` | `npm --prefix electron run start` |
| `check:electron-sidecar-jwc` | `node scripts/check-electron-sidecar-jwc.cjs` |
| `check:electron-dist-mac-jwc` | `node scripts/check-electron-sidecar-jwc.cjs --server-root electron/dist/mac-arm64/cli-jaw.app/Contents/Resources/server` |
| `check:app-icons` | `node scripts/check-app-icon-assets.cjs` |
| `check:electron-no-native` | `node scripts/check-electron-no-native.cjs` |

> 현재 `package.json`에는 `lint` script가 없다.

### Direct smoke utilities

| utility | command | purpose |
| --- | --- | --- |
| Fullscreen TUI `/quit` PTY smoke | `JAW_TUI_SMOKE_TIMEOUT=15 COLUMNS=100 LINES=30 scripts/smoke/tui-quit-smoke.exp` | built `dist/bin/cli-jaw.js chat`가 raw-mode fullscreen composer에서 `/quit`로 정상 종료되는지 검증 |
| Fullscreen TUI frame resize stress | `npx tsx --import ./tests/setup/test-home.ts scripts/smoke/tui-frame-resize-stress.ts` | live/committed/expanded tool rows + final answer가 resize 후에도 width-safe이고 bottom composer cluster가 고정되는지 검증 |
| Fullscreen TUI WS sequence stress | `npx tsx --import ./tests/setup/test-home.ts scripts/smoke/tui-ws-sequence-stress.ts` | synthetic WS 이벤트로 live tool, final answer, Ctrl-O expansion, resize-safe frame을 서버/모델 없이 검증 |

### 실행 모드

| 모드 | 명령/엔트리 | 실제 동작 |
| --- | --- | --- |
| Source server dev | `npm run dev` | `tsx --env-file=.env server.ts`로 source server 실행 |
| CLI serve | `jaw serve` / `cli-jaw serve` | `bin/commands/serve.ts`가 source면 `tsx server.ts`, dist면 `node --dns-result-order=ipv4first server.js` spawn |
| CLI serve options | `--port`, `--host`, `--no-open`, `--lan`, `--remote`, `--trust-proxy`, `--trust-forwarded` | env로 `PORT`, `HOST`, `JAW_OPEN_BROWSER`, `JAW_LAN_MODE`, `JAW_REMOTE_ACCESS_MODE`, `JAW_TRUST_PROXY`, `JAW_TRUST_FORWARDED` 주입 |
| Frontend dev | `npm run dev:frontend` | Vite dev server port `5173`, `/api` proxy는 `http://localhost:3458` |
| Frontend build | `npm run build:frontend` | Vite가 `public/index.html` + `public/manager/index.html`을 `public/dist`로 빌드 |
| Manager dashboard | `jaw dashboard serve` | `src/manager/server.ts` 또는 `dist/src/manager/server.js` 실행, 기본 port `24576` |
| Electron manager dashboard | Electron implicit spawn | Web/CLI lane `24576`과 분리된 manager port `24577` 기본값, fallback `24578-24590`; packaged app prefers bundled sidecar `server/bin/jaw` |
| Docker local source | `Dockerfile` | local source copy → `npm run build` + `npm run build:frontend` → `node dist/server.js` |
| Docker npm image | `Dockerfile.dev` | `npm install -g cli-jaw@${CLI_JAW_VERSION}` → `jaw serve --no-open` |
| Compose | `docker-compose.yml` | 단일 `jaw` service, `${PORT:-3457}:3457`, `.env`, named volume `jaw-data` |

### 환경변수

| 변수 | 실제 사용처 | 의미 |
| --- | --- | --- |
| `CLI_JAW_HOME` | `src/core/config.ts`, `bin/cli-jaw.ts`, `bin/postinstall.ts` | 데이터 홈 override. 기본 `~/.cli-jaw` |
| `PORT` | `server.ts`, `bin/commands/serve.ts`, CLI API commands | server port. 기본 `3457` |
| `HOST` | `bin/commands/serve.ts` | serve child env로 전달 |
| `JAW_OPEN_BROWSER` | `server.ts`, `serve.ts` | `serve` 실행 후 브라우저 open 여부 |
| `JAW_LAN_MODE` | `server.ts`, `serve.ts` | LAN host/origin bypass 활성화 |
| `JAW_REMOTE_ACCESS_MODE` | `serve.ts` | `--remote`에서 `direct`로 주입 |
| `JAW_TRUST_PROXY` | `server.ts`, `serve.ts` | Express trust proxy 설정 |
| `JAW_TRUST_FORWARDED` | `server.ts`, `serve.ts` | forwarded host/proto 신뢰 |
| `JAW_AUTH_TOKEN` | `server.ts`, `doctor.ts` | loopback 외 API bearer auth token |
| `JAW_BOSS_TOKEN` | `src/core/boss-auth.ts`, `bin/commands/dispatch.ts` | boss-only employee dispatch token |
| `JAW_EMPLOYEE_MODE` | `bin/commands/dispatch.ts` | employee 내부 dispatch 차단 |
| `TELEGRAM_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS` | `src/core/config.ts` | Telegram settings override |
| `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_IDS` | `src/core/config.ts` | Discord settings override |
| `DASHBOARD_PORT`, `DASHBOARD_SCAN_FROM`, `DASHBOARD_SCAN_COUNT`, `JAW_DASHBOARD_OPEN` | `bin/commands/dashboard.ts`, `src/manager/server.ts` | Manager dashboard 실행/scan 설정 |
| `LOG_LEVEL` | `src/core/logger.ts` | logger verbosity |
| `CLI_JAW_SKIP_OFFICECLI`, `CLI_JAW_FORCE_OFFICECLI`, `OFFICECLI_REPO` | `bin/postinstall.ts` | officecli postinstall 제어 |
| `JAW_SAFE`, `npm_config_jaw_safe` | `bin/postinstall.ts` | postinstall safe mode |
| `CLI_JAW_MIGRATE_SHARED_PATHS`, `npm_config_jaw_migrate_shared_paths` | `bin/postinstall.ts` | shared path migration opt-in |
| `TEST_PORT` | `package.json` `test:smoke` | smoke test target port |

### Docker 설정

| 파일 | 실제 내용 |
| --- | --- |
| `Dockerfile` | `node:22-slim`, `python3 make g++ chromium curl`, non-root `jaw`, `npm ci --ignore-scripts && npm rebuild better-sqlite3`, `npm run build && npm run build:frontend`, `CLI_JAW_HOME=/home/jaw/.cli-jaw`, `PORT=3457`, healthcheck `/api/health`, entrypoint `node --dns-result-order=ipv4first dist/server.js` |
| `Dockerfile.dev` | `node:22-slim`, npm global `cli-jaw@${CLI_JAW_VERSION}` (`ARG CLI_JAW_VERSION=latest`), `/api/health` build guard, `CLI_JAW_HOME=/home/jaw/.cli-jaw`, `PORT=3457`, entrypoint `jaw serve --no-open` |
| `docker-compose.yml` | `jaw` service, `build: .`, `container_name: cli-jaw`, `${PORT:-3457}:3457`, `env_file: .env`, `jaw-data:/home/jaw/.cli-jaw`, `restart: unless-stopped`, `/dev/shm` tmpfs 512m |

### `scripts/` 실제 파일

`atomic-build.sh`, `bundle-sidecar.sh`, `check-app-icon-assets.cjs`, `check-cli-bin-links.cjs`, `check-copilot-gap.ts`, `check-deps-offline.ts`, `check-deps-online.sh`, `check-electron-no-native.cjs`, `check-electron-sidecar-jwc.cjs`, `check-strict-baseline.mjs`, `check-web-ui-build-output.ts`, `collect-fresh-install-evidence.sh`, `audit-fresh-install-evidence.mjs`, `verify-release-evidence.mjs`, `electron-dev-manager.mjs`, `ensure-native-modules.cjs`, `fresh-install-smoke.ts`, `i18n-registry.ts`, `install-officecli.ps1`, `install-officecli.sh`, `install-wsl.sh`, `install.sh`, `link-current-nvm-bin.cjs`, `postinstall-guard.cjs`, `prepare-sidecar-package-json.cjs`, `release-gates.mjs`, `release-preview.sh`, `release.sh`, `smoke/opencode-external-dir-smoke.ts`, `smoke/tui-frame-resize-stress.ts`.

---

## src/core/ — runtime support cluster (30 files, 3803L)

`boss-auth.ts`, `config.ts`, `codex-config.ts`, `instance.ts`, `runtime-path.ts`, `main-session.ts`, `message-summary.ts`, `path-expand.ts`, `runtime-settings.ts`, `runtime-settings-gate.ts`, `settings-merge.ts`, `db.ts`, `bus.ts`, `employees.ts`, `i18n.ts`, `compact.ts`, `logger.ts`, `claude-install.ts`, `launchd-cleanup.ts`, `launchd-plist.ts`, `tcc.ts`.

| Module | 역할 |
| --- | --- |
| `config.ts` | 경로/설정/CLI 탐지 + `JAW_HOME`/`settings.json`/`skills_ref`/`messaging`/`network` defaults |
| `codex-config.ts` | Codex `config.toml` context window sync |
| `instance.ts` | launchd/systemd용 instance ID + node/jaw binary resolution |
| `runtime-path.ts` | 서비스/launchd 환경에서 PATH 정규화 (`~/.local/bin`, `~/.claude/local/bin`, nvm/fnm/asdf/bun/homebrew 포함) |
| `main-session.ts` | active_cli/session_id/model/working_dir/effort sync + reset helpers |
| `message-summary.ts` | message preview/summary helper |
| `path-expand.ts` | shell-style path expansion helper |
| `runtime-settings.ts` | `applyRuntimeSettingsPatch()` 진입점, workingDir 재생성, messaging restart |
| `runtime-settings-gate.ts` | settings mutation in-flight gate |
| `settings-merge.ts` | nested settings deep merge (`telegram`, `discord`, `messaging`, `memory`, `stt`, `tui`, `network`) |
| `db.ts` | SQLite session/messages/memory/employees/employee_sessions/orc_state/jaw_ceo_transcript |
| `bus.ts` | broadcast hub + named listener lifecycle |
| `employees.ts` | default employee seeding + static/virtual synthetic employee helpers + regenerate |
| `i18n.ts` | locale normalize + `t()` |
| `compact.ts` | compact marker / transcript helpers |
| `logger.ts` | minimal console logger shim |
| `boss-auth.ts` | boss/employee scope 분리용 auth helper |
| `claude-install.ts` | Claude CLI 설치 상태 점검 helper |
| `launchd-cleanup.ts` | launchd stale plist / runtime cleanup |
| `launchd-plist.ts` | launchd plist 생성 helper |
| `tcc.ts` | macOS TCC / screen-recording 권한 점검 |

---

## src/cli/registry.ts — CLI/모델 단일 소스 (231L)

**의존 없음** — `core/config.ts`, `cli/commands.ts`, `server.ts`, 프론트엔드가 모두 이 레지스트리를 참조.

| Export | 역할 |
| --- | --- |
| `CLI_REGISTRY` | 13개 CLI 정의 (`pi`, `agy`, `ai-e`, `claude`, `claude-e`, `codex`, `codex-app`, `cursor`, `gemini`, `grok`, `kiro-code`, `opencode`, `copilot`; `label`, `binary`, `defaultModel`, `defaultEffort`, `efforts`, `models`, optional `effortNote`/provider metadata) |
| `CLI_KEYS` | `Object.keys(CLI_REGISTRY)` — 순서 보장 배열 |
| `DEFAULT_CLI` | 기본 CLI (`claude` 우선, 없으면 첫 항목) |
| `buildDefaultPerCli()` | registry에서 기본 `perCli` 객체 빌드 |
| `buildModelChoicesByCli()` | CLI별 모델 목록 맵 빌드 |

---

## src/cli/api-auth.ts — CLI Auth Helper (45L)

CLI → 서버 API 호출 시 인증 토큰을 관리하는 경량 헬퍼. 포트별 토큰 캐싱으로 멀티 인스턴스를 지원한다.

| Function | 역할 |
| --- | --- |
| `getCliAuthToken(portOrBase?)` | `settings.json`에서 `authToken` 읽기. 포트별 캐시 |
| `authHeaders(extra?)` | `{ Authorization: 'Bearer <token>', ...extra }` 헤더 생성 |
| `cliFetch(url, init?)` | `fetch()` + 자동 auth header 주입 래퍼 |

사용처: `dispatch.ts`, `orchestrate.ts`, `reset.ts`, `employee.ts`, `memory.ts`, `browser.ts`, `tui/api.ts`

---

## src/core/config.ts — 경로, 설정, CLI 탐지 (528L)

**상수**: `JAW_HOME` (`CLI_JAW_HOME` env || `~/.cli-jaw`) · `PROMPTS_DIR` · `DB_PATH` · `SETTINGS_PATH` · `HEARTBEAT_JOBS_PATH` (`heartbeat.json`) · `UPLOADS_DIR` · `SKILLS_DIR` · `SKILLS_REF_DIR` · `MIGRATION_MARKER` · `DEFAULT_PORT` (`3457`) · `CDP_PORT_OFFSET` (`5783`) · `APP_VERSION` (package.json)

| Function | 역할 |
| --- | --- |
| `ensureDirs()` | `prompts/`, `uploads/`, `skills/`, `skills_ref/` 생성 |
| `runMigration()` | legacy `claw.db`/project-local settings → `~/.cli-jaw/` migration |
| `loadSettings()` | settings.json 로드 + normalize/migration |
| `saveSettings(s)` | 설정 저장 |
| `replaceSettings(s)` | ESM live binding 대체 |
| `loadHeartbeatFile()` / `saveHeartbeatFile()` | `heartbeat.json` 읽기/쓰기 |
| `deriveCdpPort(serverPort?)` | server port + offset으로 browser CDP port 계산, overflow/invalid는 9240 |
| `getServerUrl(port)` | `http://localhost:${port || process.env.PORT || settings.port || DEFAULT_PORT}` |
| `getWsUrl(port)` | websocket URL 생성 |
| `detectCli(name)` | `buildServicePath()`를 적용한 `which`/`where` 기반 바이너리 존재 확인 |
| `detectAllCli()` | registry 기반 CLI 상태 반환 |
| `buildDefaultPerCli()` | registry에서 기본 perCli 빌드 |

`settings` 기본값에는 `showReasoning`, `channel`, `telegram.forwardAll`, `discord.forwardAll`, `messaging.lastActive/latestSeen`, `memory.autoReflectAfterFlush`, `memory.flushMessageWindow`, `avatar.*`, `stt.*`, `network.bindHost/lanBypass/remoteAccess`가 포함된다. `--home`은 `cli-jaw.ts`에서 `CLI_JAW_HOME`으로 주입된 뒤 이 모듈이 로드된다.

### Current registry defaults

| CLI | Default Model | Notable model aliases |
| --- | --- | --- |
| `pi` | `grok-composer-2.5-fast` | Pi RPC runtime with isolated profile/model registration |
| `agy` | native UI selected | print-mode runtime; no per-run model/effort flag |
| `ai-e` | `sonnet` | AI-E wrapper runtime |
| `claude` | `claude-opus-4-8` | canonical choices include `opus`, `sonnet`, `sonnet[1m]`, `haiku`; legacy aliases normalize |
| `claude-e` | `claude-opus-4-8` | helper-backed Claude E runtime |
| `codex` | `gpt-5.5` | includes `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex*`, `gpt-5.2-codex`, `gpt-5.1-codex*` |
| `codex-app` | `gpt-5.5` | Codex app-server runtime using Codex model choices |
| `cursor` | `composer-2.5` | uses `cursor-agent --model <resolvedModelId>`; effort resolves into model ids such as `composer-2.5-fast`, `gpt-5.5-medium-fast`, or `claude-opus-4-7-thinking-high-fast` |
| `gemini` | `gemini-3-flash-preview` | includes `gemini-3.0-pro-preview`, `gemini-3.1-pro-preview`, `gemini-2.5-pro`, `gemini-2.5-flash` |
| `grok` | `grok-build` | effort disabled because `grok-build` rejects `reasoningEffort`; auth/readiness via `grok models` |
| `opencode` | `opencode-go/kimi-k2.6` | includes current opencode-go provider aliases such as `glm-5.1`, `kimi-k2.6`, `mimo-v2.5`, `minimax-m2.7`, `qwen3.6-plus`, `deepseek-v4-*` |
| `copilot` | `claude-sonnet-4.6` | includes `gpt-5.5`, Claude 4.x aliases, `gpt-5.4*`, `gpt-5.3-codex`, `gpt-5.2-codex`, `gemini-3-pro-preview` |

---

## src/core/codex-config.ts — Codex config.toml Context Window Sync (78L)

`~/.codex/config.toml`에 `model_context_window`와 `model_auto_compact_token_limit` 키를 주입/제거한다. 1M Context 토글 변경 시 호출된다.

| Function | 역할 |
| --- | --- |
| `syncCodexContextWindow(cfg)` | enabled=true → upsert, enabled=false → remove |

---

## src/core/db.ts — Database (388L)

```sql
session   (id='default', active_cli, session_id, model, permissions, working_dir, effort, updated_at)
messages  (id PK, role, content, cli, model, trace, tool_log, cost_usd, duration_ms, working_dir, created_at)
memory    (id PK, key UNIQUE, value, source, created_at, updated_at)
employees (id PK, name, cli, model, role, status, created_at)
employee_sessions (employee_id PK, session_id, cli, model, created_at)
orc_state (id PK, state, ctx, updated_at)
queued_messages (id PK, payload, created_at)
jaw_ceo_transcript (id PK, at, role, text, source, created_at)
```

Virtual employees are not written to `employees` or `employee_sessions`. `src/core/employees.ts` emits `SyntheticEmployeeRow` values with `virtual:` IDs for one-off dispatch, and `src/orchestrator/distribute.ts` skips session resume/persist for those IDs.

`trace`, `tool_log`, and `working_dir` are added by in-place migration if missing. `working_dir` also gets `idx_messages_wd`; Jaw CEO transcript rows are bounded by the coordinator persistence layer.

| Prepared Statement | 용도 |
| --- | --- |
| `insertMessage` | `(role, content, cli, model, working_dir)` |
| `insertMessageWithTrace` | `(role, content, cli, model, trace, tool_log, working_dir)` |
| `getMessages` | working_dir 포함 UI/API 조회 |
| `getMessagesWithTrace` | full row 조회 |
| `getRecentMessages` | `WHERE working_dir = ? OR working_dir IS NULL` 히스토리 빌더용 |
| `insertQueuedMessage` / `listQueuedMessages` / `deleteQueuedMessage` | agent queue 영속화 |

---

## src/core/bus.ts — Broadcast Bus (57L)

순환 의존 방지 허브. 의존 0. Public audience는 `src/core/event-bus.ts`로 SSE publish하고, internal listener fan-out은 audience와 무관하게 수행한다. X-01 이후 current server에는 public WebSocket broadcast registration이 없다.

| Function | 역할 |
| --- | --- |
| `inferTopic(type)` | broadcast type → SSE topic 매핑 |
| `broadcast(type, data, audience?)` | public audience는 SSE publish, 모든 audience는 내부 리스너 fan-out |
| `addBroadcastListener(fn)` | 내부 리스너 추가 |
| `removeBroadcastListener(fn)` | 특정 핸들러 제거 |
| `clearAllBroadcastListeners()` | 테스트/초기화용 listener set 비우기 |

> `removeBroadcastListener(fn)`는 named handler lifecycle에 맞춰 정확히 해당 참조만 제거한다.

---

## src/messaging/ — shared messaging runtime (6 files, 506L)

Telegram/Discord 채널의 활성 타겟 상태와 outbound routing을 공유한다. `settings.messaging.lastActive/latestSeen`를 유지하고, `core/runtime-settings.ts`의 restart 경로가 이 레이어를 다시 초기화한다.

### runtime.ts (146L)

| Function | 역할 |
| --- | --- |
| `registerTransport()` | 채널별 init/shutdown 등록 |
| `getActiveChannel()` | 현재 활성 채널 반환 |
| `initActiveMessagingRuntime()` | 활성 채널 transport init |
| `shutdownMessagingRuntime()` | 전체 transport shutdown |
| `restartMessagingRuntime()` | active channel/active config가 바뀔 때만 restart |
| `setLastActiveTarget()` / `getLastActiveTarget()` | 마지막 활성 타겟 추적 |
| `setLatestSeenTarget()` / `getLatestSeenTarget()` | 최신 관측 타겟 추적 |
| `clearTargetState()` | stale target 제거 |
| `hydrateTargetsFromSettings()` | persisted `settings.messaging` 복원 |

### send.ts (147L)

| Export | 역할 |
| --- | --- |
| `ChannelSendRequest` | outbound request 타입 |
| `registerSendTransport()` | 채널별 send 함수 등록 |
| `normalizeChannelSendRequest()` | HTTP body → request 정규화 |
| `validateTarget()` | allowlist + target shape 검증 |
| `sendChannelOutput()` | explicit target > validated lastActive > validated latestSeen > configured fallback 순으로 전송 |

추가로 `validateTarget()`이 Telegram `allowedChatIds`와 Discord `channelIds`/thread parent를 같이 검사하고, stale cached target이면 `clearTargetState()`로 바로 비운다.

### session-key.ts (27L)

| Function | 역할 |
| --- | --- |
| `buildRemoteSessionKey(target)` | 리모트 세션 키 생성 |
| `groupQueueKey(origin, target)` | origin+target 큐 그룹 키 생성 |

### types.ts (27L)

`MessengerChannel` (`telegram` | `discord`), `RemoteTarget`, `OutboundType`, `RuntimeOrigin` 타입 정의.

---

## src/telegram/ — Telegram transport (4 files, 898L)

`bot.ts`, `forwarder.ts`, `telegram-file.ts`, `voice.ts`.

### bot.ts (624L)

Telegram transport main entry. `registerTransport('telegram', ...)`와 `registerSendTransport('telegram', ...)`를 등록하고, `settings.telegram.forwardAll`, allowlist, mention gating, voice, attachment, slash command 흐름을 모두 처리한다.

| Function | 역할 |
| --- | --- |
| `initTelegram()` | Bot 생성 + handler registration + forwarder lifecycle |
| `shutdownTelegram()` | Bot/forwarder shutdown |
| `makeTelegramCommandCtx()` | Telegram용 ctx 생성 + `applyRuntimeSettingsPatch()` |
| `syncTelegramCommands(bot)` | `getTelegramMenuCommands()` 기반 `setMyCommands` |
| `sendTelegramText()` | outbound text send |
| `buildTelegramTarget()` | `RemoteTarget` 생성 |

### forwarder.ts (105L)

`createTelegramForwarder()`는 `agent_done`만 forwarding하고, `shouldSkip`으로 Telegram-origin 결과를 제외한다. `createForwarderLifecycle()`는 detach/attach를 관리한다.

### voice.ts (36L)

`handleVoice(ctx)`는 Telegram voice 파일을 내려받아 `lib/stt.ts`로 전사한 뒤 `tgOrchestrate()`로 넘긴다.

### telegram-file.ts (133L)

Telegram file upload / retry helper. 텍스트가 아닌 media send와 attachment 전달에 사용된다.

### shared runtime points

- Telegram과 Discord는 모두 `src/messaging/runtime.ts`에 자기 transport를 등록한다.
- Telegram/Discord 설정 변경은 `core/runtime-settings.ts`를 통해 같은 restart 경로를 탄다.
- `settings.messaging.lastActive/latestSeen`는 forward 대상 복원용 공통 저장소다.
- `src/orchestrator/pipeline.ts`는 Telegram/Discord origin에만 21 Elicitation remote-channel guard를 동적으로 붙인다. A1 system prompt는 수정하지 않으며, accidental `elicitation` / `choice-buttons` fence 출력은 remote 응답 직전에 plain text numbered question fallback으로 normalize한다.

---

## src/discord/ — Discord transport (4 files, 605L)

`bot.ts`, `forwarder.ts`, `commands.ts`, `discord-file.ts`.

### bot.ts (386L)

Discord transport main entry. guild/DM message ingestion, `allowBots`, `mentionOnly`, channel allowlist, attachment handling, `registerTransport('discord', ...)`, `registerSendTransport('discord', ...)`를 담당한다.

### commands.ts (118L)

Guild-scoped slash command registration + execution. `getVisibleCommands('discord')`와 `makeCommandCtx('discord', ...)`를 사용한다. `/orchestrate` 스티어 경로는 Discord 채널로 collect 결과를 다시 전송한다.

### forwarder.ts (45L)

`agent_done` 결과를 Discord 채널로 chunked forwarding 한다.

### discord-file.ts (56L)

Discord attachment/file send helper.

---

## src/memory/ — persistent + advanced memory runtime (13 files, 3155L)

`memory.ts`, `runtime.ts`, `shared.ts`, `heartbeat.ts`, `heartbeat-schedule.ts`, `indexing.ts`, `keyword-expand.ts`, `bootstrap.ts`, `injection.ts`, `identity.ts`, `reflect.ts`, `advanced.ts`, `worklog.ts`.

### memory.ts (154L)

| Function | 역할 |
| --- | --- |
| `search(query)` | grep-rni 기반 검색 |
| `read(filename)` | 파일 읽기 |
| `save(filename, content)` | append 저장 |
| `list()` | 파일 목록 |
| `appendDaily(content)` | 일별 메모리 추가 |
| `loadMemoryForPrompt(maxChars)` | system prompt 주입용 |

### runtime.ts (374L)

Advanced memory runtime의 entry point. FTS5 인덱스, search routing, task snapshot, bootstrap, reindex 제어를 묶는다.

### injection.ts / identity.ts / reflect.ts

- `injection.ts`: 역할별(`boss`/`employee`/`subagent`/`flush`/`read_only_tool`) memory injection 정책과 search routing
- `identity.ts`: `shared/soul.md` 관리, soul read/update 경로
- `reflect.ts`: 최근 episode를 `shared/*`, `procedures/runbooks.md`, `shared/soul.md`로 승격

### heartbeat.ts / heartbeat-schedule.ts

주기 작업과 스케줄 파싱/실행을 담당한다. 현재 소스 오브 트루스는 `~/.cli-jaw/heartbeat.json`이며, schedule은 `every`/`cron` + `timeZone`을 지원한다. busy 중첩 시 `pendingJobs` 큐로 밀어두고, 프롬프트 앞에 memory search 지시를 자동 주입한다.

### indexing.ts / keyword-expand.ts / bootstrap.ts

index 준비, BM25/expansion, bootstrapping/import 흐름을 담당한다.

### worklog.ts / shared.ts

작업 스냅샷, 공통 타입/헬퍼, history persistence에 쓰인다.

### advanced.ts

이관 호환용 1-line shim.

---

## src/browser/ — Chrome CDP 제어

Chrome CDP 제어, 완전 독립 모듈.

| connection.ts (215L) | actions.ts (179L) |
| --- | --- |
| `findChrome()` | `snapshot(port, opts)` |
| `launchChrome(port)` | `screenshot(port, opts)` +dpr |
| `connectCdp(port)` | `click(port, ref, opts)` |
| `getActivePage(port)` | `type(port, ref, text)` |
| `getCdpSession(port)` | `press(port, key)` |
| `listTabs(port)` | `hover(port, ref)` |
| `getBrowserStatus(port)` | `navigate(port, url)` |
| `closeBrowser()` | `evaluate(port, expr)` |
|  | `getPageText(port, fmt)` |
|  | `mouseClick(port, x, y)` |

### vision.ts (204L) — Vision Click pipeline

| Function | 역할 |
| --- | --- |
| `extractCoordinates(path, target)` | provider 분기 좌표 추출 |
| `codexVision(path, target)` | Codex exec -i + NDJSON parse |
| `visionClick(port, target, opts)` | screenshot → vision → DPR 보정 → click → verify |

### launch-policy.ts (51L) — Browser launch policy

module-level policy로 `browser start` mode 정규화 + agent/debug/manual launch policy를 관리한다.

`index.ts` (13L) — re-export hub (mouseClick + visionClick 포함)

---

## lib/mcp-sync.ts — MCP 통합 관리 (1212L)

소스: `~/.cli-jaw/mcp.json`

| Function | 역할 |
| --- | --- |
| `loadUnifiedMcp()` | 통합 MCP 설정 로드 |
| `toClaudeMcp(config)` | Claude/Gemini `.mcp.json` 변환 |
| `toCodexToml(config)` | Codex `config.toml` 변환 |
| `toOpenCodeMcp(config)` | OpenCode `opencode.json` 변환 |
| `toCopilotMcp(config)` | Copilot `~/.copilot/mcp-config.json` 변환 |
| `syncToAll(config, workDir)` | 통합 → 지원 MCP-aware CLI 설정 동기화 |
| `copyDefaultSkills()` | 2×3 분류 + Codex 폴백 + registry.json 동기화 |
| `installMcpServers(config)` | npm -g / uv tool install |
| `ensureSymlinkSafe(target, linkPath, opts)` | symlink 보호 모드 |
| `safeMoveToBackup(pathToMove)` | 충돌 디렉토리 백업 이동 |
| `ensureSkillsSymlinks(workingDir, opts)` | 스킬 심링크 + 보호 결과 반환 |

Antigravity MCP sync is an existing config target at `~/.gemini/antigravity/mcp_config.json` via `lib/mcp/format-converters.ts`. It remains separate from the AGY runtime registry key `agy`; adding AGY runtime support does not make `ai-e.providers` include `agy`.

### symlink 보호 정책

- 실디렉토리 충돌 시 `fs.rmSync` 대신 `renameSync`로 백업
- 백업 경로: `~/.cli-jaw/backups/skills-conflicts/<timestamp>/`
- 결과가 로그/API 응답에 기록됨 (`status: ok/skip`, `action: noop/backup/create/conflict`)

## lib/quota-copilot.ts — Copilot Quota & Auth (328L)

Copilot 할당량 조회 + 인증 토큰 관리. env → file cache → `gh auth token` → macOS keychain 4단계 폴백.

| Function | 역할 |
| --- | --- |
| `hasCopilotAuthSync()` | 동기 인증 상태 확인 |
| `readCopilotTokenSync()` | 토큰 읽기 |
| `refreshCopilotFromKeychain()` | keychain 실패 리셋 + 캐시 클리어 + 재시도 |

## lib/stt.ts — Voice STT Engine (231L)

음성인식 엔진. Gemini REST API 직접 호출 → Whisper fallback. settings.json 연동.

| Function | 역할 |
| --- | --- |
| `transcribeVoice(path, mimeType)` | 음성 파일 → 텍스트 변환 |
| `getSttSettings()` | settings.json → env var 폴백 체인 |

## lib/upload.ts (184L)

파일 업로드 처리 + Telegram 다운로드.

---

## src/routes/ — API registration cluster (13 files, 1714L)

`server.ts`는 이제 보안 미들웨어와 base routes만 유지하고, 실제 API surface는 이 디렉터리의 registrar/helper로 나눈다.

| Module | 역할 |
| --- | --- |
| `types.ts` | `AuthMiddleware` shared type |
| `employees.ts` | employee CRUD |
| `heartbeat.ts` | heartbeat read/write |
| `skills.ts` | skill list/enable/disable/reset |
| `jaw-memory.ts` | jaw memory search/read/list/save/init/reflect/flush/soul |
| `avatar.ts` | avatar summary + image upload/delete/read |
| `i18n.ts` | locale bundle endpoints |
| `orchestrate.ts` | PABCD reset/state/workers/snapshot/queue steer/dispatch/worker result |
| `memory.ts` | memory status/KV/files/settings |
| `settings.ts` | settings/prompt/heartbeat-md/MCP/registry/status/quota/copilot |
| `messaging.ts` | upload/file-open/voice/telegram/channel/discord send |
| `browser.ts` | browser runtime endpoints |
| `quota.ts` | `/api/quota` helper readers imported by `settings.ts` (direct provider usage where supported, wrapper runtime delegation for `ai-e`/`claude-e`/`codex-app`, and status-only metadata for AGY/Cursor/Grok/OpenCode when quota windows are not exposed by the CLI) |

핵심 포인트:
- `server.ts`는 `register*Routes(app, requireAuth, ...)` 호출만 남기고 629L 글루 레이어로 유지된다. 현재 mutation endpoint 53개는 모두 `requireAuth` 미들웨어를 거쳐 인증 없는 상태 변경을 차단한다.
- `settings.ts`가 `/api/quota`를 소유하며, `quota.ts`는 route registrar가 아니라 helper module이다.
- `messaging.ts`가 `assertSendFilePath()`와 `execFileSync()` 기반 file open/send 보안을 담당한다.

---

## src/security/ — 보안 입력 검증 [P9.1]

**의존 없음** — server.ts에서 라우트 핸들러 진입 시 호출.

### path-guards.ts (111L)

| Function | 역할 |
| --- | --- |
| `assertSkillId(id)` | skill id 검증 + path segment 차단 |
| `assertFilename(f, opts)` | 확장자 화이트리스트 + path separator 차단 + 길이 제한 |
| `assertMemoryRelPath(input, opts)` | nested relative path 허용 + traversal 차단 |
| `assertSendFilePath(filePath, workingDir?)` | `JAW_HOME`/`workingDir`/OS temp 아래 파일만 전송 허용 |
| `safeResolveUnder(base, rel)` | `path.resolve` 후 base 디렉토리 탈출 검증 |

### decode.ts (21L)

| Function | 역할 |
| --- | --- |
| `decodeFilenameSafe(s)` | `decodeURIComponent` + 길이 제한 (512) + 에러 시 원본 반환 |

#### 적용 라우트

| 라우트 | 적용 guard |
| --- | --- |
| `/api/memory-files/:filename` | `assertFilename` + `safeResolveUnder` |
| `/api/upload` | `decodeFilenameSafe` |
| `/api/skills/enable`, `disable` | `assertSkillId` |
| `/api/jaw-memory/read`, `save` | `assertMemoryRelPath` + `normalizeAdvancedReadPath` |
| `/api/telegram/send`, `/api/channel/send` | `assertSendFilePath` |

---

## src/http/ — 응답 계약 [P9.2]

**의존 없음** — Express 라우트에서 직접 사용.

### response.ts (25L)

| Function | 역할 |
| --- | --- |
| `ok(res, data)` | `{ ok: true, ...data }` 200 응답 |
| `fail(res, status, error, extra)` | `{ ok: false, error, ...extra }` 에러 응답 |

### async-handler.ts (14L)

| Function | 역할 |
| --- | --- |
| `asyncHandler(fn)` | `Promise.catch(next)` 래퍼 |

### error-middleware.ts (26L)

| Function | 역할 |
| --- | --- |
| `notFoundHandler` | 404 → `fail(res, 404, 'not_found')` |
| `errorHandler` | 글로벌 에러 → 500 + 로깅 |

---

## bin/commands/ — CLI Subcommands

### bin/cli-jaw.ts — CLI Entrypoint

> 서브커맨드 라우터 + `--home` flag 처리 (manual `indexOf`, NOT parseArgs)
> `--home` → `process.env.CLI_JAW_HOME` 설정 후 config.ts 동적 import
> known-command guard: `--home` 사용 시 알려진 명령어(`serve`, `init`, `doctor`, `chat`, `employee`, `reset`, `mcp`, `skill`, `status`, `browser`, `memory`, `launchd`, `clone`, `service`, `dashboard`, `orchestrate`, `dispatch`)와 경로 누락을 구분

현재 subcommand router에 실제 등록된 명령은 `serve`, `init`, `doctor`, `chat`, `employee`, `reset`, `mcp`, `skill`, `status`, `browser`, `memory`, `launchd`, `clone`, `orchestrate`, `dispatch`, `service`, `dashboard`다.

### bin/commands/serve.ts

> Source/dist 자동 감지 foreground server 실행.

| Option | Env |
| --- | --- |
| `--port` | `PORT` |
| `--host` | `HOST` |
| `--open` / `--no-open` | `JAW_OPEN_BROWSER` |
| `--lan` | `JAW_LAN_MODE` |
| `--remote` | `JAW_REMOTE_ACCESS_MODE=direct` |
| `--trust-proxy` | `JAW_TRUST_PROXY` |
| `--trust-forwarded` | `JAW_TRUST_FORWARDED` |

### bin/commands/dashboard.ts

> `jaw dashboard serve [--port 24576] [--from 3457] [--count 50] [--no-open]`.
> `jaw dashboard service`는 현재 “later phase”로 거절된다.
> Electron app의 implicit manager spawn은 `24577-24590` lane을 사용하며 Web/CLI 기본 manager `24576`을 스캔하거나 공유하지 않는다.

| Option | Env |
| --- | --- |
| `--port` | `DASHBOARD_PORT` |
| `--from` | `DASHBOARD_SCAN_FROM` |
| `--count` | `DASHBOARD_SCAN_COUNT` |
| `--open` / `--no-open` | `JAW_DASHBOARD_OPEN` |

### bin/commands/clone.ts (165L)

> `jaw clone` — JAW_HOME 환경 복제. source 디렉토리 검증(존재 + settings.json 포함).
> `--from <path>`: 소스 지정. `--with-memory`: memory/ 디렉토리도 복사. `--link-ref`: skills_ref/ 심볼릭 링크.
> 복제 후 subprocess `regenerateB` 호출로 프롬프트/스킬 재생성.

| Function | 역할 |
| --- | --- |
| `cloneHome(args)` | 소스 검증 → 디렉토리 복사 → regenerateB 호출 |

### bin/commands/launchd.ts (163L)

> macOS launchd 서비스 관리. Multi-instance 지원.

| Function | 역할 |
| --- | --- |
| `instanceId()` | JAW_HOME → label 식별자 (`default` / `<name>-<md5hash8>`) |
| `xmlEsc(s)` | XML 특수문자 이스케이프 |
| `generatePlist(port)` | launchd plist XML 생성 |

- `parseArgs({ strict: false })` + manual unknown-key guard
- PLIST_PATH 더블-쿼팅으로 경로 공백 안전 처리
- `launchctl load/unload` 명령으로 서비스 시작/중지

### bin/commands/browser.ts / memory.ts

- `getServerUrl(undefined)` 패턴: PORT env 우선, 없으면 DEFAULT_PORT(`3457`)
- memory.ts: init 경로 `${JAW_HOME}/memory/` (하드코딩 `~/.cli-jaw` 제거)
