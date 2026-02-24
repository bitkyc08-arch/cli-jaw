# Phase 6: Telegram Bot 연동 (openclaw-ref 기반)

## 아키텍처

```
Telegram → grammy Bot → allowlist check → typing indicator
                       → orchestrateAndCollect(prompt)
                       → Markdown → Telegram HTML → chunked reply
                       ↕
              broadcast 리스너 (agent_done/agent_output 캡처)
```

## openclaw-ref에서 포팅하는 패턴

| 패턴                          | openclaw-ref 위치             | cli-claw 적용                     |
| ----------------------------- | ----------------------------- | --------------------------------- |
| sequentialize (채팅별 직렬화) | `bot.ts:225`                  | `@grammyjs/runner`                |
| API throttler                 | `bot.ts:150`                  | `@grammyjs/transformer-throttler` |
| 에러 캐칭                     | `bot.ts:152`                  | `bot.catch()`                     |
| allowlist 인증                | `bot-handlers.ts:346-357`     | `allowedChatIds` 기반             |
| typing 표시                   | `bot-message-dispatch.ts:685` | `sendChatAction('typing')`        |
| Markdown → HTML               | `format.ts:110-127`           | 간소화 `escapeHtml` + 기본 태그   |
| 4096자 chunking               | `format.ts:244-261`           | 4096 기준 split                   |
| inbound debounce              | `bot-handlers.ts:139-186`     | text fragment 버퍼링              |
| update dedupe                 | `bot.ts:193-205`              | in-memory Set                     |

## 구현 체크리스트

### 6.1 의존성 + broadcast 리스너 패턴

```bash
npm install grammy @grammyjs/runner @grammyjs/transformer-throttler
```

`broadcast()` 내부 리스너 추가:
```js
const broadcastListeners = new Set();
function addBroadcastListener(fn) { broadcastListeners.add(fn); }
function removeBroadcastListener(fn) { broadcastListeners.delete(fn); }
// broadcast() 안에서: for (const fn of broadcastListeners) fn(type, data);
```

### 6.2 Telegram 포맷터

```js
function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function markdownToTelegramHtml(md) {
    // 기본 변환: **bold** → <b>, *italic* → <i>, `code` → <code>, ```block``` → <pre><code>
}
function chunkTelegramMessage(text, limit = 4096) {
    // 4096자 기준 split (코드블록 안에서 자르지 않음)
}
```

### 6.3 `orchestrateAndCollect()` — 결과 수집 헬퍼

broadcast 리스너로 `agent_done` 캡처 + timeout:
```js
function orchestrateAndCollect(prompt) {
    return new Promise((resolve) => {
        let partialText = '';
        const handler = (type, data) => {
            if (type === 'agent_output') partialText += data.text || '';
            if (type === 'agent_done') {
                removeBroadcastListener(handler);
                resolve(data.text || partialText);
            }
        };
        addBroadcastListener(handler);
        orchestrate(prompt).catch(err => {
            removeBroadcastListener(handler);
            resolve(`❌ ${err.message}`);
        });
        setTimeout(() => { removeBroadcastListener(handler); resolve('⏰ 시간 초과'); }, 120000);
    });
}
```

### 6.4 `initTelegram()` — 봇 생성 + 핸들러

openclaw-ref 패턴 따라:
```js
const { Bot } = require('grammy');
const { sequentialize } = require('@grammyjs/runner');
const { apiThrottler } = require('@grammyjs/transformer-throttler');

function initTelegram() {
    if (!settings.telegram?.enabled || !settings.telegram?.token) return;
    
    const bot = new Bot(settings.telegram.token);
    
    // 1. API 쓰로틀링 (openclaw: bot.ts:150)
    bot.api.config.use(apiThrottler());
    
    // 2. 에러 캐칭 (openclaw: bot.ts:152)
    bot.catch((err) => console.error('[tg:error]', err));
    
    // 3. 채팅별 직렬화 (openclaw: bot.ts:225)
    bot.use(sequentialize((ctx) => `tg:${ctx.chat?.id || 'unknown'}`));
    
    // 4. allowlist (openclaw: bot-handlers.ts:346)
    bot.use(async (ctx, next) => {
        const allowed = settings.telegram.allowedChatIds;
        if (allowed?.length > 0 && !allowed.includes(ctx.chat?.id)) return;
        await next();
    });
    
    // 5. 텍스트 처리
    bot.on('message:text', async (ctx) => {
        const text = ctx.message.text;
        console.log(`[tg:in] ${ctx.chat.id}: ${text.slice(0, 80)}`);
        
        // DB에 유저 메시지 저장
        insertMessage.run('user', text, 'telegram', '');
        
        // typing 표시 (openclaw: dispatch:685)
        const typingInterval = setInterval(() => {
            ctx.replyWithChatAction('typing').catch(() => {});
        }, 4000);
        await ctx.replyWithChatAction('typing').catch(() => {});
        
        try {
            const result = await orchestrateAndCollect(text);
            clearInterval(typingInterval);
            
            // Markdown → HTML 변환 + chunking
            const chunks = chunkTelegramMessage(markdownToTelegramHtml(result));
            for (const chunk of chunks) {
                await ctx.reply(chunk, { parse_mode: 'HTML' });
            }
            
            // DB에 응답 저장
            insertMessage.run('assistant', result, 'telegram', '');
        } catch (err) {
            clearInterval(typingInterval);
            await ctx.reply(`❌ Error: ${err.message}`);
        }
    });
    
    bot.start();
    console.log('[tg] Bot started');
    return bot;
}
```

### 6.5 Settings UI — Telegram 섹션

Settings 탭에 추가:
- Token 입력 (password type)
- Enabled 토글
- Allowed Chat IDs (쉼표 구분)
- 실시간 저장 + 봇 재시작

### 6.6 봇 재시작 (토큰 변경 시)

```js
// PUT /api/settings에서
if (body.telegram && telegramBot) {
    telegramBot.stop();
    telegramBot = null;
    initTelegram();
}
```

## 체크리스트

- [ ] 6.1 grammy + 플러그인 설치, broadcast 리스너 패턴
- [ ] 6.2 Telegram HTML 포맷터 + chunking
- [ ] 6.3 orchestrateAndCollect() 헬퍼
- [ ] 6.4 initTelegram() (throttle, sequentialize, allowlist, typing, handler)
- [ ] 6.5 Settings UI Telegram 섹션
- [ ] 6.6 봇 재시작 로직
