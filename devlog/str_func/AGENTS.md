# devlog/str_func — Source Structure & Function Reference

> 코드 구조 + 함수 레퍼런스 문서 모음. 서브 문서 7개.

## 커맨드/API 변경 시 동기화 체크리스트

커맨드나 API 수정 시 **반드시** 아래를 확인:

### 코드 (4곳)

| #   | 파일                                           | 역할          | 확인 사항                                         |
| --- | ---------------------------------------------- | ------------- | ------------------------------------------------- |
| 1   | `src/commands.js`                              | COMMANDS 배열 | name, interfaces, handler, getArgumentCompletions |
| 2   | `server.js` → `makeWebCommandCtx()`            | Web ctx       | handler가 쓰는 ctx 함수 존재 여부                 |
| 3   | `bin/commands/chat.js` → `makeCliCommandCtx()` | CLI ctx       | handler가 쓰는 ctx 함수 존재 여부                 |
| 4   | `src/telegram.js` → `makeTelegramCommandCtx()` | Telegram ctx  | handler가 쓰는 ctx 함수 존재 여부                 |

추가로 CLI 서브커맨드일 경우:

| #   | 파일                     | 확인 사항                    |
| --- | ------------------------ | ---------------------------- |
| 5   | `bin/cli-claw.js`        | switch case + printHelp 등록 |
| 6   | `bin/commands/<name>.js` | 실제 구현 파일               |

### 문서 (4곳)

| #   | 파일                            | 확인 사항                     |
| --- | ------------------------------- | ----------------------------- |
| 1   | `README.md`                     | CLI Commands, REST API 테이블 |
| 2   | `devlog/str_func.md`            | 파일 트리 + 라인 카운트       |
| 3   | `devlog/str_func/commands.md`   | 슬래시 커맨드 상세            |
| 4   | `devlog/str_func/server_api.md` | API 엔드포인트 목록           |

### ctx 함수 매핑 (현재)

| ctx 함수         | Web | CLI | Telegram | 사용 커맨드                      |
| ---------------- | --- | --- | -------- | -------------------------------- |
| getSettings      | ✅   | ✅   | ✅        | /status, /model, /cli, /fallback |
| updateSettings   | ✅   | ✅   | ✅(제한)  | /model, /cli, /fallback          |
| getRuntime       | ✅   | ✅   | ✅        | /status                          |
| getSkills        | ✅   | ✅   | ✅        | /status, /skill list             |
| clearSession     | ✅   | ✅   | ✅        | /reset                           |
| getCliStatus     | ✅   | ✅   | ✅        | /version                         |
| getMcp           | ✅   | ✅   | ✅(stub)  | /mcp                             |
| syncMcp          | ✅   | ✅   | ✅(stub)  | /mcp sync, /reset                |
| installMcp       | ✅   | ✅   | ✅(stub)  | /mcp install                     |
| listMemory       | ✅   | ✅   | ✅        | /memory list                     |
| searchMemory     | ✅   | ✅   | ✅        | /memory search                   |
| getBrowserStatus | ✅   | ✅   | ✅        | /browser status                  |
| getBrowserTabs   | ✅   | ✅   | ✅        | /browser tabs                    |
| resetEmployees   | ✅   | ✅   | ❌        | /employee reset, /reset          |
| resetSkills      | ✅   | ✅   | ❌        | /skill reset, /reset             |
| getPrompt        | ✅   | ✅   | ❌        | /prompt                          |

> ❌ = 해당 인터페이스에서 커맨드 자체가 unavailable이므로 ctx 불필요

---

## 새 인터페이스 추가 가이드 (예: Discord)

### 1. 파일 생성

```
src/discord.js    ← 봇 연결 + 메시지 핸들러
```

### 2. 커맨드 ctx 구현

`makeDiscordCommandCtx()` 함수 생성:
- `interface: 'discord'` 필수
- 위 ctx 매핑 테이블의 함수들 중 지원할 것만 구현
- 지원 안 하는 것은 stub으로 (`() => ({})`)

### 3. commands.js COMMANDS 배열 업데이트

각 커맨드의 `interfaces` 배열에 `'discord'` 추가:
```javascript
interfaces: ['cli', 'web', 'telegram', 'discord']
```

### 4. server.js 연동

```javascript
import { startDiscordBot } from './src/discord.js';
// startup 시:
if (settings.discord?.token) startDiscordBot(settings);
```

### 5. 문서 업데이트

위 "문서 4곳" 체크리스트 따라 README, str_func 등 갱신.
