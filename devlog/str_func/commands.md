# commands.js — Slash Command Registry & Dispatcher (573L)

> 커맨드 레지스트리 + 디스패쳐 엔진. 14개 커맨드, 3개 인터페이스 (cli/web/telegram).

---

## 핵심 함수

| Function                             | 역할                                                  |
| ------------------------------------ | ----------------------------------------------------- |
| `parseCommand(text)`                 | `/cmd args` 파싱 → `{ name, args[] }`                 |
| `executeCommand(parsed, ctx)`        | 커맨드 실행 + `normalizeResult` (응답 type 자동 추론) |
| `getCompletions(partial, iface)`     | CLI/Web 자동완성용 명령 필터링                        |
| `getCompletionItems(partial, iface)` | 자동완성 항목 (name+desc+args)                        |
| `COMMANDS` (export)                  | 커맨드 배열 (name, desc, args, interfaces, handler)   |

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
  description: '사용 가능한 명령어 목록',
  args: [],
  interfaces: ['cli', 'web', 'telegram'],
  handler: async (args, ctx) => { ... }
}
```

### 인터페이스별 ctx (Context)

각 인터페이스는 고유한 ctx를 만들어 `executeCommand`에 전달:

| 인터페이스 | ctx 생성                   | 위치                   |
| ---------- | -------------------------- | ---------------------- |
| **Web**    | `makeWebCommandCtx()`      | `server.js`            |
| **CLI**    | inline ctx                 | `bin/commands/chat.js` |
| **TG**     | `makeTelegramCommandCtx()` | `src/telegram.js`      |

공통 ctx 필드: `reply(msg)` · `getSession()` · `getSettings()` · `getAgentStatus()` · `interface`

---

## slash-commands.js — Web UI 드롭다운 (220L)

`public/js/features/slash-commands.js`

Web UI의 슬래시 커맨드 드롭다운 UI 구현:
- 입력창 `/` 타이핑 시 커맨드 자동완성 표시
- `GET /api/commands?interface=web` 에서 사용 가능 커맨드 로드
- 키보드 탐색 (↑↓ Enter Esc)
- 선택 시 `POST /api/command`로 실행
