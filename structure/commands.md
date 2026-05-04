---
created: 2026-03-28
tags: [cli-jaw, slash-command, cli, discord]
aliases: [CLI-JAW Commands, slash commands registry, commands.md]
---

> 📚 [INDEX](INDEX.md) · [체크리스트 ↗](AGENTS.md) · **슬래시 커맨드** · [서버 API](server_api.md)

# src/cli/ — Slash Command Registry & Dispatcher

> `commands.ts`(295L) + `handlers.ts`(363L) + `handlers-runtime.ts`(449L) + `handlers-completions.ts`(92L) + `api-auth.ts`(45L) + `command-context.ts`(138L) + `registry.ts`(90L) + `acp-client.ts`(348L) + `claude-models.ts`(78L) + `compact.ts`(119L)
> slash registry는 24개 커맨드, 4개 실행 인터페이스. root CLI는 `bin/cli-jaw.ts` + `bin/commands/*.ts` 기준 18개 top-level 서브커맨드이며, `browser web-ai`가 별도 helper(`browser-web-ai.ts`)로 분리되어 있다. visible 기준 CLI 22 / Web 20 / Telegram 20 / Discord 20. `cmdline` capability는 contract 전용이며 10개가 보인다.
> 모델/CLI 선택은 `registry.ts` 단일 소스를 따르고, Web/CLI/Telegram/Discord는 모두 `makeCommandCtx()`로 통합된 command context를 사용한다.
> 최근 구조 변화 핵심은 두 가지다: `handlers.ts` 분해(`handlers-runtime.ts`, `handlers-completions.ts`)와 CLI→server 인증 bootstrap 공통화(`api-auth.ts`).

---

## 핵심 함수

| Function | 역할 |
| --- | --- |
| `parseCommand(text)` | `/cmd args` 파싱. 파일 경로(`/tmp/x`)는 command로 오인하지 않음 |
| `executeCommand(parsed, ctx)` | interface/capability 검사 후 handler 실행, `normalizeResult()` 적용 |
| `getCompletions(partial, iface)` | `/name` 문자열 목록 반환 |
| `getCompletionItems(partial, iface)` | command palette용 상세 completion 항목 |
| `getArgumentCompletionItems(...)` | command별 인자 completion |
| `COMMANDS` | command registry 단일 소스 |

내부 정렬/검색 헬퍼는 `sortCommands`, `findCommand`, `displayUsage`, `scoreCommandCandidate`, `scoreArgumentCandidate`, `normalizeArgumentCandidate`, `dedupeChoices`가 담당한다.

---

## Registry Snapshot

### Command 목록 (24)

```text
help, commands, status, clear, compact, reset, model, cli, fallback,
forward, thought, flush, version, skill, employee, mcp, memory, browser,
prompt, quit, file, steer, ide, orchestrate
```

### 인터페이스 가시성

| Interface | Visible | 비고 |
| --- | ---: | --- |
| `cli` | 22 | `file` hidden, `steer` 미지원 |
| `web` | 20 | `commands`, `quit`, `file`, `ide` 미지원 |
| `telegram` | 20 | remote command set |
| `discord` | 20 | remote command set |
| `cmdline` | 10 | 루트 CLI 서브커맨드용 contract-only capability 필터 |

### 카테고리

- `session`: `help`, `commands`, `status`, `clear`, `compact`, `reset`, `steer`
- `model`: `model`, `cli`, `fallback`, `forward`, `thought`, `flush`
- `tools`: `skill`, `employee`, `mcp`, `memory`, `browser`, `prompt`, `ide`, `orchestrate`
- `cli`: `version`, `quit`, `file`

---

## Root CLI Surface (`bin/cli-jaw.ts` + `bin/commands/*.ts`)

소스 기준 entrypoint는 `bin/cli-jaw.ts`(187L)다. `package.json`의 published bin은 build 산출물 `dist/bin/cli-jaw.js` / `jaw`를 가리킨다. 현재 소스 트리에는 `bin/cli-jaw.js`가 없고, root command router는 아래 17개 user-facing command를 동적 import 한다. 파일 수 기준으로는 `browser-web-ai.ts` helper가 추가되어 `bin/commands/*.ts` top-level은 18개다.

### Global options

| Option | 동작 |
| --- | --- |
| `--home <path>` / `--home=<path>` | command parsing 전에 `CLI_JAW_HOME` 설정 |
| `--help` / `-h` | root help 출력 |
| `--version` / `-v` | `cli-jaw v{package.version}` 출력 |

### 실제 서브커맨드 / 옵션

| Command | 파일 | 실제 옵션 / 하위 명령 |
| --- | --- | --- |
| `serve` | `bin/commands/serve.ts` | `--port <port>`, `--host <host>`, `--no-open`, `--lan`, `--remote`, `--trust-proxy`, `--trust-forwarded` |
| `init` | `bin/commands/init.ts` | `--help`, `--non-interactive`, `--safe`, `--dry-run`, `--force`, `--working-dir <path>`, `--cli <name>`, `--channel <telegram\|discord>`, `--telegram-token <t>`, `--allowed-chat-ids <ids>`, `--discord-token <t>`, `--discord-guild-id <id>`, `--discord-channel-ids <ids>`, `--skills-dir <path>` |
| `doctor` | `bin/commands/doctor.ts` | `--json`, `--repair-shared-paths`, `--tcc`, `--fix`, `--prime` |
| `chat` | `bin/commands/chat.ts` | `process.argv.slice(3)`를 TUI로 전달. 주석 기준 기본/`--raw`/`--simple` 모드 |
| `employee` | `bin/commands/employee.ts` | `reset [--port 3457]`; `help`/`--help`/`-h` |
| `reset` | `bin/commands/reset.ts` | `[--yes] [--port 3457]`; `confirm`도 확인값으로 허용 |
| `mcp` | `bin/commands/mcp.ts` | `install <package> [--pypi\|--npm]`, `sync`, `reset [--force]`, `list` |
| `skill` | `bin/commands/skill.ts` | `install <name> [--force]`, `remove <name>`, `info <name>`, `list`, `reset [hard\|--hard] [--force]` |
| `status` | `bin/commands/status.ts` | `--port <port>`, `--json` |
| `browser` | `bin/commands/browser.ts` | `start [--port <auto>] [--headless] [--agent]`, `stop`, `status`, `reset [--force]`, `snapshot [--interactive]`, `screenshot [--full-page] [--ref <ref>]`, `click <ref> [--double]`, `mouse-click <x> <y> [--double]`, `vision-click <target> [--provider codex] [--double]`, `type <ref> <text> [--submit]`, `press <key>`, `hover <ref>`, `navigate <url>`, `open <url>`, `tabs`, `text [--format text\|html]`, `evaluate <js>` |
| `browser web-ai` | `bin/commands/browser-web-ai.ts` | `render`, `status`, `send`, `poll`, `query`, `watch`, `watchers`, `sessions`, `sessions-prune`, `resume`, `reattach`, `notifications`, `capabilities`, `stop`, `diagnose`/`doctor`, `context-dry-run`, `context-render`; vendor는 `chatgpt\|gemini\|grok` |
| `memory` | `bin/commands/memory.ts` | `search <query>`, `read <file> [--lines N-M]`, `save <file> <content>`, `list`, `init`, `reflect [--sinceDays N]`, `flush`, `cleanup [--days N]` |
| `launchd` | `bin/commands/launchd.ts` | `[--port PORT] [status\|unset\|cleanup]` |
| `clone` | `bin/commands/clone.ts` | `<target-dir> [--from <source>] [--with-memory] [--link-ref]` |
| `orchestrate` | `bin/commands/orchestrate.ts` | `[P\|A\|B\|C\|D\|status\|reset] [--force] [--json] [--port <port>]` |
| `dispatch` | `bin/commands/dispatch.ts` | `--agent <name> --task <task> [--port <port>]` |
| `service` | `bin/commands/service.ts` | `[--port PORT] [--backend launchd\|systemd\|docker] [status\|unset\|logs]` |
| `dashboard` | `bin/commands/dashboard.ts` | `serve [--port 24576] [--from 3457] [--count 50] [--no-open]` |

---

## Command Behavior Notes

### `/commands` (alias: `/cmd`)

- CLI 전용.
- command palette 오버레이를 연다.
- TUI에서 `Ctrl+K`와 같은 UI 경로를 공유한다.

### `/clear`

- 먼저 `ctx.clearSession()`을 호출한다. Web ctx에서는 `clearSessionState()`라서 메시지 삭제 + ownership generation bump + clear broadcast까지 수행한다.
- CLI/Web에서는 이후 `code: 'clear_screen'`을 반환해 UI clear도 유도한다.
- Telegram/Discord에서는 실제 UI clear가 없으므로 안내 텍스트만 반환하지만, remote ctx의 `clearSession()`은 먼저 실행된다.
- 서버 측 `POST /api/clear`는 UI-only broadcast라서 slash `/clear`와 의미가 다르다.

### `/reset [confirm]`

- `confirm` 없으면 확인 메시지 반환.
- `confirm`이면 가능한 범위에서 다음을 순서대로 실행한다:
  `resetSkills()` → `resetEmployees()` → `syncMcp()` → `resetSession()`
- 현재 Web/remote ctx의 `resetSession()`은 메시지 history를 지우지 않고 session ID만 비운다.

### `/model [name]` / `/cli [name]`

- 값이 없으면 현재 상태 조회.
- 값이 있으면 `settings.perCli[activeCli].model` 또는 `settings.cli`를 갱신한다.
- remote interface에서도 허용된다.

### `/fallback [cli1 cli2...|off]`

- `fallbackOrder`를 설정하거나 해제한다.
- 허용 대상은 `settings.perCli`에 등록된 CLI 키다.

### `/forward [on|off]`

- 현재 remote channel 또는 active channel의 `forwardAll` 값을 조정한다.
- Telegram/Discord remote UX에 맞춰 channel별 patch shape를 다르게 만든다.

### `/thought [status|on|off]`

- Gemini thought visibility toggle.
- 값이 없거나 `status`면 `settings.showReasoning === true` 기준으로 `ON/OFF`를 보여준다.
- `on|off`는 `ctx.updateSettings({ showReasoning })`로 저장한다.
- stream 처리에서는 Gemini thought/thinking content가 `fullText`에 들어가지 않는다. `showReasoning`이 켜진 경우에만 process-step(`agent_tool`, `toolType: 'thinking'`)로 보이고, 꺼진 경우 trace에는 hidden marker만 남는다.

### `/flush [cli] [model] | off`

- memory flush 전용 CLI/model override를 설정한다.
- `off`/`reset`이면 `settings.memory.cli`, `settings.memory.model`을 비운다.
- 모델만 넣으면 registry 기반으로 CLI를 역추론한다.
- Claude legacy model name은 힌트 맵으로 `claude`에 귀속된다.

### `/skill [list|reset]`

- `list`: active/ref count 반환
- `reset`: `runSkillReset()` 기반 soft reset

### `/employee reset`

- 기본 직원 세트를 재시드한다.

### `/mcp [sync|install]`

- 인자 없으면 서버 목록 조회
- `sync`: `syncToAll(loadUnifiedMcp())`
- `install`: install 후 sync까지 수행

### `/memory`

기본 동작은 list 또는 search다. 추가 subcommand가 많이 붙었다.

| Form | 동작 |
| --- | --- |
| `/memory` 또는 `/memory list` | memory file list |
| `/memory <query...>` | search |
| `/memory status` | runtime status |
| `/memory bootstrap` | core/markdown/kv/claude import bootstrap |
| `/memory reindex` | memory reindex |
| `/memory flush` | memory flush trigger |
| `/memory adv ...` | integrated memory runtime 상태/초기화/bootstrap/reindex 래퍼 |

### `/browser [status|tabs]`

- 브라우저 상태 또는 열린 탭을 요약한다.
- 실제 browser automation command surface는 별도 `bin/commands/browser.ts`와 server browser API가 담당한다.

### `/prompt`

- 현재 A2 prompt를 읽어 상위 20줄까지만 preview 한다.

### `/steer <prompt>`

- Web/Telegram/Discord에서 실행 가능. CLI slash registry에는 노출되지 않는다.
- 실행 중 agent가 없으면 에러.
- 실행 중이면 kill 후:
  remote는 `type: 'steer'` signal을 반환하고,
  web은 `submitMessage()`로 직접 재지시한다.

### `/orchestrate` (alias: `/pabcd`)

- PABCD explicit entry.
- auto-activation 제거 후 명시적 진입점으로만 유지된다.

---

## CommandContext 통합

`src/cli/command-context.ts`

### 공통 필드

- `interface`
- `locale`
- `version`
- `getSession()`
- `getSettings()`
- `updateSettings()`
- `getRuntime()`
- `getSkills()`
- `clearSession()`
- `resetSession()`
- `getCliStatus()`
- MCP / Memory / Browser / Employees / Skills / Prompt helpers

### remote settings patch 제한

Telegram/Discord는 아래 키만 patch 가능하다.

```text
fallbackOrder, cli, perCli, showReasoning, memory, telegram, discord
```

즉 remote에서 `/model`, `/cli`, `/fallback`, `/thought`, `/flush`, `/forward`는 가능하지만 임의 settings write는 막힌다.

---

## Command Contract (`src/command-contract/`)

`catalog.ts` + `policy.ts` + `help-renderer.ts`

### Capability

| Value | 의미 |
| --- | --- |
| `full` | 실행 가능 |
| `readonly` | 조회만 허용 |
| `hidden` | 목록/실행 모두 숨김 |
| `blocked` | 목록은 가능할 수 있으나 실행 차단 |

현재 `REMOTE_READONLY`는 비어 있다. 즉 Telegram/Discord 노출 커맨드는 전부 `full` capability다.

### `cmdline` hidden 세트

다음 14개는 루트 CLI 서브커맨드 관점에서 숨긴다.

```text
help, clear, model, cli, fallback, status, reset,
skill, employee, mcp, memory, browser, prompt, version
```

그 결과 `cmdline` visible command는 10개다. `file`은 slash registry에서는 hidden이지만 `cmdline` capability hidden set에는 없어서 contract visible 쪽에 남는다.

### `getTelegramMenuCommands()`

- bot 자체 처리인 `start`, `id`, `settings`만 제외한다.
- 나머지는 `getVisibleCommands('telegram')` 기준으로 메뉴에 남긴다.

---

## Registry.ts — CLI / Model Source of Truth

`src/cli/registry.ts`

현재 CLI registry는 5개 backend를 갖는다.

| CLI | Default Model | Default Effort |
| --- | --- | --- |
| `claude` | `sonnet` | `medium` |
| `codex` | `gpt-5.4` | `medium` |
| `gemini` | `gemini-3-flash-preview` | `''` |
| `opencode` | `opencode/big-pickle` | `''` |
| `copilot` | `claude-sonnet-4.6` | `high` |

`CLI_KEYS`, `buildDefaultPerCli()`, `buildModelChoicesByCli()`가 `/cli`, `/model`, `/flush` completion과 settings 기본값 생성에 모두 재사용된다.

---

## Claude Model Normalization (`claude-models.ts`)

| Export | 역할 |
| --- | --- |
| `CLAUDE_CANONICAL_MODELS` | `opus`, `sonnet`, `sonnet[1m]`, `haiku` |
| `CLAUDE_LEGACY_VALUE_MAP` | 레거시 full-name → canonical alias |
| `migrateLegacyClaudeValue()` | settings / employee / memory model 마이그레이션 |
| `getDefaultClaudeModel()` | 기본값 `sonnet` |
| `getDefaultClaudeChoices()` | canonical choices 반환 |

`opus[1m]` 입력값은 현재 `CLAUDE_LEGACY_VALUE_MAP`에서 `opus`로 정규화된다. startup employee DB migration에는 아직 `opus[1m]` 대상 row가 남아 있어, registry choice와 startup migration text가 완전히 같은 source는 아니다.

---

## CLI API Auth (`api-auth.ts`, 45L)

CLI/TUI command client가 server token bootstrap을 공통으로 사용한다.

| Export | 역할 |
| --- | --- |
| `getCliAuthToken(portOrBase?)` | `GET /api/auth/token` 호출 후 base별 token cache |
| `authHeaders(extra?)` | `Authorization: Bearer <token>` 병합 |
| `cliFetch(url, init)` | origin 기준 token 확보 후 fetch |

사용처:

- `bin/commands/browser.ts`
- `bin/commands/memory.ts`
- `bin/commands/dispatch.ts`
- `bin/commands/reset.ts`
- `bin/commands/orchestrate.ts`
- `bin/commands/employee.ts`
- `bin/commands/tui/api.ts`

주의점:

- Web 브라우저는 same-origin에서만 `/api/auth/token`을 받을 수 있다.
- CLI는 `Sec-Fetch-Site`를 보내지 않으므로 token bootstrap이 허용된다.

---

## Web UI Slash Commands

`public/js/features/slash-commands.ts`

- `/` 입력 시 command completion dropdown 표시
- `GET /api/commands?interface=web`로 command 목록 로드
- 방향키/Enter/Esc 지원
- 실행은 `POST /api/command`

default TUI는 일부 no-arg command를 selector overlay로 가로챈다.

- `/model`
- `/cli`

선택 결과는 settings를 직접 쓰지 않고, `/<command> <value>` 문자열을 합성해 기존 command 실행 경로로 다시 넣는다.
