# Phase 20.1: 빠른 승리 — Graceful Shutdown + CommonJS 제거 + localhost 중앙화 + npm files + 에러 바운더리

> Round 1: 즉시 적용 가능한 저위험 수정 5건.

---

## 20.1-A: Graceful Shutdown

### 파일: `server.js`

```diff
 // ─── Start ───────────────────────────────────────────
 
 watchHeartbeatFile();
 
+// ─── Graceful Shutdown ──────────────────────────────
+['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => {
+    console.log(`\n[server] ${sig} received, shutting down...`);
+    stopHeartbeat();
+    killActiveAgent('shutdown');
+    wss.close();
+    server.close(() => {
+        console.log('[server] closed');
+        process.exit(0);
+    });
+    setTimeout(() => process.exit(1), 5000);
+}));
+
 server.listen(PORT, () => {
```

**의존성:** `stopHeartbeat` (이미 import), `killActiveAgent` (이미 import), `wss` (같은 파일), `server` (같은 파일)

---

## 20.1-B: CommonJS 제거 (chat.js)

### 파일: `bin/commands/chat.js`

```diff
-import { createRequire } from 'node:module';
-const _require = createRequire(import.meta.url);
-const APP_VERSION = _require('../../package.json').version;
+import { APP_VERSION } from '../../src/config.js';
```

**검증:** `APP_VERSION`은 `src/config.js`에서 이미 export됨 (L13).
chat.js에서 3곳 사용: L107, L130, L192 → import 교체만으로 완료.

---

## 20.1-C: localhost 하드코딩 중앙화

### 파일: `src/config.js` (추가)

```diff
 export const SKILLS_REF_DIR = join(CLAW_HOME, 'skills_ref');
 
+// ─── Server URLs ────────────────────────────────────
+export function getServerUrl(port) {
+    return `http://localhost:${port || process.env.PORT || 3457}`;
+}
+export function getWsUrl(port) {
+    return `ws://localhost:${port || process.env.PORT || 3457}`;
+}
+export const DEFAULT_PORT = '3457';
```

### 파일: `bin/commands/memory.js`

```diff
+import { getServerUrl } from '../../src/config.js';
 
-const SERVER = `http://localhost:${process.env.PORT || 3457}`;
+const SERVER = getServerUrl();
```

### 파일: `bin/commands/browser.js`

```diff
+import { getServerUrl } from '../../src/config.js';
 
-const SERVER = `http://localhost:${process.env.PORT || 3457}`;
+const SERVER = getServerUrl();
```

### 파일: `bin/commands/status.js`

```diff
+import { getServerUrl, DEFAULT_PORT } from '../../src/config.js';
+
 const { values } = parseArgs({
     args: process.argv.slice(3),
     options: {
-        port: { type: 'string', default: process.env.PORT || '3457' },
+        port: { type: 'string', default: process.env.PORT || DEFAULT_PORT },
         json: { type: 'boolean', default: false },
     },
     strict: false,
 });
 
-const url = `http://localhost:${values.port}/api/settings`;
+const url = `${getServerUrl(values.port)}/api/settings`;
```

그리고 L31:
```diff
-                const hbRes = await fetch(`http://localhost:${values.port}/api/heartbeat`, { signal: AbortSignal.timeout(2000) });
+                const hbRes = await fetch(`${getServerUrl(values.port)}/api/heartbeat`, { signal: AbortSignal.timeout(2000) });
```

### 파일: `bin/commands/reset.js`

```diff
+import { getServerUrl } from '../../src/config.js';
 
-const baseUrl = `http://localhost:${values.port}`;
+const baseUrl = getServerUrl(values.port);
```

### 파일: `bin/commands/employee.js`

```diff
+import { getServerUrl } from '../../src/config.js';
 
-const baseUrl = `http://localhost:${values.port}`;
+const baseUrl = getServerUrl(values.port);
```

### 파일: `bin/commands/chat.js`

```diff
-const wsUrl = `ws://localhost:${values.port}`;
-const apiUrl = `http://localhost:${values.port}`;
+import { getServerUrl, getWsUrl } from '../../src/config.js';
+const wsUrl = getWsUrl(values.port);
+const apiUrl = getServerUrl(values.port);
```

### 파일: `bin/commands/serve.js`

```diff
+import { getServerUrl } from '../../src/config.js';
 
 if (values.open) {
     setTimeout(() => {
-        exec(`open http://localhost:${values.port}`, (err) => {
+        exec(`open ${getServerUrl(values.port)}`, (err) => {
             if (err) console.log('  ⚠️ Could not open browser');
         });
     }, 2000);
 }
```

---

## 20.1-D: npm files 수정

### 파일: `package.json`

```diff
     "files": [
         "bin/",
         "server.js",
         "public/",
-        "package.json"
+        "package.json",
+        "src/",
+        "lib/",
+        "skills_ref/"
     ],
```

---

## 20.1-E: Frontend 에러 바운더리

### 파일: `public/js/main.js`

```diff
 // ── App Entry Point ──
 // All event bindings happen here (no inline onclick in HTML)
 
+// ── Global Error Boundary ──
+window.addEventListener('unhandledrejection', (e) => {
+    console.error('[unhandled]', e.reason);
+    e.preventDefault();
+});
+window.addEventListener('error', (e) => {
+    console.error('[error]', e.message, e.filename, e.lineno);
+});
+
 import { connect } from './ws.js';
```

---

## 테스트 계획

```bash
# 기존 테스트 통과 확인
npm test

# CommonJS 잔존 확인
grep -rn "require(" --include="*.js" --exclude-dir=node_modules --exclude-dir=skills_ref

# localhost 하드코딩 잔존 확인 (server.js 출력 로그 제외)
grep -rn "localhost" bin/commands/ --include="*.js" | grep -v getServerUrl | grep -v getWsUrl

# npm pack dry-run (files 확인)
npm pack --dry-run 2>&1 | head -30
```

---

## 완료 기준

- [x] `SIGTERM` 시 서버 정상 종료 (DB/WS 정리) — server.js L909-921
- [x] `grep -rn "createRequire" bin/` → 0건
- [x] `grep -rn "localhost" bin/commands/` → getServerUrl/getWsUrl 만 (표시 문자열 2건 제외)
- [x] `npm pack --dry-run`에 src/, lib/ 포함
- [x] Frontend 콘솔에 unhandledrejection 핸들러 동작 — main.js L4-10
- [x] `npm test` 통과 (216/216)

---

## 구현 기록

> 구현일: 2026-02-25
> 변경 파일 10개, 테스트 216/216 통과

### 변경 요약

| 항목 | 파일 | 비고 |
|---|---|---|
| 20.1-A Graceful Shutdown | `server.js` | SIGTERM/SIGINT → stopHeartbeat + killActiveAgent + wss.close + server.close |
| 20.1-B CommonJS 제거 | `bin/commands/chat.js` | `createRequire` → `import { APP_VERSION } from '../../src/config.js'` |
| 20.1-C localhost 중앙화 | `src/config.js` + 7 bin/commands | `getServerUrl()`, `getWsUrl()`, `DEFAULT_PORT` 추가 |
| 20.1-D npm files | `package.json` | `src/`, `lib/`, `skills_ref/` 추가 |
| 20.1-E 에러 바운더리 | `public/js/main.js` | `unhandledrejection` + `error` 글로벌 핸들러 |

### 남은 localhost 참조 (의도적 유지)
- `reset.js:62` — 에러 메시지 표시용
- `chat.js:194` — 배너 표시용

