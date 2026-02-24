# Phase 13 — Telegram 포워딩 자동 chatId

> Web/CLI 대화 → Telegram 자동 전달 + chatId 자동 캡처

---

## 현상

- Web UI나 CLI에서 대화해도 Telegram으로 결과가 전달되지 않음
- 서버 재시작 시 `telegramActiveChatIds`(메모리) 초기화 → 포워딩 불가

## 근본 원인

`getLastChatId()` → `telegramActiveChatIds`가 비어있으면 `null` → 포워딩 skip.
`allowedChatIds`도 `[]` → fallback 없음.

---

## 구현 계획

### 1. `markChatActive()` — chatId 자동 persist

```js
function markChatActive(chatId) {
    telegramActiveChatIds.delete(chatId);
    telegramActiveChatIds.add(chatId);
    // Auto-persist to settings.json
    const allowed = settings.telegram?.allowedChatIds || [];
    if (!allowed.includes(chatId)) {
        settings.telegram.allowedChatIds = [...allowed, chatId];
        saveSettings(settings);
    }
}
```

### 2. `initTelegram()` — pre-seed from settings

```js
// allowedChatIds → telegramActiveChatIds pre-seed
if (settings.telegram.allowedChatIds?.length) {
    for (const id of settings.telegram.allowedChatIds) telegramActiveChatIds.add(id);
}
```

### 3. `telegram-send` 스킬 — 하드코딩 제거

```bash
# Before: CHAT_ID=8231528245
# After:
CHAT_ID=$(jq -r '.telegram.allowedChatIds[-1]' ~/.cli-claw/settings.json)
```

---

## 토큰 변경 시나리오 검증

| 시나리오 | chatId | 결과 |
|---------|--------|------|
| 같은 봇, 같은 유저 | 고정 | ✅ 정상 |
| 같은 봇, 다른 유저가 `/start` | 새 chatId 추가 | ✅ 자동 캡처 |
| **다른 봇 토큰** | chatId는 유저 기반이므로 **동일** | ⚠️ 새 봇이 유저에게 메시지 보내려면 유저가 먼저 `/start` 해야 함 |
| 토큰 변경 후 바로 포워딩 | sendMessage 실패 (403 Forbidden) | ⚠️ 유저가 새 봇에 `/start` 안 했으면 에러 → 무시하고 다음 메시지에서 자동 캡처 |

### 토큰 변경 대응

- `allowedChatIds` **안 지움** — chatId는 유저 기반이라 봇 바꿔도 숫자 동일
- 새 봇에서 sendMessage 실패 → `catch(() => {})` 무시 → 유저가 새 봇에 메시지 보내면 자동 동작
- 토큰 변경 시 유저에게 "새 봇에 /start 보내세요" 안내가 이상적이나, 지금은 silent fail로 충분

---

## 변경 파일

| 파일 | 변경 |
|------|------|
| `src/telegram.js` | `markChatActive()` persist + `initTelegram()` pre-seed |
| `~/.cli-claw/skills/telegram-send/SKILL.md` | chatId 하드코딩 → settings.json 동적 읽기 |
| `skills_ref/telegram-send/SKILL.md` | 동일 |
