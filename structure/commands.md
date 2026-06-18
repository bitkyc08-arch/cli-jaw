---
created: 2026-03-28
tags: [cli-jaw, slash-command, cli, discord]
aliases: [CLI-JAW Commands, slash commands registry, commands.md]
---

> 📚 [INDEX](INDEX.md) · [체크리스트 ↗](AGENTS.md) · **슬래시 커맨드** · [서버 API](server_api.md)

# src/cli/ — Slash Command Registry & Dispatcher

> `commands.ts`(550L) + `handlers.ts`(448L) + `handlers-runtime.ts`(501L) + `handlers-completions.ts`(103L) + `handlers-workflows.ts`(498L) + `api-auth.ts`(45L) + `command-context.ts`(139L) + `registry.ts`(231L) + `acp-client.ts`(382L) + `claude-models.ts`(81L) + `compact.ts`(143L)
> slash registry는 50개 커맨드이며 interface별 가시성은 CLI 48 / Web 43 / Telegram 36 / Discord 36다. root cmdline에는 workflow/interactive hidden set을 제외한 17개가 보인다. root CLI는 `bin/cli-jaw.ts` 기준 26개 root router case를 가진다. `chat search`, `browser web-ai`, `dashboard memory`, `dashboard chat search`처럼 grouped subcommand까지 포함하면 27개 user-facing surface로 문서화한다. helper까지 포함한 `bin/commands/*.ts` top-level 파일은 30개다. `browser web-ai`는 `browser-web-ai.ts`, `dashboard memory`는 `dashboard-memory.ts`, dashboard chat federation은 `dashboard-chat.ts`, task root command는 `task.ts`, dispatch unwrap 보조는 `dispatch-helpers.ts`로 분리되어 있다.
> 모델/CLI 선택은 `registry.ts` 단일 소스를 따른다. 현재 registry 런타임은 `pi`, `agy`, `ai-e`, `claude`, `claude-e`, `codex`, `codex-app`, `cursor`, `gemini`, `grok`, `kiro-code`, `opencode`, `copilot` 13개다.

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

## Web Slash Dropdown Help

- `public/js/features/command-info.ts`의 `COMMAND_TOPIC_MAP`이 slash-command row `?` 도움말의 단일 매핑 소스다.
- `public/js/features/slash-commands.ts`는 `COMMAND_TOPIC_MAP[cmd.name]`이 있을 때만 `.cmd-info-btn`을 렌더링하고, 클릭 시 `openHelpDialog(topicId)`를 호출한다.
- Web에서 보이는 모든 command와 alias는 `COMMAND_TOPIC_MAP`에 있어야 한다. 누락되면 autocomplete row에 `?` popup이 사라진다.
- `tests/unit/help-dialog-contract.test.ts`는 `COMMANDS`와 `COMMAND_TOPIC_MAP`을 대조해 `/review`, `/task`, `/fork`, `/h` 같은 누락이 재발하지 않도록 막는다.

---

## Registry Snapshot

### Command 목록 (50)

```text
help, commands, settings, status, clear, purge, compact, reset,
plan, interview, deliberate, planaudit, review, goal, goalplan, gd, team,
model, cli, fallback, forward, thought, flush,
version, skill, employee, mcp, memory, browser, prompt, quit, file, steer,
ide, orchestrate, project, task, new, switch, sessions, fork,
effort, fast, context, tools, redraw, retry, export, resume, hotkeys
```

### 인터페이스 가시성

| Interface | Visible | 비고 |
| --- | ---: | --- |
| `cli` | 48 | `file` hidden, `steer` 미지원 |
| `web` | 43 | `commands`, `settings`, `quit`, `file`, `ide`, `hotkeys` 미지원 |
| `telegram` | 36 | remote-safe command set |
| `discord` | 36 | remote-safe command set |

### 카테고리

- `session`: `help`, `commands`, `status`, `clear`, `purge`, `compact`, `reset`, `steer`, `new`, `switch`, `sessions`, `fork`, `context`, `retry`, `export`, `resume`
- `workflow`: `plan`, `interview`, `deliberate`, `planaudit`, `review`, `goal`, `goalplan`, `gd`, `team`
- `model`: `model`, `cli`, `fallback`, `forward`, `thought`, `flush`, `effort`, `fast`
- `tools`: `skill`, `employee`, `mcp`, `memory`, `browser`, `prompt`, `ide`, `orchestrate`, `project`, `task`, `tools`
- `cli`: `settings`, `version`, `quit`, `file`, `redraw`, `hotkeys`

`/settings` is CLI-only. In fullscreen `jaw chat`, selecting it opens the
Appearance MVP screen in the main content region; it does not expose unsupported
JWC-only `Context` settings. Line-mode still returns the generic command result.

---

## Root CLI Surface (`bin/cli-jaw.ts` + `bin/commands/*.ts`)

소스 기준 entrypoint는 `bin/cli-jaw.ts`(228L)다. 현재 소스 트리에서 root command router는 26개 case를 동적 import 한다. 아래 표는 grouped subcommand(`chat search`, `browser web-ai`, dashboard federation 등)를 포함한 user-facing surface다. 파일 수 기준으로는 `browser-web-ai.ts`, `dashboard-memory.ts`, `dashboard-chat.ts`, `dispatch-helpers.ts`, `task.ts` helper/command가 포함되어 `bin/commands/*.ts` top-level은 30개다.

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
| `chat` | `bin/commands/chat.ts` | `process.argv.slice(3)`를 TUI로 전달. 기본/`--raw`/`--simple` 모드. TUI transport는 `bin/commands/tui/channel.ts`에서 SSE-first inbound(`GET /api/events`) + legacy WS fallback(pre-X-01 server only)을 제공하고, outbound는 REST `POST /api/message` / `POST /api/stop`을 사용 |
| `chat search` | `bin/commands/chat-search.ts` | `<query> [--days N] [--recent N] [--context N] [--limit N]`; 채팅 메시지 히스토리 검색 |
| `employee` | `bin/commands/employee.ts` | `list [--port 3457] [--json]`, `reset [--port 3457]`, `sessions-reset [--port 3457]`; `help`/`--help`/`-h` |
| `reset` | `bin/commands/reset.ts` | `[--yes] [--port 3457]`; `confirm`도 확인값으로 허용 |
| `mcp` | `bin/commands/mcp.ts` | `install <package> [--pypi\|--npm]`, `sync`, `reset [--force]`, `list` |
| `skill` | `bin/commands/skill.ts` | `install <name> [--force]`, `remove <name>`, `info <name>`, `list`, `reset [hard\|--hard] [--force]` |
| `status` | `bin/commands/status.ts` | `--port <port>`, `--json` |
| `browser` | `bin/commands/browser.ts` | `start [--port <auto>] [--headless] [--agent]`, `stop`, `status`, `reset [--force]`, `fetch <url> [--json] [--trace] [--browser auto\|never\|required] [--allow-third-party-reader]`, `snapshot [--interactive]`, `screenshot [--full-page] [--ref <ref>]`, `click <ref> [--double]`, `mouse-click <x> <y> [--double]`, `vision-click <target> [--provider codex] [--double]`, `type <ref> <text> [--submit]`, `press <key>`, `hover <ref>`, `navigate <url>`, `open <url>`, `tabs`, `text [--format text\|html]`, `evaluate <js>` |
| `browser web-ai` | `bin/commands/browser-web-ai.ts` | `render`, `status`, `send`, `poll`, `query`, `watch`, `watchers`, `sessions`, `sessions-prune`, `resume`, `reattach`, `notifications`, `capabilities`, `stop`, `diagnose`/`doctor`, `context-dry-run`, `context-render`, `code`, `code-extract`; vendor는 `chatgpt\|gemini\|grok`, code/code-extract는 ChatGPT 전용 |
| `memory` | `bin/commands/memory.ts` | `search <query> [--chat]`, `read <file> [--lines N-M]`, `save <file> <content>`, `list`, `init`, `context <file> [--window N]`, `reflect [--sinceDays N]`, `flush`, `cleanup [--days N]` |
| `launchd` | `bin/commands/launchd.ts` | `[--port PORT] [status\|unset\|cleanup]` |
| `clone` | `bin/commands/clone.ts` | `<target-dir> [--from <source>] [--with-memory] [--link-ref]` |
| `orchestrate` | `bin/commands/orchestrate.ts` | `[I\|P\|A\|B\|C\|D\|status\|reset] [--force] [--json] [--port <port>]` |
| `dispatch` | `bin/commands/dispatch.ts` | `(--agent <name> \| --virtual <name>) --task <task> [--role <role>] [--cli <cli>] [--model <model>] [--mutable] [--scope <path>] [--port <port>] [--watch] [--json]`; `--batch --agents '<JSON array>'` where each entry accepts `agent` or `virtual` |
| `goal` | `bin/commands/goal.ts` | `set <objective>`, `plan [hint]`, `refine <objective>`, `status`, `update <summary>`, `done [note]`, `cancel [reason]`, `pause`, `resume`, `clear`, `reset`, `history [limit]`; `--json`; plan-mode stores hints as `planHint` and requires refine before checkpoints |
| `worker` | `bin/commands/worker.ts` | `status [agent]`, `watch [agent]`, `--json`, `--port <port>`; current/previous worker-progress safe summaries with lifecycle `attention` notes (`snapshot.workers` is running-only) |
| `service` | `bin/commands/service.ts` | `[--port PORT] [--backend launchd\|systemd\|docker] [status\|unset\|logs]` |
| `dashboard` | `bin/commands/dashboard.ts` | `serve [--port 24576] [--from 3457] [--count 50] [--no-open]`, `memory {search\|instances\|read\|config\|state\|estimate\|reindex\|help} [--instance <ids>] [--limit N] [--json] [--port <port>]`, `chat search "<query>" [--instance <ids>] [--limit N] [--days N] [--json]` |
| `connector` | `bin/commands/connector.ts` | `board add/update/list`, `notes write/list`, `reminders add/list/done`, `audit [--limit N] [--json]` |
| `reminders` | `bin/commands/reminders.ts` | `list`, `add`, `done`; `--json`, `--priority`, `--due`, `--remind`, message/thread link flags |
| `project` | `bin/commands/project.ts` | `set <path>[, <path>...]`, `reset`/`clear`, `list` (instance projectDirs 관리) |
| `task` | `bin/commands/task.ts` | `add/edit/list/start/done/assign/clear`; dashboard-visible atomic checklist |
| `lock` | `bin/commands/lock.ts` | `[--port 3457]`; instance lock (stopAll 보호). `unlock`도 동일 파일 처리 |
| `unlock` | `bin/commands/lock.ts` | `[--port 3457]`; instance unlock |
| `history` | `bin/commands/history.ts` | `search "<query>" [--limit N]`; 채팅 히스토리 검색 (65L) |

---

## Command Behavior Notes

### `/clear`

4-tier cleanup system (`/clear` < `/clear all` < `/purge` < `/reset confirm`):

- `/clear` — session clear only. CLI/Web에서는 `code: 'clear_screen'` 반환으로 UI clear도 유도.
- `/clear all` — skills reset + employees reset + MCP sync + session reset.
- `/purge` — session clear + memory wipe.
- `/reset confirm` — full factory reset.

### `/model [name]` / `/cli [name]`

- 값이 없으면 현재 상태 조회.
- 값이 있으면 `settings.perCli[activeCli].model` 또는 `settings.cli`를 갱신한다.

### `/fallback [cli1 cli2...|off]`

- `fallbackOrder`를 설정하거나 해제한다.

### `/forward [on|off]`

- 현재 remote channel 또는 active channel의 `forwardAll` 값을 조정한다.

### `/thought [status|on|off]`

- Gemini thought visibility toggle. `settings.showReasoning`을 저장한다.

### `/flush [cli] [model] | off`

- memory flush 전용 CLI/model override를 설정한다.

### Workflow slash commands

- `/plan [request|status|copy]`: PABCD P 안내 compatibility command.
- `/interview <request>`: IPABCD I(Interview) 상태 머신으로 진입.
- `/deliberate <request-or-plan>`: Planner/Architect/Critic 관점으로 계획을 점검.
- `/planaudit [plan]`: PABCD A에서 직원에게 보낼 읽기 전용 감사 task text를 만든다.
- `/review [focus] [--fix] [--dispatch]`: `projectDirs` 또는 최근 맥락에서 검증한 git 프로젝트 디렉토리를 리뷰한다. JAW_HOME/`process.cwd()` fallback은 금지한다. 사용자가 `/review 프롬프트`처럼 focus text를 주면 이를 최우선 scope signal로 반영한다. 리뷰 범위는 현재 대화에서 논의 중인 작업 초점을 먼저 잡고, 최근 goal/chat context, 커밋 히스토리, diff, worktree, untracked 파일은 그 범위를 검증하는 근거로 사용한다. `origin/master..HEAD` 같은 git range에 있다는 이유만으로 무관한 최근 커밋을 포함하지 않는다. 결과 Markdown report에는 `Scope Resolution` 근거를 저장한다. `--fix`는 검증된 프로젝트 루트 안의 Critical/High만 현재 `HEAD` 위 새 working-tree patch로 자동 수정하며 기존 커밋을 rewrite하지 않는다.
- `/goal [set|plan|refine|status|run|done|cancel|pause|resume|clear|reset|history] [args...]`: Persistent goal lifecycle management. `/goal plan [hint]` and `/goalplan [hint]` create a pending plan-mode goal, store the raw hint separately as `planHint`, and require `/goal refine <specific objective>` or `cli-jaw goal refine "<specific objective>"` before checkpoints/execution evidence are accepted.
- `/gd [note]`: `/goal done --force [note]`의 축약어. `/goal done`의 completion evidence gate를 우회하는 명시적 quick-complete command다.
- `/team [plan|audit|status|collect|stop] [args...]`: 여러 worker를 병렬로 쓰는 team orchestration helper.

### `jaw dispatch`

- Named employees use `jaw dispatch --agent "Backend" --task "..."`.
- Ephemeral virtual employees use `jaw dispatch --virtual "security" --task "..."` or `--virtual "Reviewer" --role "Review rollback gaps" --task "..."`.
- Virtual employees are synthetic dispatch rows only; they do not appear in `jaw employee list` and do not write durable `employee_sessions`.
- If `--cli`/`--model` are omitted for virtual dispatch, the server resolves the current CLI and uses the registry default model for that CLI.

### `/steer <prompt>`

- Web/Telegram/Discord에서 실행 가능. CLI slash registry에는 노출되지 않는다.
- 실행 중 agent가 없으면 에러. 실행 중이면 kill 후 재지시.

### `/fork`

- 현재 채팅 세션의 메시지를 새 세션으로 복사하고 그 세션으로 전환한다.
- `/new`, `/switch`, `/sessions`와 같은 session category 표면이며 CLI/Web/Telegram/Discord에서 사용 가능하다.

### `/orchestrate` (alias: `/pabcd`)

- PABCD explicit entry. `jaw orchestrate P|A|B|C|D|I|status|reset`는 root CLI transition/control surface.
- `I → P` 전환은 기존 orchestration ctx를 유지한다. 첫 Plan 생성 전에도 `interview.request`가 pinned `originalPrompt` fallback이 되므로, 사용자의 "진행/계속" 같은 짧은 승인 문구가 planning task를 덮어쓰지 않는다.

### `/memory`

| Form | 동작 |
| --- | --- |
| `/memory` 또는 `/memory list` | memory file list |
| `/memory <query...>` | search |
| `/memory status` | runtime status |
| `/memory bootstrap` | core/markdown/kv/claude import bootstrap |
| `/memory reindex` | memory reindex |
| `/memory flush` | memory flush trigger |
| `/memory adv ...` | integrated memory runtime 상태/초기화/bootstrap/reindex 래퍼 |
| `/memory embed status` | embedding state (state/mode/provider/chunks/DB size) |
| `/memory embed estimate` | embedding cost estimate (chunks/batches/seconds/cost) |

### `/browser [status|tabs]`

- 브라우저 상태 또는 열린 탭을 요약한다.

---

## Registry.ts — CLI / Model Source of Truth

`src/cli/registry.ts` (224L)

현재 CLI registry는 13개 top-level runtime을 갖는다.

| CLI | Default Model | Default Effort |
| --- | --- | --- |
| `pi` | `grok-composer-2.5-fast` | `medium` |
| `agy` | *(TUI-managed)* | `''` |
| `ai-e` | `sonnet` | `medium` |
| `claude` | `sonnet` | `medium` |
| `claude-e` | `sonnet` | `medium` |
| `codex` | `gpt-5.5` | `medium` |
| `codex-app` | `gpt-5.5` | `medium` |
| `cursor` | `composer-2.5` | `medium-fast` |
| `gemini` | `gemini-3-flash-preview` | `''` |
| `grok` | `grok-build` | `''` |
| `kiro-code` | `auto` | `''` |
| `opencode` | `opencode-go/kimi-k2.6` | `''` |
| `copilot` | `claude-sonnet-4.6` | `high` |

`CLI_KEYS`, `buildDefaultPerCli()`, `buildModelChoicesByCli()`가 `/cli`, `/model`, `/flush` completion과 settings 기본값 생성에 모두 재사용된다.

---

## CommandContext 통합

`src/cli/command-context.ts` (140L)

### 공통 필드

- `interface`, `locale`, `version`
- `getSession()`, `getSettings()`, `updateSettings()`, `getRuntime()`
- `getSkills()`, `clearSession()`, `resetSession()`, `getCliStatus()`
- MCP / Memory / Browser / Employees / Skills / Prompt helpers

### remote settings patch 제한

Telegram/Discord는 아래 키만 patch 가능하다:

```text
fallbackOrder, cli, perCli, showReasoning, memory, telegram, discord
```

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

### `cmdline` hidden 세트

```text
help, clear, model, cli, fallback, status, reset,
skill, employee, mcp, memory, browser, prompt, version
```

Workflow category commands (`plan`, `interview`, `deliberate`, `planaudit`, `goal`, `team`)도 `cmdline`에서 hidden 처리된다.

---

## CLI API Auth (`api-auth.ts`, 45L)

| Export | 역할 |
| --- | --- |
| `getCliAuthToken(portOrBase?)` | `GET /api/auth/token` 호출 후 base별 token cache |
| `authHeaders(extra?)` | `Authorization: Bearer <token>` 병합 |
| `cliFetch(url, init)` | origin 기준 token 확보 후 fetch |

---

## `jaw dashboard memory` (federation search)

L2 cross-instance read-only memory search.

| Subcommand | 동작 |
| --- | --- |
| `search <query...>` | FTS5 BM25 + trigram fan-out search across instances |
| `instances` / `list` | List discovered instances with DB status |
| `read <instanceId:path>` | Read a `.md` memory file from a specific instance |
| `config get` | Get embedding provider configuration |
| `config set [--provider X] [--api-key X] [--mode X] [--enabled\|--disabled]` | Set embedding provider configuration |
| `state` / `embed-state` | Embedding state (state/mode/provider/chunks/DB size/last sync) |
| `estimate` / `embed-estimate` | Embedding cost estimate (chunks/batches/seconds/cost) |
| `reindex --embedding` | Trigger full re-embedding of all memory chunks |

| Option | 동작 |
| --- | --- |
| `--instance <ids>` | Comma-separated instance filter |
| `--limit <N>` | Max results (default: 50, max 200) |
| `--json` | Raw JSON output |
| `--port <port>` | Dashboard manager port (default: 24576) |

---

## Root CLI release gates

```text
gate:typecheck, gate:tests, gate:truth-table-fresh,
gate:mcp-scope-frozen, gate:no-experimental-in-readme-ready-section, gate:all
```

Use `npm run gate:all` as the broad docs/release sanity command.
