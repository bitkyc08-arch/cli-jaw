# cli-jaw

System-level AI agent with full computer control via CLI wrapping (pi, agy, ai-e, claude, claude-e, codex, codex-app, cursor, kiro-code, gemini, grok, opencode, copilot).

## Repository Structure

```
lidge-jun/cli-jaw              ← public (this repo)
├── skills_ref/  (submodule)   ← lidge-jun/cli-jaw-skills (public reference skills)
├── devlog/      (submodule)   ← lidge-jun/cli-jaw-internal (private)
└── .npmignore                 ← npm publish 시 submodules 제외
```

### Remote / 브랜치 정책 (푸시 전 필수)

`origin`은 `https://github.com/lidge-jun/cli-jaw.git` 이다. 체크아웃에 따라
`bitkyc08-arch/cli-jaw` 로 남아 있을 수 있는데, 이건 **같은 저장소의 옛 이름**이라
GitHub이 리다이렉트해 준다. 동작은 하지만 `gh`(항상 `lidge-jun/cli-jaw` 로 해석)와
이름이 갈려서 "이슈는 A에, 푸시는 B에" 처럼 보이는 착시를 만든다. 발견하면 고칠 것:

```bash
git remote -v                                                    # 확인
git remote set-url origin https://github.com/lidge-jun/cli-jaw.git
```

**작업은 전부 `dev` 에서 한다. `main` 과 `preview` 는 머지만 받는 브랜치다.**
거기에 직접 커밋하지 않는다.

**`dev` 는 항상 `main` 위에 fast-forward 가능한 상태로 유지한다.** merge 커밋으로
main 을 끌어와 히스토리를 갈래지게 만들지 말고, rebase 로 main 바로 위에 올린다:

```bash
git fetch origin
git branch -f backup/dev-pre-rebase-$(date +%y%m%d) HEAD   # 되돌릴 지점
git rebase origin/main
git merge-base --is-ancestor origin/main HEAD && echo ff-able
git push --force-with-lease origin dev
```

rebase 중 만나는 충돌은 대개 두 종류이고 해소법이 정해져 있다.

- **버전 파일**(`package.json`, `package-lock.json`, `electron/*`): main 쪽을 취한다
  (`--theirs`). 이건 릴리스 장부이지 작업 산출물이 아니다. 오래된 preview 승격
  커밋이 replay 되려 하면 `git rebase --skip` — 버전을 되돌리는 것 말고 하는 일이 없다.
- **`structure/str_func.md`**: 어느 쪽도 고르지 말고 실제 트리에서 다시 만든다.
  줄 수는 파생값이다 — `bash structure/verify-counts.sh --fix` 후 재검증.

**`dev` 푸시는 `test.yml` 을 돌린다 (#521부터).** 예전에는 아무것도 돌지 않아서
`a241c6222` 같은 커밋이 check-run 0개로 `dev` 위에 앉아 있었다. 다만
`postinstall-platform.yml` 은 여전히 `preview`/`main` push 와 `pull_request` 에만
반응하므로 **설치 표면(installer surface) 증거는 `dev` 푸시로 얻을 수 없고**,
피처 브랜치는 여전히 PR 을 열어야 CI 가 돈다.

`dev` 가 릴리스 브랜치가 된 것은 아니다. `publish.yml` 은 인증 런을 SHA 로 찾되
**`preview`/`main` 런만** 받아들이고(`:76` 의 `headBranch` 필터, #521 에서 좁힘),
승격은 `--branch preview` 로 찾는다(`scripts/promote-to-main.sh:28-34`). 이 필터가
필요한 이유는 위 ★ 단계가 매 사이클 `dev` 를 preview head 로 맞추기 때문이다 —
같은 SHA 에 양쪽 런이 생기므로, 필터가 없으면 `dev` 런이 릴리스를 인증할 수 있었다.
확인은 어느 경우든 SHA 대조로 한다:

```bash
git rev-parse HEAD
gh pr checks <n>
gh run view <run-id> --json headSha,conclusion
```


### 릴리스 절차 (dev → preview → main → npm)

개발은 `dev` 에서만 한다. `preview` 와 `main` 은 이 절차를 통해서만 움직인다.

```bash
git checkout dev && git fetch origin
git rebase origin/main                      # ff-able 유지
bash scripts/release-preview.sh             # 버전 범프 + gate:all + preview 푸시 + preview publish
git push origin dev                         # dev 를 preview head 와 같게 맞춘다  ★
bash scripts/promote-to-main.sh             # preview CI 인증 확인 → main 승격 → stable publish
```

**★ 를 빼먹으면 다음 사이클이 어긋난다.** `release-preview.sh` 는 버전 범프를
현재 브랜치에 커밋하고 `HEAD:preview` 로 푸시한다. 그 커밋을 `dev` 에도 올리지
않으면 origin/dev 만 뒤처진 채 남는다.

#### 승격은 fast-forward 다 (#480)

`promote-to-main.sh` 는 stable 버전 범프를 **preview 위에** 커밋하고, preview 를
거기까지 ff 한 뒤, CI 인증이 끝나면 `main` 을 **같은 커밋으로** ff 한다. PR 도
squash 도 없다. 그래서:

- `main` 은 preview 에 없는 커밋을 절대 갖지 않는다. 조상 관계가 정의상 유지되므로
  재정렬이라는 단계 자체가 없다.
- npm 에 발행되는 SHA 가 CI 가 인증한 SHA 와 **문자 그대로 같다.** 같은 트리의 복사본이
  아니다. `publish.yml` 의 `certified-sha` 우회 장치가 필요 없어진 이유다.
- 스크립트 말미가 `dev` 도 같은 커밋으로 ff 한다. dev 가 이미 앞서 있으면 건드리지
  않고 `NOTE:` 를 남기므로, 그때는 `git merge origin/main` 으로 dev 에 릴리스 선을
  들여놓는다.

`main` 푸시는 `--force` 를 쓰지 않는다. non-ff 를 git 이 스스로 거부하는 것이 이
구조의 실제 보증이므로, 실패하면 강제로 밀지 말고 왜 갈라졌는지부터 볼 것.

예전에는 squash 승격이 매 사이클 조상 관계를 끊었고, 그 복구가 수동이라 #418 의
durable queue-notice store 가 통째로 사라진 채 `cli-jaw@2.17.13` 이 발행됐다.
#468 이 자동 재정렬로 그 증상을 막았지만 dev 와 preview 에 각각 다른 커밋을 만들어
두 브랜치를 영구히 갈라놓았다(쌍둥이 8개 누적). ff 승격은 그 원인을 없앤다.

#### 게이트가 막을 때

- **`origin/main is not an ancestor of the certified preview SHA`** — preview 를
  force-push 해서 main 이 조상에서 빠졌거나, **승격이 이미 끝난 뒤 스크립트를 다시
  돌린** 경우다. `git log --oneline origin/preview..origin/main` 으로 main 이 이미
  그 버전을 갖고 있는지부터 볼 것. 갖고 있으면 승격은 성공한 것이고 재실행할 일이
  아니다 — `promote-to-main.sh` 는 승격 후 재실행을 지원하지 않는다.
- **`No successful Postinstall Platform Checks run found for <sha>`** — 승격이
  preview 의 CI 를 기다린 뒤 main 을 ff 하므로 보통은 나지 않는다. 그래도 났다면
  해당 SHA 의 preview push 런이 실패했거나 아직 안 끝난 것이다. 런이 끝나기를
  기다렸다가 publish 만 다시 dispatch 하면 된다. 승격을 되돌릴 필요는 없다.
- **`! [rejected] ... (non-fast-forward)`** — main 이 preview 에 없는 커밋을 갖고
  있다는 뜻이다. **강제로 밀지 말 것.** 무엇이 main 에만 들어갔는지
  (`git log --oneline origin/preview..origin/main`) 부터 확인하고, 그것을 preview 로
  가져와 다시 ff 가 되게 만든다.

#### 배포 확인은 npm 버전만으로 부족하다

설치 호스트에서 **실행 중인 프로세스가 새 `dist/` 를 로드했는지**까지 본다.
`npm i -g` 는 파일만 교체하고 서비스는 옛 코드를 계속 돌린다:

```bash
ssh <host> 'export PATH=~/.local/bin:$PATH; jaw --version'
ssh <host> 'grep -c <new-symbol> ~/.local/lib/node_modules/cli-jaw/dist/src/<path>.js'
ssh <host> 'export PATH=~/.local/bin:$PATH; jaw service restart'
ssh <host> 'ps -o lstart= -p $(sed -n "s/.*pid.: *\\([0-9]*\\).*/\\1/p" ~/.cli-jaw/jaw.pid.json|head -1)'
```

프로세스 시작 시각이 `dist/` mtime 보다 이르면 아직 옛 코드가 돌고 있다는 뜻이다.
비대화형 `ssh` 는 `.zshrc` 를 읽지 않으므로 PATH 를 직접 줘야 `jaw` 를 찾는다.

### Clone

```bash
# 코드만
git clone https://github.com/lidge-jun/cli-jaw.git

# 코드 + skills + devlog (private 권한 필요)
git clone --recursive https://github.com/lidge-jun/cli-jaw.git
```

**Windows**: 추적 경로 길이는 `npm run check:path-length` 가 150자로 묶는다 (`gate:all` 포함).
상한이 260(MAX_PATH)이 아닌 이유는 실패 지점에 맞추면 clone 위치가 한 단계만 깊어져도
다시 깨지기 때문이다 — #430 의 경로는 223자였고, 200 상한에서도 74자 접두사 + 186자 경로가 다시 260에 걸렸다(#432). 150이면 74자 접두사 기준 224라 여유가 있다.

이 게이트가 있어도 예전 커밋을 체크아웃하면 긴 경로를 만날 수 있다. 그때 clone 은
**절반만 실패한다**: 앞선 서브모듈은 정상이고 하나만 비어 있어 워킹트리가 멀쩡해 보인다.

```bash
git -c core.longpaths=true clone --recursive https://github.com/lidge-jun/cli-jaw.git
```

### Submodule Update

서브모듈 수정 후 반드시 메인 레포에서도 ref 커밋:

```bash
cd devlog  # 또는 skills_ref
git add -A && git commit -m "update" && git push
cd ..
git add devlog && git commit -m "chore: update devlog ref" && git push
```

### devlog 접근

`devlog/` 는 private 레포입니다. 접근 필요 시 [Issue](https://github.com/lidge-jun/cli-jaw/issues)에서 collaborator 권한을 요청하세요.

### Kanban

프로젝트 보드: https://github.com/users/lidge-jun/projects/2/views/1

### Architecture Docs Sync

- Native event foundation: `src/shared/runtime-contract.ts` + `src/agent/runtime/*` own canonical Codex/Pi projections and optional explicit outcomes. `agent_runtime`/`agent_runtime_gap` publish directly to SSE, bypassing messaging listeners. Native compatibility terminals carry only finality/status and existing trace identity; no public partial/outcome object. Preserve legacy final selection when outcome is absent, and interrupted MESSAGE salvage before exit settlement. See `structure/runtime-integration.md` and `structure/stream-events.md`; Activity layout/default settings are separate follow-on work.
- Runtime selection: only Cursor/Grok/Claude accept `perCli.<cli>.transport`; existing absence stays print before defaults merge. Native switchable keys prefix the whole legacy bucket with `native-v1:` and never overwrite the print singleton. Capture transport/bucket once, forward through lifecycle persistence/compact, and keep scoped resets exact. Unsupported main/worker native adapters fail before print/fallback work; compiled support in `/api/cli-status` is separate from cached auth/binary readiness. Codex App/Pi keys remain unchanged.
- Claude native: the optional SDK, shared pool/host and existing lifecycle own sequential main turns, fresh worker assignments, immutable terminal claims, hard Stop and interrupted MESSAGE before exit-settle. Default steer remains kill/resume, never advertised as in-band. Auto/safe decisions use live requests; deny/unknown profiles fail before preparation, including the memory extractor. Images are bounded and child activity is foreground-only. Child declarations reconcile from both parent/child frames; their ID ownership survives child completion and is not the same as live permission eligibility. Pre-start failure/Stop use one cached fallback before compatibility output; `onlyIfRunning` preserves finished trace headers.

- Cursor native main: explicit native/auto only; restrictive permissions and unsupported workers fail before `regenerateB`, bucket/bootstrap/snapshot, detection or pool work. `AcpRuntimeSession` keeps raw final/partial independent of bounded Activity and claims an immutable logical result before lifecycle; passive finalization survives main-map removal. Native run cleanup holds the exact lease through application settlement and uses captured exit-barrier identity. Server-explicit scope/chat bindings survive multi-session off; private identity-only I/O liveness keeps the owning collector alive without messaging content. Preserve legacy/manual compact while excluding print-era automatic compact/count heuristics from explicit native outcomes.
- `structure/` is the current architecture-doc hub; do not point new docs at `devlog/structure/`.
- Keep `README.md`, root `AGENTS.md`, root `CLAUDE.md`, and `structure/AGENTS.md` synchronized when command/API/orchestration surfaces change.
- Recent non-strict hotspots: explicit `/continue`, workflow helper slash commands (`/plan` as PABCD P compatibility guide, `/interview`, `/deliberate`, `/planaudit`, `/review`, `/search`, `/goal`, `/goalplan`, `/team`, `/task`, `/fork`, `/gd`; forward PABCD transitions require `cli-jaw orchestrate <phase> --attest '{"from","to","did",...}'`), pre-prompt context hooks (`context-hooks.json`, `cli-jaw hooks`), bounded local search contract (narrow-path Grep/rg; external search via active search skill), Telegram Hub P0–P4 (`structure/telegram.md`, `/api/dashboard/telegram-hub`), goal pause gate continuation suppression (`goal_pause_gate_pending`), `tests/run.mts` programmatic test driver, `/goal plan` and `/goalplan` store user direction as `planHint` and require `/goal refine` before checkpoints; agent pause first-tap state is exposed as derived `pauseGate` on status/API surfaces while persisted status remains `active`; bounded automation is `/goal run ...`, not top-level `/autopilot`), Codex App clean-install default with opt-in migration for existing settings, bounded child-backed nullable CLI status, read-only OpenCodex root-URL/live-health diagnostics, Pi top-level `pi --mode rpc` runtime with isolated `PI_CODING_AGENT_DIR` profiles, AGY `-p` print-mode runtime with capability-probed optional `--model` (observed in AGY 1.0.12), Grok weekly quota via `~/.grok/auth.json` + Grok Build billing gRPC-web before legacy monthly fallback, SSE-first `GET /api/events` event channel with WebSocket fallback, bounded tool-log sanitizer, worker progress query/watch, canonical `/api/channel/send`, heartbeat `every`/`cron` schedules, heartbeat Slack mention watch inside `runHeartbeatJob` (`mentionWatch`, bot-token `conversations.history` scan instead of user-token-only `search.messages`, frontier/resume/round-robin/429 stop/60-channel cap, per-item busy yield, server-owned thread send then seen receipt, at-least-once delivery; the ledger is keyed by `(jobId, workspaceId, userId)` with the workspace id taken from a per-token `auth.test` rather than `settings.slack.teamId`, pre-v2 rows hold a job in a durable SQLite quarantine cleared only by `POST /api/heartbeat/:jobId/mention-watch-fresh-start` with a new `since`, and a duplicate job id in one PUT is a 400; the answer turn carries the answered thread's `chatSessionId` but runs in a dedicated `mention-watch:<remoteKey>` scope so inbound Slack cannot steer it, with a per-conversation guard of `getState(remoteKey) === 'IDLE'` + `hasChatSessionWork` + non-blocking `sessionLanes.hasPending`, and the thread session is minted only on admission)
, browser runtime diagnostics/session lifecycle, Electron Node sidecar packaging, private active `k-writing` routing for Korean promotional/content writing, inbound ACK reactions and queue-notice lifecycle owned by `src/messaging/ack-reaction.ts` + `src/messaging/queue-notice.ts` (channels supply transport factories only; the notice is deleted only AFTER a successful answer and rewritten on timeout/shutdown; `QueueNoticeRegistry.drain` bounds shutdown and actually aborts; ACK settles immediately after successful text delivery and BEFORE the optional image relay, because uploads are uncancellable and would otherwise strand the reaction on `running` after the answer is already visible), canonical platform classification via `src/core/platform-kind.ts` (`windows-native|wsl|linux|darwin|other`; `process.platform` decides first and `WSLENV` is never a WSL signal), and `npm run gate:all`.
- Standalone lifecycle is home-scoped: `jaw --home <path> service stop|restart [--port N]` verifies `<JAW_HOME>/jaw.pid.json` before signalling; registered launchd/systemd instances delegate to their native manager. Never recommend killing every Node process.
- Slack connection environment variables own their matching fields at runtime. Settings exposes only variable names and conservatively locks connection editing/reset while any are present; CLI setup refuses mixed input. Generic settings writes reject only env-owned paths, and persistence strips only those fields so env values never enter `settings.json` or erase unrelated file-backed credentials.
- Slack-triggered Boss turns receive `channel_id` and parent `thread_ts` in the per-turn user prompt regardless of multi-session state; agents must use that explicit context for Slack lookup/send APIs instead of parsing session labels.
- Optimization/score-maximization goals follow the optimization-loop discipline (LOOP-PHASE-DEATH/CONTINUITY/CANDIDATE-ANCHOR/INSTANCE-CHECK + GATE-ORACLE-VALIDITY):
  classify candidate changes, ban a class after 3 consecutive discards, force evaluator-gate work on repeated D-phase deaths.
  Canonical: dev-pabcd §10, dev-testing §9.5; injected via orchestration template and goal continuation.
- `structure/` reading map: start at `structure/INDEX.md`; depth — `telegram.md` (Hub), `prompt_flow.md` (attest/hooks/bounded search), `stream-events.md` (pause gate/SSE), `infra.md` (test scripts), `commands.md` + `server_api.md` (slash/API surfaces). Concurrent inbound gateway docs: `structure/INDEX.md` §gateway, `structure/infra.md` §`src/messaging/`, `structure/telegram.md` §common messaging layer; legacy `settings.channel` is a deprecated read-only alias for one major version.

- Grok main native ACP requires literal auto, existing advertised authentication/model/effort, and no leader. Its optional common replacement strategy waits for original cancellation and drain, preserves one logical final, commits input only after local dispatch with current ownership, and never queues fatal failures. Restrictive policies and workers fail before preparation. Sync `structure/runtime-integration.md`.

### Native decisions

Activity journal: `src/trace/activity-{journal,control,retention}.ts` owns bounded immutable runtime rows and private control metadata. Capture durable chat/scope on all trace starts; internal append is allowed, public replay is not. Session discovery/replay and owned raw routes require the explicit original session under existing instance auth. Only original message links backfill owners; forks cannot acquire source traces. Keep `onlyIfRunning` close ordering, first-loss metadata, whole-prefix retention and final/Slack independence. Sync `structure/runtime-integration.md`, `server_api.md`, `stream-events.md`; timeline/default/print presentation are separate layers.

`src/agent/runtime/requests.ts` and `acp/callbacks.ts` own bounded pending decisions, opaque native-option mapping and cancellation latches. `GET /api/runtime/requests?sessionId=...` and `POST /api/runtime/requests/:id` use the existing instance auth policy (including loopback/LAN bypass), never a current-session fallback. Match run/session/scope/turn and current ownership before answering. Canonical sanitization and the32KiB event preflight precede insertion; global128/120s and per-connection32 bounds apply. An admitted ACP selected write cannot be retracted: cancellation during dispatch retires the connection. Route-owned `agent_runtime_requests_changed` is an SSE-only metadata hint: its scope routes to the captured chat's presentation surface, while live GET/POST retain original execution scope. The Classic request panel keeps stream health separate from manual REST freshness and never retries POST automatically. Do not broadcast notices to messaging or infer Activity defaults/history from this panel. Sync `structure/runtime-integration.md` and `structure/server_api.md`.

### Concurrent inbound gateway (M1)

- Settings schema v4 replaces top-level `channel` with `messaging.enabledChannels` (array) and `messaging.homeChannel`. New installs start with an empty enabled set; existing v3 `channel` is migrated to a one-element enabled set and matching home channel, then deleted from persisted settings.
- `/api/settings` still returns `channel` as a deprecated read-only alias of `messaging.homeChannel` for one major version. PUT `{channel}` is translated into `enabledChannels: [channel]` + `homeChannel: channel` with a `Deprecation` response header.
- `src/messaging/runtime.ts` exposes `getEnabledChannels()`, `getHomeChannel()`, `initEnabledMessagingRuntimes()`, and per-channel `startMessagingTransport()`/`stopMessagingTransport()`. `restartMessagingRuntime()` restarts only channels affected by an enabled-set, per-channel config, or locale change; a home-only change does not restart transports.
- `src/messaging/channel-health.ts` adds `activeInboundChannels` (running channels) while keeping the legacy scalar `activeInbound` as `homeChannel` for backward compatibility. Both Classic and Manager parsers prefer the new array and fall back to the legacy scalar.
- Outbound routing in `src/messaging/send.ts` resolves `target.channel > explicit channel > homeChannel`; proactive sends with no target use `homeChannel`.

### Mid-run steer (기본 정책)

- `multiSession.midRunPolicy` 기본값은 `'steer'`다. JWC와 steer 가능한 Codex App turn은 in-band 입력을 받는다. Native Cursor와 Grok은 `replaceTurn` 훅으로 원래 prompt 취소 응답·업데이트·callback을 모두 처리한 뒤 같은 native session에 다시 요청한다. 이는 `cancel-reprompt`이며 native-input이 아니다. Cursor는 원래 요청·수락된 추가 지시·제한된 부분 출력을 읽기 전용 문맥으로, 현재 운영 지침을 활성 지침으로 복원한다. Grok에는 이 재주입을 적용하지 않는다.
- Native Cursor와 Grok은 전송 완료 뒤에도 main 객체·세대·정규 소유권을 재검사하고 입력을 한 번만 기록한다. 진행 중인 replacement의 후속 입력은 큐로 갈 수 있지만, 취소·전송·기록 실패는 자동 재시도하지 않는다. Stop으로 무효화된 입력은 실제 enqueue까지 보호하고 `cancelled`로 끝내며, 이후 새 입력은 받을 수 있다. 나머지 런타임의 기존 in-band/kill-steer 동작과 `followup`/`collect` 대기는 유지한다.
- `/steer`는 런타임 훅을 사용한다. 별도 `/queue steer <n>`은 기존 항목을 중단 후 우선 실행하는 동작을 유지한다. Kill 경로의 제한된 부분 출력은 pre-kill MAX(id)와 정확한 exit-settle 배리어 뒤 `withSteerContext`로 복원한다. 전체 과거 맥락 보존을 보장하지 않는다. 정책 표는 `structure/prompt_flow.md`를 참고한다.

### Korean Content Skill Routing

Korean promotional/content writing (홍보 쓰레드, 인스타 카드뉴스, 링크드인, 웹/블로그 게시물)는 active `k-writing` skill이 소유한다. 임의 산문으로 바로 작성하지 말고 channel routing → mandatory pre-search → hook 3안 scoring → tone/module formatting → anti-AI-tell + 인간다움 checklist를 거친다. `k-thread-gen`은 retired label로만 언급하고 새 라우팅 이름으로 쓰지 않는다.

**생성과 수정의 경계**: `k-writing`은 플랫폼용 콘텐츠를 **생성**한다. 이미 쓴 한국어를
**고치는** 일(윤문)은 `jaw-dev-write`가 소유하고, 사람에게 보낼 답변을 **구성**하는 일은
`jaw-dev-speech`가 소유한다. 셋은 배타적이다 — `k-writing`이 초안을 만들면 `jaw-dev-write`가
그 초안에 윤문 프로토콜을 건다. 순서는 생성 → 윤문이며 반대가 아니다. 두 새 스킬은
`skills_ref/registry.json`에 `category: orchestration`으로 등록되어 자동 활성 대상이다.

### Build & Deploy Contract (서버 코드 변경 시 필수)

**실행 중인 서버는 TS 소스가 아니라 컴파일된 `dist/`를 실행한다** (`jaw serve` → `dist/server.js`, CLI → `dist/bin/cli-jaw.js`). 소스만 커밋하고 빌드를 빼먹으면 서버를 재시작해도 변경이 반영되지 않는다 (260610 `/api/project/pick` 404 사고의 원인).

서버/CLI 코드(`server.ts`, `src/**`, `bin/**`)를 변경했다면:

```bash
npm run build           # tsc → dist/ atomic swap (prebuild: ensure:native 포함)
npm run build:frontend  # public/js·public/manager 변경 시 (→ public/dist)
```

- 변경 반영 단위 = **커밋 + 해당 빌드 + 서버 재시작** 3종 세트. 빌드 없이 "재시작하면 됩니다"라고 안내하지 말 것.
- 프론트엔드(`public/js/*.ts`, `public/manager/src/**`)는 `build:frontend`만으로 충분하며 서버 재시작 없이 브라우저 새로고침으로 반영된다 (`public/dist` 정적 서빙).
- 반영 여부 검증: `grep <new-symbol> dist/...` 또는 해당 엔드포인트 curl로 확인 후 안내.

이건 로컬 빌드/재시작 계약이고, 배포(release)는 별개다. 릴리스 경로는 `feature → preview → main` 뒤 `workflow_dispatch` npm publish이며 `dev`는 릴리스 경로가 아니다. `scripts/promote-to-main.sh`는 publish를 dispatch한 뒤 결과를 확인하지 않고 종료하며, 승격 성공 후에는 다시 실행할 수 없다. 부분 실패·롤백 복구 절차는 `structure/infra.md` § 릴리스 파이프라인과 부분 실패 복구를 따를 것.

### Test Scope (`npm test`는 전체가 아니다)

`npm test`는 root와 `tests/unit/`만 실행한다 (`tests/run.mts`의 파일 수집). `tests/integration/`은
**포함되지 않으므로**, "전체 스위트 통과"를 근거로 삼기 전에 범위를 확인할 것.

```bash
npm test              # root + tests/unit/ (integration 제외)
npm run test:all      # + tests/integration/
npm run test:integration
```

- 회귀 판정은 깨끗한 baseline과 `comm -13`으로 비교해 **신규 실패 0건**을 증명한다.
- 테스트 파일은 각자 별도 프로세스로 돌지만 `CLI_JAW_HOME`과 SQLite 파일은 공유한다.
  실제 DB를 건드리는 케이스를 여러 파일에 나눠 두면 잠금으로 간헐 실패한다 — 한 파일에 모으거나
  주입 지점으로 DB를 우회할 것.
- 소스를 정규식으로 검사하는 테스트는 리팩터링 때마다 의미 없이 깨진다. 새로 만들지 말고,
  기존 것이 깨지면 문자열을 갱신하기 전에 **동작 검증으로 교체할 수 있는지** 먼저 볼 것.

### Line Count Format (`str_func.md`)

File tree の行数は **`(NNNL)`** 형식으로 기재. 두 가지 변형 허용:

```
├── server.js          ← 설명 (757L)           ← 단순 형식
├── chat.js            ← 설명 (3모드, ..., 843L) ← 다중 메타 형식
```

- 숫자 + `L` + `)` 또는 `,` 로 끝나야 detection 가능
- 검증: `bash structure/verify-counts.sh` (exit code = 불일치 수; 현재는 `str_func.md` 파일 트리의 모든 `(NNNL)` 파일 항목도 검사)
- 자동 수정: `bash structure/verify-counts.sh --fix`
- **파일 수정 후 반드시 verify-counts 실행해서 문서 동기화**

### Devlog Archive (`devlog/_fin/`)

- 완료된 phase 폴더는 `devlog/_fin/`으로 이동 (folder-per-phase, 단독 `.md` 금지)
- 계획/구현대기 문서는 `devlog/_plan/`으로 이동 (`_fin`에 두지 않음)
- `devlog/` 루트에는 진행 중인 폴더만 유지
- 후순위 작업은 `269999_` 접두사로 표시
- Reference bundles (skill packages, test fixtures)은 반드시 phase 폴더 안에 포함
- 전체 규칙: [`devlog/_fin/HYGIENE.md`](devlog/_fin/HYGIENE.md)
- 점검: `bash structure/audit-fin-status.sh`
- 자동 분리: `bash structure/audit-fin-status.sh --move-planning`

### Phase Document Frontmatter

```yaml
---
created: 2026-MM-DD
status: planning | active | blocked | done | deferred
tags: [cli-jaw, ...]
---
# (fin) Phase Title    ← 구현 완료 시 (fin) 접두사
```

- `status:` 필드 필수 — `planning`, `active`, `blocked`, `done`, `deferred` 중 택 1
- Legacy prose forms (`> Status:`, `**Status**:`) remain readable during migration,
  but new/updated phase docs must use YAML frontmatter.
- 구현 완료된 문서 제목에 `(fin)` 접두사 추가

### OfficeCLI (On-Demand)

OfficeCLI is NOT bundled with cli-jaw postinstall. It is installed on-demand when skills need L1/L2 features or HWP support.

- **Format support**: .docx, .xlsx, .pptx, .hwpx, .hwp (HWP via rhwp sidecars)
- **Install (forked, CJK + rhwp)**: `bash "$(npm root -g)/cli-jaw/scripts/install-officecli.sh"`
- **Install (upstream, vanilla)**: `bash "$(npm root -g)/cli-jaw/scripts/install-officecli.sh" --upstream`
- **Smoke test**: `officecli --version && officecli capabilities --json`
- **Binary priority**: `OFFICECLI_BIN` env → global `officecli` → not available
- **Fork**: `lidge-jun/OfficeCLI` (CJK-enhanced, rhwp sidecars) vs. `iOfficeAI/OfficeCLI` (vanilla)
- **Safety**: Never run parallel officecli processes on the same file
- **Which repo**: the fork is required only for CJK font handling and HWP. For general
  .xlsx/.docx/.pptx work use `--upstream` — the fork's latest release (`v1.0.98`, checked
  2026-08-12) publishes only `officecli-mac-arm64`, so a fork install cannot succeed on
  Windows, Linux, or macOS x64. The installer now checks the release asset list and fails
  with that explanation instead of a bare 404 (#280).
- **Never use `officecli import`**: it writes ZERO cells while reporting an accurate row and
  column count, and `officecli validate` then passes on the empty workbook. Reproduced on
  upstream 1.0.143 for every input shape, so upgrading is not an escape (#279, #295, #301).
  Load cells through `officecli batch --input <file>` and prove the result with
  `officecli view <file> stats` (Total Cells > 0). Use `--input`, not `--commands '<json>'`:
  PowerShell strips the inner quotes and the parser error then blames the JSON (#296).

### Windows shell hazards (agent-authored scripts)

Three failures that all look like something else. None is a bug in a fixed cli-jaw
code path — they bite whatever the agent writes at runtime, so they belong here
rather than in a module.

- **Write `.ps1` files with a UTF-8 BOM.** Windows PowerShell 5.1 reads a BOM-less
  file as the ANSI code page — CP949 on a Korean host — so every non-ASCII string
  literal is corrupted *before* the script runs. It either dies with a parser error
  or, worse, runs with silently mangled data. Prepend `\uFEFF`, or use
  `Set-Content -Encoding UTF8`. PowerShell 7+ defaults to UTF-8 and does not need
  it, but the shipped Windows shell is 5.1 (#302).
- **Probe for tools with the right shell's verb.** `command -v` is not a PowerShell
  builtin or cmdlet: it prints nothing, sets no exit code, and raises no error, so a
  working install reads as missing. Use `Get-Command <tool> -ErrorAction
  SilentlyContinue`, or `<tool> --version` portably (#298).
- **Pass JSON to a CLI through a file, not an inline argument.** PowerShell strips
  the inner double quotes from `--commands '<json>'` before the process sees them,
  and the resulting parser error blames the JSON, which was fine. Use
  `--input <file>` (#296).

```bash
officecli create file.docx                                          # create blank
officecli view file.docx text                                       # view content
officecli add file.docx /body --type paragraph --prop text="..."    # add content
officecli set data.xlsx /Sheet1/A1 --prop value="42"                # set cell
officecli add deck.pptx / --type slide --prop title="Title"         # add slide
officecli create file.hwpx                                          # create blank HWPX
officecli hwp doctor --json                                         # HWP/rhwp readiness
officecli create file.hwp --json                                    # create blank HWP when rhwp-field-bridge is ready
officecli add file.hwp /text --type paragraph --prop value="..." --prop output=out.hwp --json
officecli view file.hwp pdf --out out.pdf --json                    # export HWP through rhwp sidecars
officecli set file.hwp /native-op --prop op=split-paragraph --prop output=out.hwp --json
officecli validate file.docx                                        # validate
officecli get file.docx / --json                                    # JSON output
echo '[...]' | officecli batch data.xlsx --json                     # batch ops
```

#### OfficeCLI Rebase Hygiene

When rebasing the `officecli` submodule fork onto `iOfficeAI/OfficeCLI`, preserve the HWP/rhwp commits and keep generated Rust outputs out of history.

```bash
cd officecli
git fetch upstream
git status --short --branch
git branch backup/feat-hwpx-pre-rebase-$(date +%y%m%d-%H%M) feat/hwpx
git tag backup/feat-hwpx-pre-rebase-$(date +%y%m%d-%H%M) feat/hwpx
```

- Rebase onto `upstream/main`, then resolve conflicts by preserving upstream OfficeCLI core changes plus local HWP/rhwp routing, help, capability, fixture, and bridge code.
- If `src/rhwp-field-bridge/target/` or any Rust `target/` output blocks rebase/cherry-pick, move or delete that generated directory before continuing. It is build output, not source.
- If an old commit accidentally stages Rust build artifacts, stop before committing and run `git rm -r --cached src/rhwp-field-bridge/target` plus `rm -rf src/rhwp-field-bridge/target`; commit only source, fixtures, tests, and docs.
- After every rebase, verify `git ls-files 'src/rhwp-field-bridge/target/*' | wc -l` returns `0`.
- Required checks before force-pushing the rebased feature branch:
  - `dotnet build officecli.slnx`
  - `cargo build --manifest-path src/rhwp-field-bridge/Cargo.toml`
  - `dotnet test tests/OfficeCli.Tests/OfficeCli.Tests.csproj --filter FullyQualifiedName~HwpBridge --no-build`
  - `dotnet test tests/OfficeCli.Tests/OfficeCli.Tests.csproj --no-build`
- Push rebased `feat/hwpx` with `git push --force-with-lease origin feat/hwpx`, then commit the updated `officecli` submodule pointer in this repo.
