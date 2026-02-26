# Slash Command — File Path 오인 버그 Fix (Frontend)

> Date: 2026-02-25
> Status: **Plan**

---

## 1. 문제

`/Users/junny/AGENTS.md` 같은 **파일 경로**를 채팅에 입력하면 슬래시 커맨드로 인식되어 **일반 메시지로 전송되지 않음**.

### 증상
- 입력값이 AI 에이전트로 전달되지 않고 `/api/command` 엔드포인트로 빠짐
- 서버가 `parseCommand()` → `null` → 400 `not_command` 반환
- 프론트가 에러 표시 후 **메시지를 채팅으로 fallback하지 않음** → 입력 손실

---

## 2. 원인 분석

**서버 측 — 이미 수정됨 ✅**

```javascript
// src/cli/commands.ts L169-184 — parseCommand()
const firstToken = body.split(/\s+/)[0] || '';
if (firstToken.includes('/') || firstToken.includes('\\')) return null;
```

**프론트 측 — 미수정 ❌ (3곳)**

### A. `public/js/features/chat.js` L22 (핵심 버그)
```javascript
if (text.startsWith('/') && !state.attachedFiles.length) {
    // → /api/command로 무조건 보냄 (path 판별 없음)
    // → parseCommand가 null 반환해도 fallback 없이 끝남
    return;  // L55: 일반 채팅 전송 경로로 절대 안 감
}
```

### B. `public/js/features/slash-commands.js` L141
```javascript
if (!raw.startsWith('/') || raw.includes(' ') || raw.includes('\\n')) {
    close(); return;
}
// → /Users/junny 입력하면 '/' 감지 → 자동완성 UI 표시
```

### C. `public/js/features/slash-commands.js` L51
```javascript
if (!inp.value.startsWith('/')) { close(); return; }
// → render()에서도 '/' 감지 → dropdown 유지
```

---

## 3. Fix

### 공통 유틸 함수

```javascript
// path 판별: 첫 토큰(/ 제거 후)이 /를 포함하면 파일 경로
function looksLikeFilePath(text) {
    const afterSlash = text.slice(1).trim();
    const firstToken = afterSlash.split(/\s+/)[0] || '';
    return firstToken.includes('/') || firstToken.includes('\\');
}
```

### A. chat.js L22 수정

```diff
-    if (text.startsWith('/') && !state.attachedFiles.length) {
+    if (text.startsWith('/') && !state.attachedFiles.length && !looksLikeFilePath(text)) {
```

- path면 command 분기를 건너뛰고 일반 채팅 경로로 진입
- 추가: `/api/command`가 `not_command`를 반환하면 일반 메시지로 재전송 (fallback)

### B. slash-commands.js L141 수정

```diff
-    if (!raw.startsWith('/') || raw.includes(' ') || raw.includes('\n')) {
+    if (!raw.startsWith('/') || raw.includes(' ') || raw.includes('\n') || looksLikeFilePath(raw)) {
```

### C. slash-commands.js L51 수정

```diff
-    if (!inp.value.startsWith('/')) { close(); return; }
+    if (!inp.value.startsWith('/') || looksLikeFilePath(inp.value)) { close(); return; }
```

---

## 4. Fallback 전략 (Optional, 보험)

chat.js에서 `/api/command` 실패 시 일반 채팅으로 재전송:

```diff
             const result = await res.json().catch(() => ({}));
-            if (!res.ok && !result?.text) throw new Error(`HTTP ${res.status}`);
+            // not_command → 일반 메시지로 재전송
+            if (result?.code === 'not_command') {
+                addMessage('user', text);
+                await apiJson('/api/message', 'POST', { prompt: text });
+                return;
+            }
+            if (!res.ok && !result?.text) throw new Error(`HTTP ${res.status}`);
```

이렇게 하면 서버 `parseCommand()`가 null을 반환하는 모든 경우(미래 포함)에 대한 안전망이 됨.

---

## 5. 수정 파일

| 파일 | 줄 | 변경 |
|------|-----|------|
| `public/js/features/chat.js` | L22, ~L47 | path 감지 + not_command fallback |
| `public/js/features/slash-commands.js` | L51, L141 | path 감지 추가 |

---

## 6. 검증

```bash
npm run build
npm test
```

### 수동 테스트
1. `/Users/junny/AGENTS.md` 입력 → 일반 채팅으로 전송 확인
2. `/help` 입력 → 슬래시 커맨드 정상 작동 확인
3. `/settings` 입력 → 자동완성 표시 확인
4. `/tmp/test.txt` 입력 → 일반 채팅으로 전송 확인
5. `/nonexistent` 입력 → "unknown command" 에러 확인 (기존 동작 유지)

---

## 7. 리스크

| 리스크 | 평가 |
|--------|------|
| 정상 커맨드가 path로 오인 | **없음** — 커맨드명에 `/`가 포함되지 않음 (help, settings, cli 등) |
| `looksLikeFilePath` 판별 실패 | 낮음 — 서버 fallback이 안전망 역할 |
| 기존 테스트 깨짐 | 없음 — 프론트엔드 JS 변경, 서버 로직 불변 |
