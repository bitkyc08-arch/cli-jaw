# Phase 2: Server API + Telegram Integration

> 상태: ✅ 구현 완료 | 날짜: 2026-02-24
> 범위: `server.js`, `src/telegram.js`, `src/commands.js`
> 커밋: `37f88ca`

Phase 1에서 `src/commands.js` 레지스트리와 CLI 디스패치가 완성되었다.
Phase 2는 같은 레지스트리를 **서버 API**와 **Telegram**에 연결한다.

---

## 현재 상태

| 항목                         | 상태                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `GET /api/runtime`           | ✅ 이미 추가됨 (Phase 0~1에서 구현)                             |
| `POST /api/command`          | ❌ 없음                                                         |
| `GET /api/commands`          | ❌ 없음                                                         |
| `telegram.js` slash dispatch | ❌ L224: `if (text.startsWith('/')) return;` — 모든 `/` 무시 중 |
| `bot.api.setMyCommands()`    | ❌ 미등록                                                       |

---

## 2A. Server API

### [MODIFY] `server.js`

#### 1. `POST /api/command` — Web/외부에서 커맨드 실행

```js
import { parseCommand, executeCommand, COMMANDS } from './src/commands.js';

app.post('/api/command', async (req, res) => {
    try {
        const text = (req.body?.text || '').trim().slice(0, 500); // 입력 길이 제한
        const parsed = parseCommand(text);
        if (!parsed) return res.status(400).json({ ok: false, code: 'not_command', text: '슬래시 커맨드가 아닙니다.' });
        const ctx = makeWebCommandCtx();
        const result = await executeCommand(parsed, ctx);
        res.json(result);
    } catch (err) {
        console.error('[cmd:error]', err);
        res.status(500).json({ ok: false, code: 'internal_error', text: `서버 오류: ${err.message}` });
    }
});

function makeWebCommandCtx() {
    return {
        interface: 'web',
        version: settings.version || '0.1.0',
        getSession,                              // from db.js
        getSettings: () => settings,             // from config.js (직접 참조)
        updateSettings: (patch) => {             // PUT /api/settings 로직 인라인
            replaceSettings({ ...settings, ...patch });
            saveSettings(settings);
        },
        getRuntime: () => ({
            uptimeSec: Math.floor(process.uptime()),
            activeAgent: !!activeProcess,
            queuePending: messageQueue.length,
        }),
        getSkills: getMergedSkills,               // from prompt.js
        clearSession: () => {
            clearMessages.run();                  // from db.js (prepared statement)
            const s = getSession();
            updateSession.run(s.active_cli, null, s.model, s.permissions, s.working_dir, s.effort);
            broadcast('clear', {});
        },
        getCliStatus: () => detectAllCli(),       // from config.js
        getMcp: () => loadUnifiedMcp(),           // from mcp-sync.js
        syncMcp: () => ({ results: syncToAll(loadUnifiedMcp(), settings.workingDir) }),
        installMcp: async () => {
            const config = loadUnifiedMcp();
            const { installMcpServers } = await import('./lib/mcp-sync.js');
            return { results: await installMcpServers(config) };
        },
        listMemory: () => memory.list(),
        searchMemory: (q) => memory.search(q),
        getBrowserStatus: async () => browser.getBrowserStatus(settings.browser?.cdpPort || 9240),
        getBrowserTabs: async () => ({ tabs: await browser.listTabs(settings.browser?.cdpPort || 9240) }),
        getPrompt: () => {
            const a2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
            return { content: a2 };
        },
    };
}
```

> ⚠️ **핵심**: Web ctx는 서버 모듈 함수를 **직접 호출**한다.
> `fetch(localhost)` self-request 금지 (slash_commands.md §3.2 원칙).
>
> 🔧 **수정사항** (QA 반영):
> - `try/catch` 추가 (H2)
> - 입력 길이 `.slice(0, 500)` 제한 (M1)
> - 함수명을 실제 server.js export와 일치시킴 (`clearMessages.run()`, `loadUnifiedMcp()` 등)

#### 2. `GET /api/commands` — Web UI가 커맨드 목록 조회

```js
app.get('/api/commands', (req, res) => {
    const iface = req.query.interface || 'web';
    res.json(COMMANDS
        .filter(c => c.interfaces.includes(iface) && !c.hidden)
        .map(c => ({
            name: c.name,
            desc: c.desc,
            args: c.args || null,
            category: c.category || 'tools',
            aliases: c.aliases || [],
        }))
    );
```

> 🔧 **UX 반영 (U1)**: `POST /api/command` 응답에 `type` 필드 추가 필요.
> 핸들러 반환값에 `type: 'success' | 'error' | 'info'`를 포함시켜 Web UI에서 색상 분기 가능:
>
> ```js
> // commands.js 핸들러 반환 예시:
> return { ok: true, type: 'success', text: '모델이 변경되었습니다.' };
> return { ok: false, type: 'error', text: '잘못된 커맨드입니다.' };
> return { ok: true, type: 'info', text: '현재 모델: gpt-5.3-codex' };
> ```
});
```

#### 3. `getRuntimeSnapshot()` 함수 추출

이미 인라인으로 존재하지만, `POST /api/command` ctx에서도 사용하므로 함수로 추출:

```js
function getRuntimeSnapshot() {
    return {
        uptimeSec: Math.floor(process.uptime()),
        activeAgent: !!activeProcess,
        queuePending: messageQueue.length,
    };
}
```

#### 4. 기존 `/clear` 특례 분리 확인

현재 `public/js/features/chat.js` L18:
```js
if (text === '/clear') { clearChat(); input.value = ''; return; }
```

이것은 Phase 3에서 통합 디스패치로 교체한다. Phase 2에서는 서버 API만 먼저 준비.

---

## 2B. Telegram Integration

### [MODIFY] `src/telegram.js`

#### 1. Import + `setMyCommands` 등록

```js
import { parseCommand, executeCommand, COMMANDS } from './commands.js';

// BotFather 예약 커맨드 (Grammy가 네이티브 처리)
const RESERVED_CMDS = new Set(['start', 'id', 'help', 'settings']);

// UX 반영 (U2): Telegram에서 read-only인 커맨드는 메뉴에서 제외
const TG_EXCLUDED_CMDS = new Set(['model', 'cli']);  // updateSettings read-only 문제

// initTelegram() 내부, bot.start() 직전에 추가
function syncTelegramCommands(bot) {
    return bot.api.setMyCommands(
        COMMANDS
            .filter(c => c.interfaces.includes('telegram')
                && !RESERVED_CMDS.has(c.name)
                && !TG_EXCLUDED_CMDS.has(c.name))
            .map(c => ({
                command: c.name,
                // UX 반영 (U3): 카테고리 prefix로 메뉴 그룹핑
                description: `[${c.category || '도구'}] ${c.desc}`.slice(0, 256),
            }))
    );
}

// bot.start() 전:
void syncTelegramCommands(bot).catch(e => {
    console.warn('[tg:commands] setMyCommands failed:', e.message);
});
```

> 출처: Grammy 공식 — `bot.api.setMyCommands()`로 Telegram `/` 메뉴에 커맨드 목록 표시.
> 봇 시작마다 최신 목록이 자동 반영됨.
> Telegram Bot API 제약(설명 3~256자)을 만족하도록 fallback + truncate 처리.
>
> 🔧 **수정사항** (QA 반영):
> - `RESERVED_CMDS`로 BotFather 예약어 제외 (M5)
> - 설명 문자열 `3~256`자 제약을 fallback + truncate로 준수 (L1)

#### 2. `/` 무시 → 커맨드 디스패치 교체

```diff
- bot.on('message:text', async (ctx) => {
-     const text = ctx.message.text;
-     if (text.startsWith('/')) return;
+ bot.on('message:text', async (ctx) => {
+     const text = ctx.message.text;
+
+     // Slash command dispatch
+     if (text.startsWith('/')) {
+         const parsed = parseCommand(text);
+         if (!parsed) return;
+         const tgCtx = makeTelegramCommandCtx();
+         const result = await executeCommand(parsed, tgCtx);
+         if (result?.text) {
+             try {
+                 await ctx.reply(result.text);
+             } catch {
+                 await ctx.reply(result.text.slice(0, 4000));
+             }
+         }
+         return;
+     }
```

#### 3. `makeTelegramCommandCtx()` 함수

telegram.js는 server.js와 같은 프로세스에서 동작하므로, self-request(`fetch(localhost)`) 대신
직접 import한 함수를 호출한다.

```js
// telegram.js 상단에 추가 import
import {
    settings, replaceSettings, saveSettings, detectAllCli,
} from './config.js';
import {
    getSession, updateSession, clearMessages,
} from './db.js';
import { getMergedSkills } from './prompt.js';
import {
    activeProcess, messageQueue,
} from './agent.js';
import * as memory from './memory.js';

function makeTelegramCommandCtx() {
    return {
        interface: 'telegram',
        version: settings.version || '0.1.0',
        getSession,                              // db.js 직접 호출
        getSettings: () => settings,             // config.js 직접 참조
        updateSettings: (patch) => {
            // Telegram에서 설정 변경은 제한적 (Phase 2에서는 read-only)
            return { ok: false, text: '❌ Telegram에서 설정 변경은 지원하지 않습니다.' };
        },
        getRuntime: () => ({                     // 직접 계산 (self-request 제거)
            uptimeSec: Math.floor(process.uptime()),
            activeAgent: !!activeProcess,
            queuePending: messageQueue.length,
        }),
        getSkills: getMergedSkills,
        clearSession: () => {
            clearMessages.run();
            const s = getSession();
            updateSession.run(s.active_cli, null, s.model, s.permissions, s.working_dir, s.effort);
            broadcast('clear', {});
        },
        getCliStatus: () => detectAllCli(),
        getMcp: () => ({ servers: {} }),          // TG에서 MCP 조작은 미지원
        syncMcp: async () => ({ results: {} }),
        installMcp: async () => ({ results: {} }),
        listMemory: () => memory.list(),
        searchMemory: (q) => memory.search(q),
        getBrowserStatus: () => ({ running: false }),
        getBrowserTabs: () => ({ tabs: [] }),
        getPrompt: () => ({ content: '(Telegram에서 미지원)' }),
    };
}
```

> 📌 **설계 결정**: Telegram ctx는 대부분 read-only.
> `/model`, `/cli` 변경 시 `updateSettings`가 `{ ok: false }` 반환.
> **⚠️ 주의**: `modelHandler`/`cliHandler`는 `await ctx.updateSettings(patch)` 반환값을 무시하고
> 성공 메시지를 보냄. Phase 2 구현 시 해당 핸들러에 반환값 검증 추가 필요:
>
> ```js
> const result = await ctx.updateSettings(patch);
> if (result?.ok === false) return result;  // 에러 전파
> ```
>
> 🔧 **수정사항** (QA 반영):
> - self-request 제거 → 직접 import (H1)
> - `settings.port` → 제거 (port는 config에 없음) (M4)
> - `clearSession`을 실제 `/api/clear` 로직과 동일하게 (H2)
> - `updateSettings` 반환값 무시 문제 명시 (Codex High 이슈)

#### 4. 기존 `bot.command('start', 'id')` 유지

```
Phase 2: bot.command('start','id') 유지 + on('text') 디스패치 병행
         → /start, /id는 Grammy 네이티브로 BotFather 등록 필수
Phase 3 이후(선택): COMMANDS 이관 검토
```

> 🔧 **UX 반영 (U4)**: Telegram 커맨드 결과 포매팅 개선 로드맵
>
> Phase 2에서는 `ctx.reply(text)` 플레인 텍스트로 충분하지만,
> 후속 버전에서 `parse_mode: 'HTML'` 도입 가능:
>
> ```js
> // Grammy parse-mode 플러그인 (Context7 참조)
> import { hydrateReply, parseMode } from '@grammyjs/parse-mode';
> bot.use(hydrateReply);
> bot.api.config.use(parseMode('HTML'));
>
> // 커맨드 결과 포매팅 예시
> await ctx.reply(
>     `<b>✅ 모델 변경</b>\n<code>${modelName}</code>`,
>     { parse_mode: 'HTML' }
> );
> ```
>
> 출처: [Grammy parse-mode plugin](https://github.com/grammyjs/website/blob/main/site/docs/plugins/parse-mode.md)

---

## 영향 파일

| 파일              | 변경                                                 | 라인       |
| ----------------- | ---------------------------------------------------- | ---------- |
| `server.js`       | `POST /api/command` + `GET /api/commands` + ctx 구성 | ~50줄 추가 |
| `src/telegram.js` | import + setMyCommands + dispatch 교체 + ctx         | ~60줄 변경 |

## 난이도 & 공수

| 항목                               | 난이도 | 공수      |
| ---------------------------------- | ------ | --------- |
| server.js API 엔드포인트           | 🟢      | 30m       |
| server.js ctx 구성 (직접 호출)     | 🟡      | 30m       |
| telegram.js dispatch 교체          | 🟡      | 30m       |
| telegram.js makeTelegramCommandCtx | 🟡      | 20m       |
| setMyCommands 등록                 | 🟢      | 10m       |
| 테스트                             | 🟡      | 30m       |
| **합계**                           |        | **~2.5h** |

---

## 구현 결과 (계획 외 추가 사항)

계획에 없었지만 구현 과정에서 추가된 개선:

| 추가 항목                                   | 파일           | 효과                                                                                  |
| ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `applySettingsPatch()` 함수 추출            | `server.js`    | `PUT /api/settings`와 `makeWebCommandCtx.updateSettings`가 같은 로직 공유 → 중복 제거 |
| `clearSessionState()` 함수 추출             | `server.js`    | `POST /api/clear`와 ctx `clearSession`이 동일 로직 사용                               |
| `TELEGRAM_ALLOWED_CHAT_IDS` 환경변수        | `telegram.js`  | `.env`에서 허용 채팅 ID 설정 가능 → 보안 강화                                         |
| `serve.js` `--env-file=.env` 자동 감지      | `serve.js`     | `.env` 파일 존재 시 자동 로드                                                         |
| TG ctx `getBrowserStatus/Tabs` try/catch    | `telegram.js`  | dynamic import 실패 시 안전 처리                                                      |
| `commands.js` `updateSettings` 반환값 검증  | `commands.js`  | `modelHandler`, `cliHandler`에서 `ok: false` 시 에러 전파                             |
| `package.json` npm dev 스크립트 `.env` 로드 | `package.json` | `npm run dev` 시 자동 환경변수 로드                                                   |

---

## 향후 개선 (Phase 2+)

| 항목                    | 설명                                                                                    | 상태   |
| ----------------------- | --------------------------------------------------------------------------------------- | ------ |
| ~~`APP_VERSION` 통합~~  | `config.js`에서 `package.json` version export, `server.js`/`telegram.js`/`chat.js` 통합 | ✅ 완료 |
| ~~`TG_EXCLUDED_CMDS`~~  | `/model`, `/cli`를 TG 메뉴에서 제외 (`syncTelegramCommands` 필터 추가)                  | ✅ 완료 |
| ~~응답 `type` 필드~~    | `normalizeResult`에서 자동 추론 + `helpHandler`/`statusHandler`에 `type: 'info'` 명시   | ✅ 완료 |
| TG description 그룹핑   | `setMyCommands`의 description에 `[카테고리]` prefix (U3)                                | 🟢      |
| TG `parse_mode: 'HTML'` | `@grammyjs/parse-mode` 플러그인으로 리치 포매팅 (U4)                                    | 🟢      |
| TG `InlineKeyboard`     | `/status` 등의 결과에 "더 보기" 버튼 제공                                               | 🟢      |

## 리스크

| 리스크                                 | 확률 | 영향 | 대응                                                             |
| -------------------------------------- | ---- | ---- | ---------------------------------------------------------------- |
| Telegram ctx 직접 import 시 결합 오류  | 보통 | 보통 | `makeTelegramCommandCtx()` 단위 테스트 + init 시 smoke check     |
| setMyCommands 실패 (토큰 문제)         | 낮음 | 낮음 | catch로 경고만 출력                                              |
| /clear가 Web에서 기존 동작 깨짐        | 낮음 | 보통 | Phase 2에선 서버 API만 준비, 기존 chat.js 미수정                 |
| `updateSettings` read-only로 인한 오해 | 보통 | 보통 | `/model`,`/cli` TG 정책 확정(미지원 안내 or 실제 반영) 명시 필요 |

## 검증

### curl 테스트

```bash
# 1. 커맨드 목록 (web 인터페이스)
curl -s localhost:3457/api/commands | jq '.[].name'

# 2. /help 실행
curl -s -X POST localhost:3457/api/command \
  -H 'Content-Type: application/json' \
  -d '{"text":"/help"}' | jq .

# 3. /status 실행
curl -s -X POST localhost:3457/api/command \
  -H 'Content-Type: application/json' \
  -d '{"text":"/status"}' | jq .

# 4. unknown 커맨드
curl -s -X POST localhost:3457/api/command \
  -H 'Content-Type: application/json' \
  -d '{"text":"/foobar"}' | jq .

# 5. non-slash 거부
curl -s -X POST localhost:3457/api/command \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}' | jq .
```

### Telegram 수동 테스트

1. 봇 시작 후 `/` 터치 → Telegram 커맨드 메뉴에 목록 표시 확인
2. `/status` → 서버 상태 응답
3. `/help` → 커맨드 목록 (TG interface 필터링)
4. `/mcp` → "사용할 수 없습니다" (TG 미지원 커맨드)
5. 일반 텍스트 → 기존 에이전트 응답 유지
