# Phase 5.2 (finness): Copilot 💭 Thinking Merge

> 현재: 💭 전부 차단 → 진행상황 0
> 목표: 연속 💭을 머지해서 1건으로 flush (Web UI + Telegram 모두)

---

## 현재 문제

```
🔧 Read file
(... 30초간 아무것도 안 보임 — 60개 💭 전부 차단 중 ...)
🔧 Edit file
```

## 목표 동작

```
🔧 Read file
💭 Let me think about... I need to consider... OK my plan is...  ← 60개→1건 merge
🔧 Edit file
✅ Edit done
💭 Now let me verify... I should check syntax...                 ← 다시 merge
📝 완료 메시지
```

---

## 설계

### 백엔드 (`src/agent.js`) — ~15줄 변경

```js
// ctx에 추가
ctx.thinkingBuf = '';

// 💭 핸들러 변경 (L290-292)
if (parsed.tool.icon === '💭') {
    ctx.thinkingBuf += parsed.tool.label + ' ';
    return;  // 아직 broadcast 안 함
}

// 다른 tool/text 도착 시 → thinkingBuf flush
if (ctx.thinkingBuf) {
    const merged = ctx.thinkingBuf.trim();
    // 200자 제한 (앞부분 truncate)
    const display = merged.length > 200 ? '…' + merged.slice(-200) : merged;
    broadcast('agent_tool', { agentId, icon: '💭', label: display });
    ctx.thinkingBuf = '';
}
```

### 프론트엔드 — 변경 없음 ✅

- 기존 `agent_tool` 이벤트를 그대로 사용
- tool summary `<details>` 안에 자연스럽게 표시
- CSS 변경 없음

### Telegram — 변경 없음 ✅

- `agent_tool` 이벤트는 이미 Telegram에 전달되는 구조
- 💭 merge된 1건만 갈 뿐 → flood 없음

---

## 파일 변경

| 파일 | 변경 | 줄수 |
|------|------|------|
| `src/agent.js` | 💭 buffer + flush 로직 | +15L |

### 프론트/Telegram 변경 0줄

---

## 시나리오 비교

### Before (현재)
```
Web UI: 🔧 Read file → (30초 침묵) → 🔧 Edit
Telegram: 🔧 Read file → (30초 침묵) → 🔧 Edit
```

### After
```
Web UI: 🔧 Read file → 💭 Let me think... my plan is... → 🔧 Edit
Telegram: 🔧 Read file → 💭 Let me think... my plan is... → 🔧 Edit
```

---

## 엣지 케이스

| 케이스 | 처리 |
|--------|------|
| 💭만 오고 exit | `acp.on('exit')` 핸들러에서 남은 buf flush |
| 💭 내용이 빈 문자열 | skip (flush 안 함) |
| 💭 200자 초과 | 앞부분 truncate, 뒤 200자만 표시 |
| text 도착 직전 💭 | text 처리 전에 flush |
