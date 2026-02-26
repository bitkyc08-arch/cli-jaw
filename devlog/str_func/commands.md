# src/cli/ — Slash Command Registry & Dispatcher

> cli/commands.ts (271L) + cli/handlers.ts (432L) + cli/registry.ts (89L) + cli/acp-client.ts (328L)
> 16개 커맨드, 3개 인터페이스 (cli/web/telegram). cli-registry 기반 동적 모델 매핑.
> Phase 9.5: `command-contract/` 모듈로 capability 정책 + help 렌더링 통합.
> Phase 20.6: commands.ts 658줄 → commands.ts (268L, 레지스트리) + handlers.ts (432L, 핸들러) 분리

---

## 핵심 함수

| Function                             | 역할                                                  |
| ------------------------------------ | ----------------------------------------------------- |
| `parseCommand(text)`                 | `/cmd args` 파싱 → `{ name, args[] }`                 |
| `executeCommand(parsed, ctx)`        | 커맨드 실행 + `normalizeResult` (응답 type 자동 추론) |
| `getCompletions(partial, iface)`     | CLI/Web 자동완성용 명령 필터링                        |
| `getCompletionItems(partial, iface)` | 자동완성 항목 (name+desc+args)                        |
| `COMMANDS` (export)                  | 커맨드 배열 (name, desc, args, interfaces, handler)   |

### cli-registry 통합

```js
import { CLI_KEYS, buildModelChoicesByCli } from './registry.ts';

const DEFAULT_CLI_CHOICES = [...CLI_KEYS];
const MODEL_CHOICES_BY_CLI = buildModelChoicesByCli();
```

- `/cli` 커맨드: `CLI_KEYS`에서 선택지 동적 생성
- `/model` 커맨드: `MODEL_CHOICES_BY_CLI[currentCli]`에서 모델 목록
- 새 CLI 추가 시 `cli-registry.ts`만 수정하면 커맨드에 자동 반영

### 응답 type 필드

`normalizeResult()`에서 `ok` 기반 자동 추론:
- `ok: true` → `type: "success"`
- `ok: false` → `type: "error"`
- 기타 → `type: "info"`
- 핸들러에서 명시 가능 (자동 추론 오버라이드)

---

## 커맨드 레지스트리 구조

```js
{
  name: '/help',
  desc: '사용 가능한 명령어 목록',
  args: [],
  interfaces: ['cli', 'web', 'telegram'],
  handler: async (args, ctx) => { ... }
}
```

### 인터페이스별 ctx (Context)

각 인터페이스는 고유한 ctx를 만들어 `executeCommand`에 전달:

| 인터페이스 | ctx 생성                   | 위치                   |
| ---------- | -------------------------- | ---------------------- |
| **Web**    | `makeWebCommandCtx()`      | `server.ts`            |
| **CLI**    | inline ctx                 | `bin/commands/chat.ts` |
| **TG**     | `makeTelegramCommandCtx()` | `src/telegram/bot.ts`  |

공통 ctx 필드: `reply(msg)` · `getSession()` · `getSettings()` · `getAgentStatus()` · `interface`

---

## slash-commands.js — Web UI 드롭다운 (231L)

`public/js/features/slash-commands.js`

Web UI의 슬래시 커맨드 드롭다운 UI 구현:
- 입력창 `/` 타이핑 시 커맨드 자동완성 표시
- `GET /api/commands?interface=web` 에서 사용 가능 커맨드 로드
- 키보드 탐색 (↑↓ Enter Esc)
- 선택 시 `POST /api/command`로 실행

---

## src/command-contract/ — 인터페이스 통합 (3파일, 120L) [P9.5]

COMMANDS 배열을 capability map으로 확장하여 인터페이스별 정책 통합.

### catalog.ts (39L)

| Export                | 역할                                                    |
| --------------------- | ------------------------------------------------------- |
| `CAPABILITY`          | `{ full, readonly, hidden, blocked }` enum              |
| `getCommandCatalog()` | COMMANDS + 인터페이스별 capability map 반환              |

Telegram에서 `model`/`cli`는 `readonly`, 나머지는 `full`. Web에서 `hidden` 커맨드 제외.

### policy.ts (37L)

| Function                     | 역할                                     |
| ---------------------------- | ---------------------------------------- |
| `getVisibleCommands(iface)`  | hidden/blocked 제외 커맨드 목록          |
| `getExecutableCommands(iface)` | full capability만 필터                 |
| `getTelegramMenuCommands()`  | Telegram `setMyCommands`용 (reserved 제외) |

### help-renderer.ts (44L)

| Function            | 역할                                             |
| ------------------- | ------------------------------------------------ |
| `renderHelp(opts)`  | list mode (전체) 또는 detail mode (특정 커맨드)  |

```js
renderHelp({ iface: 'web' })                    // → 전체 목록
renderHelp({ iface: 'web', commandName: 'help' }) // → 상세
```
