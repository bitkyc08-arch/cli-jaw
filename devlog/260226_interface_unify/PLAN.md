# Interface Unification: WebUI · CLI · Telegram 입력/출력 통합

## 메타
- Date: 2026-02-26
- Status: Phase 0 (분석 완료, 기획 승인 대기)
- 관련 파일: server.ts, src/telegram/bot.ts, src/telegram/forwarder.ts, bin/commands/chat.ts

---

## 0. 문제 정의

**메시지를 받아서 → 의도 판별 → 큐/실행 → orchestrate → 결과 전달** 패턴이:
- `server.ts` WS handler (L174-222)
- `server.ts` REST `/api/message` (L401-432)
- `bot.ts` `tgOrchestrate` (L283-429)

**3곳에 중복 구현**되어 있고, 각각 미묘하게 다름.

추가로 Telegram 출력 경로가 **2갈래**:
- 직접 입력 (`tgOrchestrate`): typing + tool status + HTML reply
- 다른 인터페이스에서 전달 (`forwarder.ts`): `agent_done` → 결과만 전달 (typing 없음)

→ **같은 orchestrate인데 입력 출처에 따라 UX가 완전히 다른 문제**

---

## 1. 현재 아키텍처 (흐름도)

```mermaid
graph TD
    subgraph "입력 처리 (3곳 중복)"
        WS["server.ts WS handler<br/>L174-222<br/>intent+queue+orchestrate"]
        REST["server.ts REST /api/message<br/>L401-432<br/>intent+queue+orchestrate"]
        TG["bot.ts tgOrchestrate<br/>L283-429<br/>intent+queue+orchestrateAndCollect"]
    end

    subgraph "출력 처리 (불균형)"
        BUS["bus.ts broadcast<br/>→ WS 전체 전송"]
        TG_OUT["tgOrchestrate 내부<br/>typing + tool + reply"]
        FWD["forwarder.ts<br/>agent_done만 전달"]
    end

    WS --> |"orchestrate()"| BUS
    REST --> |"orchestrate()"| BUS
    TG --> |"orchestrateAndCollect()"| TG_OUT
    BUS --> |"forwardAll"| FWD
```

---

## 2. 입력 처리 비교 (코드 수준 검증)

### 2.1 서버 WS 핸들러 — `server.ts:174-222`

```typescript
// L177-218 (41줄)
if (msg.type === 'send_message' && msg.text) {
    const text = String(msg.text).trim();
    if (isContinueIntent(text)) {          // intent 감지
        if (activeProcess) {               // busy 체크
            broadcast('agent_done', { text: t('ws.agentBusy', …), error: true });
        } else {
            insertMessage.run('user', text, 'cli', '');     // ← 소스: 'cli'
            broadcast('new_message', { … source: 'cli' });
            orchestrateContinue({ origin: 'cli' });
        }
        return;
    }
    if (isResetIntent(text)) { /* 동일 패턴 */ }
    if (activeProcess) {
        enqueueMessage(text, 'cli');       // 큐잉
    } else {
        insertMessage.run('user', text, 'cli', '');
        broadcast('new_message', { …, source: 'cli' });
        orchestrate(text, { origin: 'cli' });
    }
}
```

### 2.2 REST API — `server.ts:401-432`

```typescript
// L401-432 (31줄) — 거의 동일 패턴, HTTP 응답만 다름
app.post('/api/message', (req, res) => {
    if (isContinueIntent(trimmed)) {       // intent 감지
        if (activeProcess) return res.status(409)…;   // busy → HTTP 409
        orchestrateContinue({ origin: 'web' });
        return res.json({ ok: true, continued: true });
    }
    if (isResetIntent(trimmed)) { /* 동일 */ }
    if (activeProcess) {
        enqueueMessage(trimmed, 'web');    // 큐잉
        return res.json({ ok: true, queued: true });
    }
    insertMessage.run('user', trimmed, 'web', '');   // ← 소스: 'web'
    broadcast('new_message', { …, source: 'web' });
    orchestrate(trimmed, { origin: 'web' });
    res.json({ ok: true });
});
```

### 2.3 Telegram — `bot.ts:283-429`

```typescript
// L283-429 (146줄) — 같은 패턴 + TG 고유 출력 로직 포함
async function tgOrchestrate(ctx, prompt, displayMsg) {
    if (activeProcess) {                   // busy → TG 큐잉 (고유 handler 포함)
        enqueueMessage(prompt, 'telegram');
        insertMessage.run('user', displayMsg, 'telegram', '');  // ← 소스: 'telegram'
        …
        return;
    }
    markChatActive(ctx.chat.id);
    insertMessage.run('user', displayMsg, 'telegram', '');
    broadcast('new_message', { …, source: 'telegram' });

    // ─── TG 고유: typing + tool status (L315-391) ──
    await ctx.replyWithChatAction('typing');
    const typingInterval = setInterval(…, 4000);
    // tool handler: agent_tool → status message 편집
    // …

    // ─── TG 고유: orchestrateAndCollect ──
    const result = await orchestrateAndCollect(prompt, { origin: 'telegram' });
    // ← bus listener로 orchestrate_done까지 수집하는 Promise wrapper
    clearInterval(typingInterval);
    // HTML 변환 + reply
}
```

### 2.4 핵심 차이 정리

| 항목 | WS (server.ts) | REST (server.ts) | Telegram (bot.ts) |
|------|----------------|-------------------|---------------------|
| 줄 수 | 41줄 | 31줄 | **146줄** |
| intent 감지 | ✅ `isContinueIntent` + `isResetIntent` | ✅ 동일 | ⚠️ `isResetIntent` 별도 분기 (L451-462) |
| busy 응답 | `broadcast('agent_done', {error})` | `res.status(409)` | `ctx.reply(queued)` + queueHandler |
| source 태그 | `'cli'` | `'web'` | `'telegram'` |
| orchestrate 함수 | `orchestrate()` / `orchestrateContinue()` | 동일 | **`orchestrateAndCollect()`** (별도 함수) |
| 결과 수신 | bus → WS 자동 전달 | HTTP 응답 없음 (별도) | Promise로 직접 수집 |
| typing | 없음 (WebUI CSS 처리) | - | ✅ 4초 간격 `sendChatAction` |
| tool status | bus → WS → 프론트 | - | ✅ 메시지 편집 |

---

## 3. 출력 처리 비교

### 3.1 WebUI/CLI — bus → WebSocket

```text
orchestrate() → broadcast('agent_chunk/tool/done', …)
                    ↓
bus.ts L14-19: wss.clients.forEach(c => c.send(msg))
                    ↓
WebUI JS → DOM 업데이트 (typing indicator, tool badge, 스트리밍)
CLI chat.ts → process.stdout.write (스트리밍)
```

### 3.2 Telegram 직접 입력 — `tgOrchestrate` 내부

```text
tgOrchestrate (L315-428):
  1. sendChatAction('typing')     ← 4초마다 갱신 (L318-322)
  2. agent_tool → ctx.reply(🔄 …) → ctx.api.editMessageText(…) (L381-391)
  3. orchestrateAndCollect() 완료 → typing 정리 + HTML reply (L395-414)
```

### 3.3 다른 인터페이스 → Telegram — `forwarder.ts`

```text
forwarder.ts L82-104:
  type !== 'agent_done' → return   ← agent_done만 감지!
  data.origin === 'telegram' → skip
  bot.api.sendMessage(chatId, 📡 + html)
```

**문제**: forwarder는 `agent_done`만 감지하므로:
- ❌ typing 표시 없음
- ❌ tool 사용 표시 없음
- ❌ 에러 처리 없음

---

## 4. CommandContext 3벌 비교

| 메서드 | `makeWebCommandCtx` (server.ts:309) | `makeCliCommandCtx` (chat.ts:114) | `makeTelegramCommandCtx` (bot.ts:149) |
|--------|------|------|------|
| 구현 | 직접 호출 (같은 프로세스) | HTTP API 경유 | 직접 호출 (같은 프로세스) |
| getMcp | ✅ `loadUnifiedMcp()` | ✅ HTTP | ❌ `{ servers: {} }` |
| syncMcp | ✅ | ✅ HTTP | ❌ `{ results: {} }` |
| installMcp | ✅ | ✅ HTTP | ❌ `{ results: {} }` |
| resetEmployees | ✅ | ✅ HTTP | ❌ 없음 |
| resetSkills | ✅ | ✅ HTTP | ❌ 없음 |
| getBrowserStatus | ✅ `browser.getBrowserStatus()` | ✅ HTTP | ⚠️ try/catch 래핑 |
| getPrompt | ✅ `fs.readFileSync(A2_PATH)` | ✅ HTTP | ❌ 미지원 메시지 반환 |
| clearSession | ✅ `clearSessionState()` | ✅ HTTP | ⚠️ 직접 DB 호출 |

> `chat.ts`는 WS 클라이언트(다른 프로세스)이므로 HTTP 경유는 정상. 실제 문제는 **`makeWebCommandCtx`와 `makeTelegramCommandCtx`가 같은 프로세스인데 별도 구현 + 기능 격차**.

---

## 5. `orchestrateAndCollect` — TG 전용 함수 (bot.ts:35-80)

```typescript
// bot.ts L35-80 — broadcast listener로 결과를 Promise로 감쌈
function orchestrateAndCollect(prompt, meta) {
    return new Promise((resolve) => {
        let collected = '';
        const handler = (type, data) => {
            if (type === 'agent_output') collected += data.text;
            if (type === 'orchestrate_done') {
                if (data.origin !== meta.origin) return;   // origin 필터
                removeBroadcastListener(handler);
                resolve(data.text || collected || '응답 없음');
            }
        };
        addBroadcastListener(handler);
        orchestrate(prompt, meta);  // 또는 orchestrateContinue/Reset
    });
}
```

이 함수가 존재하는 이유: **Telegram은 결과를 `ctx.reply()`로 보내야 하므로** orchestrate 완료 시점을 알아야 함. WebUI/CLI는 bus → WS 자동 전달이라 필요 없음.

→ 통합 시 이 함수 대신 **bus listener 기반 TG output handler**가 `orchestrate_done`을 감지하면 됨.

---

## 6. 통합 제안

### Phase A — 입력 통합: `submitMessage()` Gateway

```typescript
// src/orchestrator/gateway.ts [NEW]

export function submitMessage(text: string, meta: {
    origin: 'web' | 'cli' | 'telegram';
    displayText?: string;
}): { action: 'queued' | 'started' | 'rejected'; reason?: string; pending?: number } {
    const trimmed = text.trim();
    if (!trimmed) return { action: 'rejected', reason: 'empty' };

    if (isContinueIntent(trimmed)) {
        if (activeProcess) return { action: 'rejected', reason: 'busy' };
        insertMessage.run('user', meta.displayText || trimmed, meta.origin, '');
        broadcast('new_message', { role: 'user', content: meta.displayText || trimmed, source: meta.origin });
        orchestrateContinue({ origin: meta.origin });
        return { action: 'started' };
    }
    if (isResetIntent(trimmed)) {
        if (activeProcess) return { action: 'rejected', reason: 'busy' };
        insertMessage.run('user', meta.displayText || trimmed, meta.origin, '');
        broadcast('new_message', { role: 'user', content: meta.displayText || trimmed, source: meta.origin });
        orchestrateReset({ origin: meta.origin });
        return { action: 'started' };
    }
    if (activeProcess) {
        enqueueMessage(trimmed, meta.origin);
        insertMessage.run('user', meta.displayText || trimmed, meta.origin, '');
        broadcast('new_message', { role: 'user', content: meta.displayText || trimmed, source: meta.origin });
        return { action: 'queued', pending: messageQueue.length };
    }
    insertMessage.run('user', meta.displayText || trimmed, meta.origin, '');
    broadcast('new_message', { role: 'user', content: meta.displayText || trimmed, source: meta.origin });
    orchestrate(trimmed, { origin: meta.origin });
    return { action: 'started' };
}
```

### 호출 측 변경

```diff
 // server.ts WS handler — 41줄 → 8줄
 if (msg.type === 'send_message' && msg.text) {
-    // 41줄의 intent/queue/orchestrate 로직
+    const result = submitMessage(msg.text, { origin: 'cli' });
+    if (result.action === 'rejected' && result.reason === 'busy') {
+        broadcast('agent_done', { text: t('ws.agentBusy', …), error: true });
+    }
 }

 // server.ts REST /api/message — 31줄 → 4줄
 app.post('/api/message', (req, res) => {
-    // 31줄의 intent/queue/orchestrate 로직
+    const result = submitMessage(req.body.prompt, { origin: 'web' });
+    res.json({ ok: true, ...result });
 });

 // bot.ts tgOrchestrate — 입력 부분만 교체
 async function tgOrchestrate(ctx, prompt, displayMsg) {
-    if (activeProcess) { enqueueMessage(…); … }
-    markChatActive(ctx.chat.id);
-    insertMessage.run(…);
-    broadcast(…);
+    markChatActive(ctx.chat.id);
+    const result = submitMessage(prompt, { origin: 'telegram', displayText: displayMsg });
     // TG 고유 출력 로직은 유지 (typing, tool, reply)
 }
```

### Phase B — TG 출력 통합: `createTelegramOutputHandler`

기존 `forwarder.ts`의 `createTelegramForwarder`를 확장하여 **중간 이벤트 감지 + typing + tool 표시** 추가:

```diff
 // forwarder.ts
-export function createTelegramForwarder(…) {
+export function createTelegramOutputHandler(…) {
     return (type, data) => {
-        if (type !== 'agent_done' || !data?.text) return;
+        if (shouldSkip(data)) return;
+        const chatId = getLastChatId();
+        if (!chatId) return;
+
+        // typing 시작/갱신
+        if (type === 'agent_status' && data.status === 'running') {
+            startTyping(chatId);  // 4초 간격 sendChatAction
+        }
+        // tool 표시
+        if (type === 'agent_tool' && data.icon && data.label) {
+            pushToolStatus(chatId, `${data.icon} ${data.label}`);
+        }
+        // 완료 → typing 정리 + 결과 전달
+        if (type === 'orchestrate_done' && data.text) {
+            stopTyping();
+            sendResult(chatId, data.text);
+        }
     };
 }
```

이렇게 하면:
- `tgOrchestrate` 내부의 typing/tool/reply 로직(L315-428) → output handler로 이동
- `orchestrateAndCollect()` (L35-80) → **제거** (output handler가 `orchestrate_done` 감지)
- **어디서 보내든 텔레그램에서 동일한 UX** (typing + tool + 결과)

---

## 7. 변경 파일 요약

| 파일 | 변경 | 감소 라인 (추정) |
|------|------|:---:|
| [NEW] `src/orchestrator/gateway.ts` | `submitMessage()` 함수 | +35 |
| `server.ts` L174-222 | WS handler → `submitMessage()` | -33 |
| `server.ts` L401-432 | REST handler → `submitMessage()` | -27 |
| `server.ts` L434-448 | `/api/orchestrate/*` → `submitMessage()` | -14 |
| `bot.ts` L35-80 | `orchestrateAndCollect()` → 제거 | -45 |
| `bot.ts` L283-429 | `tgOrchestrate` 입력+출력 분리 | -80 |
| `forwarder.ts` L75-105 | `createTelegramOutputHandler`로 확장 | +40 |
| **순 감소** | | **~124줄** |

---

## 8. CommandContext 통합 (Phase C, 선택적)

`makeWebCommandCtx`와 `makeTelegramCommandCtx`를 **하나의 팩토리 함수**로 병합. TG에서 누락된 기능(MCP, browser, resetEmployees 등)을 활성화할지 정책만 결정하면 됨.

```typescript
// src/command-contract/factory.ts [NEW]
export function makeCommandCtx(iface: 'web' | 'telegram' | 'cli', …) {
    return {
        interface: iface,
        getSession, getSettings,
        getMcp: () => loadUnifiedMcp(),     // TG에서도 활성화
        syncMcp: () => syncToAll(…),
        // … 공통 메서드
        // TG 제한: updateSettings에서 fallbackOrder만 허용 (정책)
        updateSettings: iface === 'telegram'
            ? (patch) => { /* fallbackOrder만 */ }
            : (patch) => applySettingsPatch(patch, { restartTelegram: true }),
    };
}
```

---

## 9. 테스트 계획

### 9.1 기존 테스트 (통과 필수)

```bash
npx vitest run
```

관련 테스트:
- `tests/unit/bus.test.ts` — broadcast 동작
- `tests/telegram-forwarding.test.ts` — forwarder 로직
- `tests/events.test.ts` — 이벤트 흐름
- `tests/integration/api-smoke.test.ts` — REST API

### 9.2 신규 테스트

```
# submitMessage() 단위 테스트
SM-001: empty text → { action: 'rejected', reason: 'empty' }
SM-002: continue intent + !busy → { action: 'started' } + orchestrateContinue 호출
SM-003: continue intent + busy → { action: 'rejected', reason: 'busy' }
SM-004: reset intent + !busy → { action: 'started' } + orchestrateReset 호출
SM-005: normal text + !busy → { action: 'started' } + orchestrate 호출
SM-006: normal text + busy → { action: 'queued' } + enqueueMessage 호출
SM-007: TG displayText → insertMessage에 displayText 저장

# TG output handler 테스트
TG-001: agent_status running → sendChatAction('typing') 호출
TG-002: agent_tool → 상태 메시지 생성
TG-003: orchestrate_done → typing 정리 + 결과 sendMessage
TG-004: origin 'telegram' → shouldSkip 동작 (직접 입력은 tgOrchestrate가 처리)
TG-005: origin 'web' → forwarder가 typing + 결과 전달
```

### 9.3 수동 검증

1. WebUI에서 메시지 → 정상 응답 확인
2. Telegram에서 메시지 → typing + tool + 응답 확인
3. **WebUI 메시지 → Telegram에서 typing 표시 + 결과 도착** (핵심)
4. busy 중 큐잉 → 모든 인터페이스에서 동작 확인
5. continue/reset intent → 모든 인터페이스에서 동일 동작

---

## 10. 실행 순서

| 단계 | 내용 | 위험도 |
|------|------|:---:|
| **Phase A** | `gateway.ts` 생성 + server.ts/bot.ts 호출 교체 | 낮음 |
| **Phase B** | forwarder 확장 + tgOrchestrate 출력 분리 | 중간 |
| **Phase C** | CommandContext 통합 (선택) | 낮음 |

> Phase A만으로도 입력 로직 중복 제거(-74줄). Phase B까지 하면 TG UX 균일화 달성.
