# (fin) Phase 12 — Web UI 멈춤/큐 + Telegram Pending

## 개요

Web UI에서 에이전트 정지(Stop)와 메시지 대기열(Pending Queue)이 작동하지 않는 문제 수정.  
Telegram 초기화 로그를 "disabled" → "pending"으로 변경.

---

## 1. 멈춤 (Stop) 버튼

### 문제

- 에이전트 실행 중 정지(Stop)할 수 있는 UI 요소가 없음
- `/api/stop` 엔드포인트는 존재하지만 Web UI에서 호출하는 방법이 없음

### 해결

#### [MODIFY] `public/js/ui.js` — `setStatus()`

```diff
 if (s === 'running') {
     badge.textContent = '⏳ running';
+    btn.textContent = '■';
+    btn.title = '멈춤 (Stop)';
+    btn.classList.add('stop-mode');
 } else {
     badge.textContent = '⚡ idle';
+    btn.textContent = '➤';
+    btn.title = 'Send';
+    btn.classList.remove('stop-mode');
 }
```

#### [MODIFY] `public/js/features/chat.js` — `sendMessage()`

```diff
+    // Stop mode: clicking ■ stops the agent
+    if (btn.classList.contains('stop-mode') && !input.value.trim() && !state.attachedFile) {
+        await fetch('/api/stop', { method: 'POST' });
+        return;
+    }
+
     const text = input.value.trim();
-    if ((!text && !state.attachedFile) || state.agentBusy) return;
+    if (!text && !state.attachedFile) return;
```

#### [MODIFY] `public/css/chat.css`

```css
.btn-send.stop-mode {
    background: #ef4444;
    font-size: 16px;
    transition: background .2s;
}
.btn-send.stop-mode:hover {
    background: #dc2626;
}
```

---

## 2. Pending Queue 동작

### 문제

- `sendMessage()`에서 `state.agentBusy`일 때 `return`으로 메시지 전송 자체가 차단됨
- 서버의 큐잉 로직(`enqueueMessage`)에 도달하지 않아 큐 뱃지가 표시되지 않음

### 해결

#### [MODIFY] `public/js/features/chat.js`

- `agentBusy` 조건 제거 → 메시지를 서버로 전송
- 서버 응답에서 `{ queued: true, pending: N }` 확인 → `updateQueueBadge(N)` 호출

```diff
+    const data = await res.json();
+    if (data.queued) {
+        const { updateQueueBadge } = await import('../ui.js');
+        updateQueueBadge(data.pending || 1);
+    }
```

---

## 3. Telegram → Pending

#### [MODIFY] `src/telegram.js`

```diff
-    console.log('[tg] Telegram disabled or no token');
+    console.log('[tg] ⏸️  Telegram pending (disabled or no token)');
```

---

## 체크리스트

- [x] `public/js/ui.js` — stop-mode 토글 (■/➤ 전환)
- [x] `public/js/features/chat.js` — stop 호출 + agentBusy 차단 제거 + 큐 뱃지
- [x] `public/css/chat.css` — `.btn-send.stop-mode` 스타일
- [x] `src/telegram.js` — pending 로그 메시지
