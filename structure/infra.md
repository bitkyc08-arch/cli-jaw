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
| version | `2.2.4` |
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
| `gate:redaction-sinks` | `node scripts/release-gates.mjs redaction-sinks` — channel replies/sends/loggers must route through a credential masker |
| `gate:electron-version` | `node scripts/release-gates.mjs electron-version` — `electron/package.json` version must equal the root `package.json` so desktop artifacts carry the release version |
| `sync:electron-version` | `node scripts/sync-electron-version.cjs` — writes the root version into `electron/package.json` and its lockfile; called by both release scripts before `gate:all` |
| `gate:gate-docs` | `node scripts/release-gates.mjs gate-docs` — `structure/INDEX.md` must list exactly the live gates, with the right count, and each must have its `gate:<name>` npm script |
| `gate:sidecar-prune-safety` | `node scripts/release-gates.mjs sidecar-prune-safety` — the sidecar prune list must never delete a package the server imports (a packaged app died on `node-fetch`) |
| `gate:native-load` | `node scripts/release-gates.mjs native-load` — `node-pty` must actually `dlopen` and `spawn-helper` must genuinely execute. Needs `electron/node_modules`, so it reports `SKIPPED` (exit 3) when absent and only hard-fails under `JAW_GATE_REQUIRE_NATIVE=1`, which `desktop-release.yml` sets after `npm ci --prefix electron` |
| `gate:sidecar-smoke` | `node scripts/release-gates.mjs sidecar-smoke` — critical sidecar modules must import from the bundled tree, not merely resolve. Reports `SKIPPED` (exit 3) with no bundle; hard-fails under `JAW_GATE_REQUIRE_SIDECAR=1` or when a caller passes `--server-root` explicitly, as `scripts/bundle-sidecar.sh` does right after bundling |
| `scripts/pick-gyp-python.sh` | prints a `python3` that can `import distutils`, which node-gyp still requires; wired into `electron:dist:mac` because Homebrew Python 3.12+ breaks the node-pty rebuild |
| `i18n:registry` | `tsx scripts/i18n-registry.ts` |
| `check:deps:online` | `bash scripts/check-deps-online.sh` |
| `prebuild`, `pretest`, `pretest:all`, `pretest:integration`, `pretest:smoke` | `npm run ensure:native` |
| `test` | `tsx --experimental-test-module-mocks tests/run.mts` — programmatic driver, `isolation:'process'` for subprocess DB isolation |
| `test:all` | `tsx --experimental-test-module-mocks tests/run.mts --all` |
| `test:integration` | `tsx --experimental-test-module-mocks --test tests/integration/*.test.ts` |
| `test:coverage` | `tsx --experimental-test-module-mocks --experimental-test-coverage tests/run.mts --all` |
| `test:watch` | `tsx --experimental-test-module-mocks tests/run.mts --watch` |
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
| `test:claude-e` | `cargo test --manifest-path native/claude-e/Cargo.toml` |
| `test:claude-exec` | compatibility alias for `test:claude-e` |
| `build` | `bash scripts/atomic-build.sh` — staged `dist/bin/cli-jaw.js` 실행권한을 보장한 뒤 atomic swap |
| `build:claude-e` | `cargo build --release --manifest-path native/claude-e/Cargo.toml` |
| `build:claude-exec` | compatibility alias for `build:claude-e` |
| `postbuild` | `node scripts/link-current-nvm-bin.cjs` — non-NVM Node에서는 링크를 skip하되 `dist/bin/cli-jaw.js` chmod repair는 먼저 수행 |
| `build:frontend` | `vite build --config vite.config.ts` |
| `qa:manager-frontend` | `npm run build:frontend && npm run typecheck:frontend` |
| `dev:frontend` | `vite --config vite.config.ts` |
| `preview:frontend` | `vite preview --config vite.config.ts` |
| `typecheck` | `tsc --noEmit` |
| `typecheck:frontend` | `tsc --noEmit -p tsconfig.frontend.json` |
| `gate:typecheck` / `gate:tests` / `gate:*` | `node scripts/release-gates.mjs <gate>` |
| `gate:all` | `node scripts/release-gates.mjs` |
| `prepublishOnly` | `npm run build && npm run build:frontend && npm run check:frontend-build-output` |
| `electron:dev` | `concurrently -k -n jaw,electron "node scripts/electron-dev-manager.mjs" "npm --prefix electron run dev"` |
| `electron:build` | `npm --prefix electron run build` |
| `sidecar:bundle` | `bash scripts/bundle-sidecar.sh darwin arm64` |
| `electron:dist:mac` | `npm run build:frontend && npm run sidecar:bundle && npm --prefix electron run build && CSC_IDENTITY_AUTO_DISCOVERY=false npm --prefix electron run dist:mac && npm run electron:resign:mac && npm run check:electron-dist-mac-no-jwc && npm run check:app-icons` |
| `electron:resign:mac` | `codesign --force --deep --sign - electron/dist/mac-arm64/cli-jaw.app` |
| `electron:start` | `npm --prefix electron run start` |
| `check:electron-sidecar-no-jwc` | `node scripts/check-electron-sidecar-no-jwc.cjs` |
| `check:electron-dist-mac-no-jwc` | `node scripts/check-electron-sidecar-no-jwc.cjs --server-root electron/dist/mac-arm64/cli-jaw.app/Contents/Resources/server` |
| `check:electron-dist-win-no-jwc` | `node scripts/check-electron-sidecar-no-jwc.cjs --server-root electron/dist/win-unpacked/resources/server` |
| `check:electron-dist-linux-no-jwc` | `node scripts/check-electron-sidecar-no-jwc.cjs --server-root electron/dist/linux-unpacked/resources/server` |
| `check:app-icons` | `node scripts/check-app-icon-assets.cjs` |
| `check:electron-no-native` | `node scripts/check-electron-no-native.cjs` |

> 현재 `package.json`에는 `lint` script가 없다.

### Windows npm install integrity and PowerShell shims

npm 12+ may block dependency lifecycle scripts unless `cli-jaw` is explicitly
approved. The supported one-shot recovery is
`npm install -g cli-jaw --allow-scripts=cli-jaw`; persist the narrow approval
with `npm config set allow-scripts=cli-jaw --location=user`. Do not use npm's
package-less printed variant or a wildcard approval. Run `jaw doctor` after
recovery: the install receipt check distinguishes completed, stale, blocked,
safe-mode, failed, and receipt-free `.git` development clones. Doctor also
lists verified `.cli-jaw-*` npm staging leftovers so a user can close the
locking process and remove them manually.

On native Windows npm may generate both `jaw.ps1` and `jaw.cmd`. PowerShell
execution policy applies to `jaw.ps1`, but not to `jaw.cmd`. Doctor probes
`Get-ExecutionPolicy` with a three-second bound: `Restricted`, `AllSigned`, and
`Undefined` warn; `RemoteSigned`, `Bypass`, and `Unrestricted` pass; probe
failure is informational. Recovery choices are:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
jaw.cmd doctor
node "$(npm prefix -g)\node_modules\cli-jaw\dist\bin\cli-jaw.js" doctor
```

The policy change is user-scoped. Operators who must not change policy can use
the cmd shim or direct Node entry point instead.

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
| Docker npm image | `Dockerfile` | `npm install -g cli-jaw@${CLI_JAW_VERSION}` → `jaw serve --no-open` |
| Docker local source | `Dockerfile.dev` | local source copy → `npm run build` + `npm run build:frontend` → `node dist/server.js` |
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
| `JAW_HUB_CALLBACK_URL` | `src/telegram/hub-callback.ts`, `src/manager/lifecycle.ts` | Telegram Hub member outbound callback override (loopback http only; manager spawn sets `http://127.0.0.1:${DASHBOARD_DEFAULT_PORT}`) |
| `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_IDS` | `src/core/config.ts` | Discord settings override |
| `DASHBOARD_PORT`, `DASHBOARD_SCAN_FROM`, `DASHBOARD_SCAN_COUNT`, `JAW_DASHBOARD_OPEN` | `bin/commands/dashboard.ts`, `src/manager/server.ts` | Manager dashboard 실행/scan 설정 |
| `LOG_LEVEL` | `src/core/logger.ts` | logger verbosity |
| `OFFICECLI_REPO` | `scripts/install-officecli.sh`, `scripts/install-officecli.ps1` | install 스크립트 소스 repo override (`lidge-jun/OfficeCLI` 기본) |
| `JAW_SAFE`, `npm_config_jaw_safe` | `bin/postinstall.ts` | postinstall safe mode |
| `CLI_JAW_MIGRATE_SHARED_PATHS`, `npm_config_jaw_migrate_shared_paths` | `bin/postinstall.ts` | shared path migration opt-in |
| `TEST_PORT` | `package.json` `test:smoke` | smoke test target port |

### Docker 설정

| 파일 | 실제 내용 |
| --- | --- |
| `Dockerfile` | `node:22-slim`, `python3 make g++ chromium curl`, non-root `jaw`, npm global `cli-jaw@${CLI_JAW_VERSION}` (`ARG CLI_JAW_VERSION=latest`), `CLI_JAW_HOME=/home/jaw/.cli-jaw`, `PORT=3457`, entrypoint `jaw serve --no-open` |
| `Dockerfile.dev` | `node:22-slim`, local source copy, `npm ci --ignore-scripts` (better-sqlite3 13은 prebuild 동봉이라 rebuild 불필요), `npm run build && npm run build:frontend`, `node dist/bin/postinstall.js`, `CLI_JAW_HOME=/home/jaw/.cli-jaw`, `PORT=3457`, entrypoint `node dist/server.js` |
| `docker-compose.yml` | `jaw` service, `build: .`, `container_name: cli-jaw`, `${PORT:-3457}:3457`, `env_file: .env`, `jaw-data:/home/jaw/.cli-jaw`, `restart: unless-stopped`, `/dev/shm` tmpfs 512m |

### `scripts/` 실제 파일

`atomic-build.sh`, `audit-fresh-install-evidence.mjs`, `bundle-sidecar.sh`, `capture-agy-quota-fixture.mjs`, `check-app-icon-assets.cjs`, `check-cli-bin-links.cjs`, `check-copilot-gap.ts`, `check-deps-offline.ts`, `check-deps-online.sh`, `check-electron-no-native.cjs`, `check-electron-sidecar-no-jwc.cjs`, `check-redaction-sinks.mjs`, `check-sidecar-prune-safety.mjs`, `check-strict-baseline.mjs`, `check-web-ui-build-output.ts`, `claim-audit.mjs`, `collect-fresh-install-evidence.sh`, `electron-dev-manager.mjs`, `ensure-native-modules.cjs`, `fresh-install-smoke.ts`, `i18n-registry.ts`, `install-officecli.ps1`, `install-officecli.sh`, `install-risk-gate.mjs`, `install-wsl.sh`, `install.sh`, `jwc-110-e2e.mjs`, `jwc-no-global-smoke.mjs`, `link-current-nvm-bin.cjs`, `pi-rpc-probe.mts`, `postinstall-guard.cjs`, `prepare-sidecar-package-json.cjs`, `release-1.6.0.sh`, `release-gates.mjs`, `release-preview.sh`, `promote-to-main.sh`, `pick-gyp-python.sh`, `require-release-evidence.mjs`, `signal-dashboard-restart.mjs`, `sync-electron-version.cjs`, `verify-fresh-install.sh`, `verify-release-evidence.mjs`, `smoke/opencode-external-dir-smoke.ts`, `smoke/tui-frame-resize-stress.ts`, `smoke/tui-fullscreen-frame-smoke.ts`, `smoke/tui-ws-sequence-stress.ts`.

---

## 시작 경로 안정성 계약 (start-path reliability)

`jaw <command>` 실행 시 네이티브 의존성 준비를 담당하는 표면. 유닛: `devlog/_fin/260803_runtime_stability_hardening/`.

### 실행 경로

```
jaw (전역 bin 심링크) → dist/bin/cli-jaw.js
                          └─ ensureNativeModulesReady(cmd)   [bin/cli-jaw.ts]
                               └─ 자식 프로세스: scripts/ensure-native-modules.cjs
bin/jaw (개발 클론 / 직접 호출 런처)
     └─ argv 기반 probe → 실패 시 위 스크립트에 위임
```

전역 설치 사용자는 `bin/jaw`를 거치지 않는다. `--help`/`--version` 등은 가드를 건너뛴다.

### `scripts/ensure-native-modules.cjs` 계약

| 항목 | 계약 |
| --- | --- |
| 실패 분류 | `missing` (해석 불가 **또는** 로드 시 `MODULE_NOT_FOUND`) / `abi` (dlopen·NODE_MODULE_VERSION) / `other` — `classifyNativeError()`로 export |
| 해석 검사 | `createRequire(root/package.json).resolve()`. `node_modules` 디렉터리 존재 여부로 판정하지 않음 (PnP 등) |
| `missing` 행동 | rebuild 금지. `npm install` 안내 + exit 1 |
| `abi` 행동 | 잠금 획득 → 재probe → 1회 rebuild → 재probe |
| `other` 행동 | rebuild 금지. Node 버전/ABI/platform/arch 출력 후 exit 1 |
| 잠금 위치 | `tmpdir()/jaw-native-rebuild-<sha256(realpath(root)).16>.lock` — **`node_modules` 밖** (npm install이 지울 수 있으므로) |
| 잠금 획득 | `mkdirSync({recursive:false})` 원자성. 최대 5분 대기 |
| 잠금 회수 | 소유자 PID를 `process.kill(pid, 0)`로 probe. `ESRCH`=회수, `EPERM`=살아있음. 시간(`LOCK_STALE_MS`)은 PID를 못 읽을 때만 쓰는 backstop |
| ABI 판정 범위 | 의도적으로 **넓게** 유지 (기존 자동복구 퇴행 방지). 좁힌 것은 `missing`뿐 |

현재 설치본 better-sqlite3 **12.8.0**은 `install` 훅(`prebuild-install || node-gyp rebuild --release`)이 있어
`npm rebuild`가 복구 경로다 (로컬 `node_modules`에서 확인). 상위 메이저에서 번들 prebuilds로 전환되며
훅이 사라진다는 보고가 있으므로 — 로컬에서 검증 불가 — **업그레이드 시 이 가정을 반드시 재확인할 것.**

### `bin/jaw` 런처 규칙

- 경로를 **JavaScript 소스로 보간하지 않는다** — argv로 전달 (공백·아포스트로피·유니코드 안전)
- `readlink -f`를 요구하지 않는다 (GNU 확장; stock macOS/BSD에 없음) — `realpath` → Node `fs.realpathSync`
- 복구 분기의 `cd`는 서브셸에 가둔다 — `exec`되는 CLI가 호출자의 cwd를 유지해야 함
- 복구 실패 시 `exec`하지 않는다 — 종료코드 검사 후 진단과 함께 exit

### 프로세스 종료 계약 (`src/agent/spawn/process-kill.ts`)

지연 SIGKILL 승격은 반드시 `killProcessTreeIfAlive()`를 거친다. 판정 기준은
`exitCode !== null || signalCode !== null`이며 **`ChildProcess.killed`가 아니다** —
`killed`는 "시그널을 보냈다"는 뜻이라 아직 실행 중인 프로세스도 `true`가 된다.
가드 없이 승격하면 SIGTERM 후 재사용된 PID를 죽일 수 있고, `killProcessTree`가
`pgrep -P`로 재귀하므로 무관한 프로세스의 하위 트리까지 함께 죽는다.

### 회귀 가드 테스트

`tests/unit/cli-native-guard-contract.test.ts`, `launcher-portability.test.ts`,
`native-repair-lock.test.ts`, `kill-escalation-liveness.test.ts`.
마지막 파일에는 가드 없는 지연 SIGKILL이 새로 추가되면 실패하는 스윕 테스트가 있다.

---

## 런타임 수명주기 계약 (openclaw/hermes 파리티)

유닛: `devlog/_fin/260804_runtime_parity_openclaw_hermes/`.

### 턴 종료 — `close`이지 `exit`이 아니다

턴은 `child.on('close')`에서 resolve된다. `close`는 자식 종료가 아니라 **stdio 스트림이
전부 닫혀야** 발생하므로, stdio를 상속한 자손이 살아있으면 오지 않는다.
`src/agent/spawn/exit-drain.ts`의 `releaseChildOutputAfterExit()`가 이 대기를 경계 짓는다:

| 상수 | 값 | 역할 |
|------|-----|------|
| `EXIT_DRAIN_IDLE_MS` | 100ms | 마지막 데이터 이후 유휴 유예. 새 데이터가 오면 **재무장** |
| `EXIT_DRAIN_MAX_MS` | 1000ms | 절대 상한 |

idle 만료 시 `setImmediate`로 이벤트 루프 poll 턴을 **한 번 양보**한 뒤 destroy한다 —
부하 걸린 루프는 이미 버퍼에 있는 데이터보다 타이머를 먼저 관측할 수 있기 때문이다.
모든 타이머는 `unref()`되고, `close`/`error` 양쪽 경로에서 정리 함수를 호출한다.

**주의:** 워치독은 이 상황을 구제하지 못한다. 자식은 이미 죽었고, PID 재사용 가드가
(올바르게) kill을 건너뛴다. 파이프 destroy만이 유일한 해소 수단이다.

### 출력 누적 상한 — 원시 stdout에만 필요하다

| 대상 | 상한 | 이유 |
|------|------|------|
| 미완 NDJSON 라인 (`spawn/line-buffer.ts`) | 8 MiB, head 보존 | 개행 없는 스트림이 라인 버퍼를 무한히 키운다. 실측 200 MiB 입력 → 힙 1.5 GiB |
| agy/kiro `fullText` | 8 MiB / `maxBytes` | **원시 plain-text stdout**을 직접 축적 |
| 파싱된 assistant 이벤트 경로 | 없음 (의도적) | 상류가 유한. 과거 상한이 실제 최종 답변을 잘라먹은 사고(`8b4ce983b`) |
| `stderr` | 4000자 (스트리밍 append 전부) | 진단 전용 |

절단은 항상 **보고**한다. 조용한 절단은 금지다.

### 진행(progress) 판정

워치독은 진행 신호에 종류를 부여한다: `output`(원시 출력, 약한 신호) / `rate-limit` / `structured`.
stall 사유에 `lastProgress=<kind>`를 남기므로, `lastProgress=output x47`은
**턴이 전진했다는 증거 없이 출력만 흘렀다**는 뜻이다.

deadline 계산은 종류와 무관하다 — `markProgress()`는 어떤 kind로 호출되든 동일하게
`absoluteDeadline`을 갱신하며, `absoluteHardCapMs`(4시간)가 상한이다. 즉 종류 태깅은
**진단 전용**이고 타임아웃 동작을 바꾸지 않는다.

휴리스틱(`text.trim().length > 10`)을 좁히지 않은 이유는 주요 엔진(agy·kiro·grok)이
각자 raw chunk 또는 파싱 이벤트 경로에서 `markProgress`를 직접 호출하기 때문이다.
`watchdog.ts`만 좁혀도 그 엔진들의 liveness는 그대로다.

### 재시도 — 부작용 게이트

프롬프트를 재실행하는 **세 경로**(main 429 / employee transient / **fallback**)는
모두 `performedSideEffects(ctx)`를 확인한다.

```ts
const REPEATABLE_TOOL_TYPES = new Set(['search', 'thinking']);
// search = grep/web-search/read-url, thinking = 추론 스트림
// command/file/subagent + 미지의 타입 = 부작용 (fail closed)
```

재시도는 같은 프롬프트를 다시 돌리므로 이전 시도가 실행한 도구가 **다시 실행**된다.
`_skipInsert`는 로컬 DB 행만 막고 외부 전송·커밋·파일 쓰기는 막지 못한다.
거부된 재시도는 이유를 로그로 남긴다.

`isTransientStartup`은 **출력이 없을 때만** 인정된다 — 이름이 약속하는 "작업 시작 전"을
구현이 보장하게 했다.

### 회귀 가드 테스트

`exit-drain.test.ts`, `line-buffer-bound.test.ts`, `raw-stdout-capture-bound.test.ts`,
`progress-semantics.test.ts`, `retry-side-effect-gate.test.ts`, `retry-stall-ordering.test.ts`.

---


### session-generation.ts / access-policy.ts / remote-command-context.ts (M4-A0)

M4-A2a adds opaque `issueApprovalCallback` / `resolveApprovalCallback` on the in-memory `DispatchApprovalStore`. Telegram operator DMs attach Approve/Deny buttons (`appr:`/`aprd:` opaque ids). Discord operator DMs attach Approve/Deny buttons (same `appr:`/`aprd:` ids). Slack stays text-only until Block Kit send exists. HTTP still has no approve endpoint. Store `generation` is the process boot UUID (`restart_void`); callback `sessionGeneration` is `chat_sessions.generation`.

`src/core/session-generation.ts` owns persistent `chat_sessions.generation` (additive PRAGMA/ALTER). This integer is not `src/agent/session-persistence.ts` process-local spawn ownership. `replaceRemoteSessionGeneration` rebinds one conversation onto one session in a single transaction because `remote_session_bindings.chat_session_id` is UNIQUE. `src/messaging/access-policy.ts` is default-deny substrate (`deny` / `allowlist` / `paired` / `all`) with no production caller until M4-A1. `src/messaging/remote-command-context.ts` names `{channel, actorId, conversationKey, chatSessionId, generation}` so the three transports cannot invent three shapes.

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

## src/core/platform-kind.ts — 플랫폼 분류 단일 소스

`windows-native | wsl | linux | darwin | other` 를 판정하는 유일한 기준점.
플랫폼을 다시 유추하는 코드를 새로 만들지 말고 이 모듈을 호출한다.

### 엄격 규칙

`process.platform` 이 먼저다. `win32` 프로세스는 어떤 환경변수가 들어와도
`windows-native` 이고, WSL 분기는 `linux` 에서만 도달할 수 있다. 두 값은
구조적으로 겹치지 않는다.

**`WSLENV` 은 판정에 쓰지 않는다.** Microsoft 문서상 이 변수는 Windows 쪽과
공유되는 값이라 WSL 안에 있다는 증거가 못 된다. 실제로 doctor 와 postinstall
이 이 변수를 검사하는 바람에, WSL interop 을 설정해 둔 네이티브 Windows
사용자에게 "WSL 안에서 Windows Node 를 쓰고 있다"는 경고가 나갔다.

### API

| 함수 | 역할 |
| --- | --- |
| `resolvePlatformKind(platform, env, probes)` | 플랫폼 분류. 모든 입력이 주입 가능하므로 한 OS 에서 전체 매트릭스를 테스트할 수 있다 |
| `isWindowsNative(platform)` | `platform === 'win32'`. env 를 받지 않는 것이 의도다 |
| `isWsl(platform, env, probes)` | WSL 여부 |
| `isWindowsNodeLaunchedFromWsl(platform, cwd)` | WSL 디렉터리에서 실행된 Windows Node. 환경변수가 아니라 UNC 작업 디렉터리(`\\wsl$\`, `\\wsl.localhost\`)로 판정한다 |
| `resolveInvocationCwd(env)` | `INIT_CWD` 우선. npm lifecycle script 는 패키지 루트에서 돌기 때문에 `process.cwd()` 로는 사용자의 디렉터리를 알 수 없다 |

WSL 증거는 `WSL_DISTRO_NAME`, `WSL_INTEROP`, `/run/WSL`,
`/proc/sys/fs/binfmt_misc/WSLInterop`, 그리고 `osrelease`/`/proc/version` 의
`microsoft` 문자열이다. 마지막 항목은 커스텀 커널에서 빠질 수 있어 경로 마커가
백업 역할을 한다.

### 위임 사이트 (4곳)

`src/core/browser-open.ts`, `src/core/browser-open-default.ts`,
`src/browser/connection.ts`, `bin/commands/doctor.ts` 가 모두 이 모듈로
위임한다. `tests/unit/platform-kind-delegation.test.ts` 가 이 네 파일에
`WSL_DISTRO_NAME`/`WSL_INTEROP`/`WSLENV` 나 `/proc/version` 직접 참조가 없는지
검사한다.

`bin/postinstall.ts` 는 위임 사이트가 아니다. "이 Windows 프로세스가 WSL
디렉터리에서 시작됐는가"라는 다른 질문을 하므로 `isWindowsNodeLaunchedFromWsl`
을 쓴다.

`src/lib/tui/terminal.ts` 는 의도적으로 제외했다. 루트 `tsconfig.json` 이
`src/lib/tui` 를 제외하고 있고 그 파일의 `$env` 는 객체가 아니라 함수라서,
타입 검사도 되지 않는 vendored 번들을 굳이 통과시킬 이유가 없다.

브라우저 헬퍼들은 `probes` 파라미터를 받는다. 이게 없으면 desktop-linux
픽스처가 실제 호스트의 `/proc` 를 읽어서 WSL 러너에서 결과가 뒤집힌다.

### Windows serve 로깅

`jaw serve` 는 상속받은 stdout/stderr 출력을 그대로 유지하면서 두 스트림을
`<JAW_HOME>\logs\serve.log` 에 append 한다. 서버 시작 시 파일이 5 MiB 이상이면
기존 `serve.log.1` 을 교체하고 현재 파일을 그 이름으로 한 단계 rotate 한다.

PowerShell `Start-Process -RedirectStandardOutput/-RedirectStandardError` 는 대상
파일을 시작마다 생성하거나 truncate한다. 따라서 이 옵션을 instance-owned
`serve.log` 에 연결하지 않는다. 별도 운영자 로그가 필요하면 child PowerShell의
append redirection을 사용한다.

```powershell
$jawHome = 'C:\jaw\worker-a'
$logDir = Join-Path $jawHome 'logs'
$outLog = Join-Path $logDir 'serve.out.log'
$errLog = Join-Path $logDir 'serve.err.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$jaw = (Get-Command jaw.cmd -ErrorAction Stop).Source
$command = "& '$jaw' --home '$jawHome' serve --no-open 1>> '$outLog' 2>> '$errLog'"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
Start-Process powershell.exe -ArgumentList '-NoProfile', '-EncodedCommand', $encoded -WindowStyle Hidden
```

---

## src/cli/registry.ts — CLI/모델 단일 소스 (231L)

**의존 없음** — `core/config.ts`, `cli/commands.ts`, `server.ts`, 프론트엔드가 모두 이 레지스트리를 참조.

| Export | 역할 |
| --- | --- |
| `CLI_REGISTRY` | 12개 CLI 정의 (`pi`, `agy`, `ai-e`, `claude`, `claude-e`, `codex`, `codex-app`, `cursor`, `grok`, `kiro-code`, `opencode`, `copilot`; `label`, `binary`, `defaultModel`, `defaultEffort`, `efforts`, `models`, optional `effortNote`/provider metadata) |
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
| `agy` | AGY-selected | print-mode runtime; `--model` is capability-gated (observed in AGY 1.1.4); no separate effort flag. Model values must be the tier-bearing label form that `agy --model` accepts on its own, e.g. `Gemini 3.6 Flash (Medium)`. A bare tier-less slug such as `gemini-3.5-flash` is rejected (`requires --effort`) because cli-jaw never sends `--effort` for AGY. Note `agy models` prints effort-suffixed slugs (`gemini-3.6-flash-medium`), which is a different form — do not copy that output into the registry |
| `ai-e` | `sonnet` | AI-E wrapper runtime |
| `claude` | `claude-opus-4-8` | canonical choices include `opus`, `sonnet`, `sonnet[1m]`, `haiku`; pinned full IDs include `claude-opus-5`/`claude-opus-5[1m]`; legacy aliases normalize |
| `claude-e` | `claude-opus-4-8` | helper-backed Claude E runtime |
| `codex` | `gpt-5.5` | inactive ocx fallback shows only `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`; when ocx health is ok, `/model` completions and `/api/cli-registry` expand from ocx `/v1/models` including routed models |
| `codex-app` | `gpt-5.5` | Codex app-server runtime using the same inactive fallback / active ocx model choices as `codex` |
| `cursor` | `composer-2.5` | uses `cursor-agent --model <resolvedModelId>`; effort resolves into model ids such as `composer-2.5-fast`, `gpt-5.5-medium-fast`, `claude-opus-5-xhigh`, or `claude-opus-4-7-thinking-high-fast` |
| `grok` | `grok-build` | effort disabled because `grok-build` rejects `reasoningEffort`; auth/readiness via `grok models` |
| `opencode` | `opencode-go/kimi-k2.6` | includes current opencode-go provider aliases such as `glm-5.1`, `kimi-k2.6`, `mimo-v2.5`, `minimax-m2.7`, `qwen3.6-plus`, `deepseek-v4-*` |
| `copilot` | `claude-sonnet-4.6` | includes `gpt-5.5`, Claude 4.x aliases, `gpt-5.4*`, `gpt-5.3-codex`, `gpt-5.2-codex` |

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

## src/messaging/ — shared messaging runtime (22 files)

### durable-ingress.ts / ingress-audit.ts

`IngressJournal` is the SQLite record of every inbound Telegram/Discord/Slack event. Transports call `admitIngress`/`settleIngress`; operators inspect and recover with `jaw messaging ingress list|show|replay|audit`. `requestReplay` is a state CAS back to `received`. Nothing in-process re-runs the handler — vendor redelivery does. Replay audit is append-only JSONL at `$JAW_HOME/messaging-ingress-audit.jsonl`.


Telegram/Discord/Slack 채널의 활성 타겟 상태와 outbound routing을 공유한다. `settings.messaging.lastActive/latestSeen`를 유지하고, `core/runtime-settings.ts`의 restart 경로가 이 레이어를 다시 초기화한다. Persisted target은 channel/target/peer kind와 optional thread/guild/parent 필드까지 검증한 뒤 복원한다.

`thread-target.ts` — `threadIdNumber(target)` extracts `message_thread_id` for programmatic Telegram sends (P0 forum topic support).

### 채널 공통 하드닝 모듈 (260802)

Slack 채널 유닛에서 확립한 전송 규율을 Discord/Telegram에 소급 적용하며 추가된
공유 레이어. 채널별 구현을 두면 한쪽만 고쳐지는 문제가 반복되어, 전 채널이 지나는
choke point로 모았다.

| 파일 | 역할 |
| --- | --- |
| `chunk.ts` | 무손실 분할. 서로게이트 페어를 쪼개지 않고, 코드펜스 균형과 언어 태그를 유지한다. Discord/Slack/Telegram이 모두 이 코어를 쓴다. **단서**: delimiter 자체가 채널 한도보다 길면(백틱 2,001개짜리 유효 fence 등) 재개가 한도를 넘기므로 펜스 복구를 포기한다 — 무손실·서로게이트 안전·한도 준수는 그대로 유지되고, continuation이 prose로 렌더링될 뿐이다. |
| `fold.ts` | 정규화 폴딩. escape 디코드 + invisible 제거 + NFKC를 고정점까지 반복하며, 각 문자가 원문 어디서 왔는지 오프셋 맵으로 추적한다. **좌표계는 전부 UTF-16 code unit.** |
| `redact.ts` | 크리덴셜 마스킹. `redactOutboundText`(본문), `redactOutboundPayload`(keyboard 등 구조화 payload), `userErrorText`/`logErrorText`(오류)를 제공한다. |
| `dedupe.ts` | 배달 중복 제거. TTL seen-set이며, sweep은 **만료된 항목만** 지운다 — 미만료 항목을 크기 맞추려 쫓아내면 막으려던 중복이 다시 생긴다. |
| `retry.ts` | 전송 실패 분류. `format`만 형식 폴백을 얻고, `rate-limit`은 대기 후 같은 형식 재시도, `ambiguous`는 중복 전송 위험이 있어 중단한다. |

마스킹은 **전송 직전(last mile)**에 건다. 호출부마다 걸면 반드시 하나가 누락되고,
실제로 감사 과정에서 반복해서 발견됐다. 오류 경로만으로는 부족하다 — 크리덴셜은
평범한 메시지 본문·캡션·버튼 라벨·로그 preview로도 흐른다.

### runtime.ts (146L)

| Function | 역할 |
| --- | --- |
| `registerTransport()` | 채널별 init/shutdown 등록 |
| `getEnabledChannels()` | 현재 enabled 채널 목록 반환 |
| `getHomeChannel()` | 현재 home 채널 반환 |
| `initEnabledMessagingRuntimes()` | enabled 채널 각각 transport init |
| `shutdownMessagingRuntime()` | 전체 transport shutdown |
| `restartMessagingRuntime()` | enabled set, per-channel config, locale 변경 시 영향 채널만 restart (home-only 변경은 restart 없음) |
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
| `validateTarget()` | allowlist + full target shape 검증. 빈 Slack allowlist에서 explicit target은 검증된 `lastActive/latestSeen`의 같은 conversation/thread만 재사용 가능 |
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

## src/telegram/ — Telegram transport (9 files)

`bot.ts`, `forwarder.ts`, `rich-message.ts`, `telegram-file.ts`,
`elicitation-buttons.ts`, `voice.ts`, `hub-callback.ts`,
`status-update-buffer.ts`, `fetch-body.ts`.

- `bot.ts` — thread-aware programmatic send (P0) + hub-member outbound relay (P2b)
- `rich-message.ts` — Bot API 10.1 rich Markdown, the default outbound text path
- `elicitation-buttons.ts` — single_select fences rendered as inline keyboards
- `hub-callback.ts` — loopback-only SSRF guard for hub callback URL
- `status-update-buffer.ts` — coalesces tool-status edits
- `fetch-body.ts` — IPv4-pinned fetch body helper

### bot.ts (859L)

Telegram transport main entry. `registerTransport('telegram', ...)`와 `registerSendTransport('telegram', ...)`를 등록하고, `settings.telegram.forwardAll`, allowlist, mention gating, voice, attachment, slash command 흐름을 모두 처리한다.

미들웨어 순서가 중요하다: self-echo 가드 → 로깅 → allowlist → mention gating → dedupe.
dedupe이 마지막인 이유는 앞 게이트에서 버려질 트래픽이 seen-set을 채우지 않게 하기
위해서다 — 처리 대상인 중복은 어차피 같은 게이트를 통과하므로 보장은 그대로다.
self-echo 가드는 `getMe()`로 얻은 봇 id를 쓰고, 그 호출이 끝나기 전 구간은 `is_bot`
플래그로 덮는다. 로깅보다 앞에 두어 자기 에코가 로그를 오염시키지 않게 한다.
`settings.telegram.allowBots`는 Discord와 대칭이며 기본 false다. P0: thread-aware programmatic send via `thread-target.ts`. P2b: hub-member outbound relay to Dashboard `/api/dashboard/telegram-hub/outbound`.

| Function | 역할 |
| --- | --- |
| `initTelegram()` | Bot 생성 + handler registration + forwarder lifecycle |
| `shutdownTelegram()` | Bot/forwarder shutdown |
| `makeTelegramCommandCtx()` | Telegram용 ctx 생성 + `applyRuntimeSettingsPatch()` |
| `syncTelegramCommands(bot)` | `getTelegramMenuCommands()` 기반 `setMyCommands` |
| `sendTelegramText()` | outbound text send |
| `buildTelegramTarget()` | `RemoteTarget` 생성 (`threadId` when `message_thread_id` present) |

### forwarder.ts (105L)

`createTelegramForwarder()`는 `agent_done`만 forwarding하고, `shouldSkip`으로 Telegram-origin 결과를 제외한다. `createForwarderLifecycle()`는 detach/attach를 관리한다.

### voice.ts (36L)

`handleVoice(ctx)`는 Telegram voice 파일을 내려받아 `lib/stt.ts`로 전사한 뒤 `tgOrchestrate()`로 넘긴다.

### telegram-file.ts (133L)

Telegram file upload / retry helper. 텍스트가 아닌 media send와 attachment 전달에 사용된다. Optional `{ threadId }` for forum topics.

### hub-callback.ts (19L)

`resolveHubCallback()` — loopback-only SSRF guard for hub-member outbound callback URL. Default `http://127.0.0.1:24576`.

### shared runtime points

- Telegram과 Discord는 모두 `src/messaging/runtime.ts`에 자기 transport를 등록한다.
- Telegram/Discord 설정 변경은 `core/runtime-settings.ts`를 통해 같은 restart 경로를 탄다.
- `settings.messaging.lastActive/latestSeen`는 forward 대상 복원용 공통 저장소다.
- `src/orchestrator/pipeline.ts`는 Telegram/Discord origin에만 21 Elicitation remote-channel guard를 동적으로 붙인다. A1 system prompt는 수정하지 않으며, accidental `elicitation` / `choice-buttons` fence 출력은 remote 응답 직전에 plain text numbered question fallback으로 normalize한다.

### Dashboard Telegram Hub (`src/manager/telegram-hub/` — 3 files)

Forum supergroup topic → managed instance port routing. Config in `DashboardRegistry.telegramHub`. Routes at `/api/dashboard/telegram-hub` (loopback-only). `hub-bot.ts` owns single-bot long-poll; hub commands `/setthread`, `/threads`, `/hubhelp`. Manager UI: `TelegramHub.tsx`. See `telegram.md` § Telegram Hub.

---

## src/discord/ — Discord transport (7 files, 858L)

`bot.ts`, `forwarder.ts`, `commands.ts`, `discord-file.ts`,
`send-only-client.ts`, `channel-types.ts`, `register.ts`.

### bot.ts (432L)

Discord transport main entry. guild/DM message ingestion, `allowBots`, `mentionOnly`, channel allowlist, attachment handling, `registerTransport('discord', ...)`, `registerSendTransport('discord', ...)`를 담당한다.

### commands.ts (119L)

Guild-scoped slash command registration + execution. `getVisibleCommands('discord')`와 `makeCommandCtx('discord', ...)`를 사용한다. `/orchestrate` 스티어 경로는 Discord 채널로 collect 결과를 다시 전송한다.

### forwarder.ts (85L)

`agent_done` 결과를 Discord 채널로 chunked forwarding 한다.

### discord-file.ts (67L)

Discord attachment/file send helper.

### send-only-client.ts (88L)

REST-only client for sends that must not require a gateway session.

### channel-types.ts (50L) · register.ts (17L)

Channel narrowing helpers and slash-command registration.

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

주기 작업과 스케줄 파싱/실행을 담당한다. 현재 소스 오브 트루스는 `~/.cli-jaw/heartbeat.json`이며, schedule은 `every`/`cron` + `timeZone`을 지원한다. PABCD 활성, heartbeat 중첩, main agent busy 상태에서는 `pendingJobs` 큐로 밀어두고, user message queue가 먼저 비워진 뒤 heartbeat pending을 drain한다. 프롬프트 앞에는 memory search 지시를 자동 주입한다. (#252) job별 opt-in `runner: main|employee|script`(기본 main; employee는 `claimWorker`+`runSingleAgent`, busy 시 `skipped: employee busy` 경고 리포트; script는 argv `execFile` no-shell)와 `reportPolicy: always|anomaly_only|silent` + 구조화 리포트 계약(`heartbeat-report.ts`: status/changed/record_required/user_visible/summary/evidence/next_action)을 지원한다. `[SILENT]`/quiet marker는 정책과 무관하게 우선하며, silent 정책 anchor는 `delivered_at NULL` + "recorded (not sent)" 주입 문구로 구분된다. main runner는 `orchestrateAndCollectData`의 `agyPlannerOnly` 신호(#251)에 1회 한정 재시도한다. PUT `/api/heartbeat`는 UI가 모르는 runner 필드를 job id 기준 merge-by-id로 보존한다.

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
| `propagateSkillsToInstances()` | base `skills_ref`를 `~/.cli-jaw-*` instances로 동기화하고, 각 instance의 synced `skills_ref` 기준으로 default active skills를 활성화 (`baseActive` fallback 포함) |
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

## src/routes/ — API registration cluster (36 files, 6700L)

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
| `quota.ts` | `/api/quota` helper readers imported by `settings.ts` (direct provider usage where supported, wrapper runtime delegation for `ai-e`/`claude-e`/`codex-app`, reverse-engineered AGY Gem/Cla windows when `antigravity-usage --json` is available, and status-only metadata for Cursor/Grok/OpenCode or CLIs without quota windows) |

핵심 포인트:
- `server.ts`는 `register*Routes(app, requireAuth, ...)` 호출만 남기고 635L 글루 레이어로 유지된다. 현재 mutation endpoint는 모두 `requireAuth` 미들웨어를 거쳐 인증 없는 상태 변경을 차단한다.
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
> known-command guard: `--home` 사용 시 알려진 명령어는 `bin/cli-jaw.ts`의 `_knownCmds`와 같다 (`serve` … `slack`, `messaging` 포함). 경로 누락과 서브커맨드를 구분한다

현재 subcommand router는 `bin/cli-jaw.ts` switch와 같다. Messaging operator surface: `jaw messaging ingress list|show|replay|audit`.

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
