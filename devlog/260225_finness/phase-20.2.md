# Phase 20.2: 안정성 — Frontend fetch 래퍼 + WS 재연결 복원 + 로거 도입

> Round 2: 네트워크 에러에 강한 프론트엔드 + 백엔드 로그 정리.

---

## 20.2-A: Frontend API 래퍼 생성 + 전체 교체

### 신규 파일: `public/js/api.js`

```js
// ── API Fetch Wrapper ──
// 모든 API 호출을 중앙화하여 에러 처리 + ok/data 언래핑

/**
 * @param {string} path - API 경로 (예: '/api/settings')
 * @param {RequestInit} opts - fetch 옵션
 * @returns {Promise<any|null>} - 성공 시 데이터, 실패 시 null
 */
export async function api(path, opts = {}) {
    try {
        const res = await fetch(path, opts);
        if (!res.ok) {
            console.warn(`[api] ${opts.method || 'GET'} ${path} → ${res.status}`);
            return null;
        }
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('json')) return null;
        const json = await res.json();
        // Phase 9.2 dual-response 호환: { ok, data } 또는 기존 bare 응답
        if (json && typeof json === 'object' && 'ok' in json && 'data' in json) {
            if (!json.ok) {
                console.warn(`[api] ${path} → ok:false`, json.error || '');
                return null;
            }
            return json.data;
        }
        return json;
    } catch (e) {
        console.warn(`[api] ${path} failed:`, e.message);
        return null;
    }
}

/**
 * POST/PUT/DELETE JSON 요청
 */
export async function apiJson(path, method, body) {
    return api(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * fire-and-forget: 결과 무시
 */
export function apiFire(path, method = 'POST', body) {
    const opts = { method };
    if (body) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
    }
    fetch(path, opts).catch(() => {});
}
```

### 교체 대상 (41곳)

> 실제 fetch 호출 카운트: constants(1) + ui(3) + chat(6) + employees(4) + heartbeat(3) + i18n(1) + memory(5) + settings(16) + skills(1) + slash-commands(1) = **41곳**
> (i18n.js L125 `localeFetch`는 자체가 래퍼이므로 제외 → 실질 교체 40곳)

#### `public/js/ui.js`

```diff
+import { api } from './api.js';
 
 // L129
-    const msgs = await (await fetch('/api/messages')).json();
+    const msgs = await api('/api/messages') || [];
 
 // L134
-    const msgs = await (await fetch('/api/messages')).json();
+    const msgs = await api('/api/messages') || [];
 
 // L140
-        const items = await (await fetch('/api/memory')).json();
+        const items = await api('/api/memory') || [];
```

#### `public/js/features/employees.js`

```diff
+import { api, apiJson, apiFire } from '../api.js';
 
 // L9
-    state.employees = await (await fetch('/api/employees')).json();
+    state.employees = await api('/api/employees') || [];
 
 // L89
-    await fetch('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
+    await apiJson('/api/employees', 'POST', {});
 
 // L93
-    await fetch(`/api/employees/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
+    await apiJson(`/api/employees/${id}`, 'PUT', data);
 
 // L97
-    await fetch(`/api/employees/${id}`, { method: 'DELETE' });
+    await api(`/api/employees/${id}`, { method: 'DELETE' });
```

#### `public/js/features/memory.js`

```diff
+import { api, apiFire } from '../api.js';
 
 // L5
-    const r = await fetch('/api/memory-files');
-    const { files, enabled, flushEvery, counter } = await r.json();
+    const data = await api('/api/memory-files');
+    if (!data) return;
+    const { files, enabled, flushEvery, counter } = data;
 
 // L36
-    await fetch('/api/memory-files/settings', { method: 'PUT', ... });
+    await apiJson('/api/memory-files/settings', 'PUT', { enabled, flushEvery });
 
 // L75
-    await fetch('/api/memory-files/' + name, { method: 'DELETE' });
+    await api('/api/memory-files/' + name, { method: 'DELETE' });
 
 // L80
-    const r = await fetch('/api/memory-files/' + name);
-    const data = await r.json();
+    const data = await api('/api/memory-files/' + name);
+    if (!data) return;
```

#### `public/js/features/heartbeat.js`

```diff
+import { api, apiJson } from '../api.js';
 
 // L6
-    const r = await fetch('/api/heartbeat');
-    const data = await r.json();
+    const data = await api('/api/heartbeat');
+    if (!data) return;
 
 // L70
-    await fetch('/api/heartbeat', { method: 'PUT', ... });
+    await apiJson('/api/heartbeat', 'PUT', { jobs: state.heartbeatJobs });
 
 // L79
-    const r = await fetch('/api/heartbeat');
+    const data = await api('/api/heartbeat');
```

#### `public/js/features/settings.js`

```diff
+import { api, apiJson } from '../api.js';
 
 // L122
-    const s = await (await fetch('/api/settings')).json();
+    const s = await api('/api/settings');
+    if (!s) return;
 
 // L162
-    const d = await (await fetch('/api/mcp')).json();
+    const d = await api('/api/mcp');
 
 // L177
-    const d = await (await fetch('/api/mcp/sync', { method: 'POST' })).json();
+    const d = await api('/api/mcp/sync', { method: 'POST' });
 
 // L190
-    const d = await (await fetch('/api/mcp/install', { method: 'POST' })).json();
+    const d = await api('/api/mcp/install', { method: 'POST' });
 
 // L205, L215, L266, L333, L347, L357, L405 — settings PUT
-    await fetch('/api/settings', { method: 'PUT', headers: ..., body: ... });
+    await apiJson('/api/settings', 'PUT', patchData);
 
 // L307
-    fetch('/api/settings').then(r => r.json()).then(s => { ... });
+    api('/api/settings').then(s => { if (s) { ... } });
 
 // L426-427
-    const [cliStatus, quota] = await Promise.all([
-        (await fetch('/api/cli-status')).json(),
-        (await fetch('/api/quota')).json(),
-    ]);
+    const [cliStatus, quota] = await Promise.all([
+        api('/api/cli-status'),
+        api('/api/quota'),
+    ]);
+    if (!cliStatus || !quota) return;
 
 // L513
-    fetch('/api/prompt').then(r => r.json()).then(({ content }) => { ... });
+    api('/api/prompt').then(data => { if (data) { ... } });
 
 // L526
-    await fetch('/api/prompt', { method: 'PUT', ... });
+    await apiJson('/api/prompt', 'PUT', { content });
```

#### `public/js/features/chat.js`

```diff
+import { api, apiJson } from '../api.js';
 
 // L14
-    await fetch('/api/stop', { method: 'POST' });
+    await api('/api/stop', { method: 'POST' });
 
 // L35
-    const res = await fetch('/api/command', { ... });
+    const res = await apiJson('/api/command', 'POST', { text });
 
 // L80 — message 전송 (에러 분기 이미 있으므로 래퍼 불필요, 유지)
 // (이 곳은 res.ok 체크가 이미 있어서 raw fetch 유지 가능)
 
 // L139
-    await fetch('/api/clear', { method: 'POST' });
+    await api('/api/clear', { method: 'POST' });
```

#### `public/js/features/skills.js`

```diff
+import { api } from '../api.js';
 
 // L54
-    await fetch(endpoint, { method: 'POST', ... });
+    await apiJson(endpoint, 'POST', { id: skillId });
```

#### `public/js/constants.js`

```diff
+import { api } from './api.js';
 
 // L95
-    const response = await fetch('/api/cli-registry');
-    const data = await response.json();
+    const data = await api('/api/cli-registry');
+    if (!data) return;
```

#### `public/js/features/slash-commands.js`

```diff
+import { api } from '../api.js';
 
 // L103
-    const res = await fetch(url, { headers: { 'Accept-Language': locale } });
+    const data = await api(url);
```

#### `public/js/features/i18n.js`

```diff
+import { api } from '../api.js';
 
 // L37
-    const res = await fetch(`/api/i18n/${lang}`);
+    const data = await api(`/api/i18n/${lang}`);
```

> `i18n.js` L125의 `localeFetch`는 자체가 fetch 래퍼이므로 유지.

#### `public/js/features/memory.js` (L43 추가)

```diff
 // L43 — 두 번째 settings PUT (flushEvery 업데이트)
-    await fetch('/api/memory-files/settings', { method: 'PUT', ... });
+    await apiJson('/api/memory-files/settings', 'PUT', { enabled, flushEvery });
```

---

## 20.2-B: WS 재연결 상태 복원

### 파일: `public/js/ws.js`

```diff
+import { loadMessages } from './ui.js';
+
 export function connect() {
     state.ws = new WebSocket(`ws://${location.host}?lang=${getLang()}`);
+
+    state.ws.onopen = () => {
+        console.log('[ws] connected');
+        // 재연결 시 현재 상태 복원 — 기존 메시지 클리어 후 로드
+        const chatMessages = document.getElementById('chatMessages');
+        if (chatMessages) chatMessages.innerHTML = '';
+        loadMessages();
+    };
+
     state.ws.onmessage = (e) => {
```

```diff
-    state.ws.onclose = () => setTimeout(connect, 2000);
+    state.ws.onclose = () => {
+        console.warn('[ws] disconnected, reconnecting in 2s...');
+        setStatus('idle');
+        setTimeout(connect, 2000);
+    };
 }
```

---

## 20.2-C: 백엔드 로거 모듈

### 신규 파일: `src/logger.js`

```js
// ─── Logger (level-aware console wrapper) ────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;

export const log = {
    debug: (...args) => { if (current <= 0) console.debug('[debug]', ...args); },
    info:  (...args) => { if (current <= 1) console.log(...args); },
    warn:  (...args) => { if (current <= 2) console.warn(...args); },
    error: (...args) => { if (current <= 3) console.error(...args); },
};
```

### 적용 (점진 — server.js 주요 로그만 1차 전환)

```diff
+import { log } from './src/logger.js';
 
 // server.listen 콜백 내
-    console.log(`\n  🦞 Claw Agent — http://localhost:${PORT}\n`);
-    console.log(`  CLI:    ${settings.cli}`);
-    console.log(`  Perms:  ${settings.permissions}`);
+    log.info(`\n  🦞 Claw Agent — http://localhost:${PORT}\n`);
+    log.info(`  CLI:    ${settings.cli}`);
+    log.info(`  Perms:  ${settings.permissions}`);
 
 // 에러 로그
-    } catch (e) { console.error('[mcp-init]', e.message); }
+    } catch (e) { log.error('[mcp-init]', e.message); }
```

> 전체 71곳 console.log → log.info 전환은 점진적으로. 1차에서는 server.js 기동 로그 + error 로그만.

---

## 테스트 계획

```bash
npm test

# api.js 모듈 로드 확인 (브라우저에서 import 가능)
node -e "import('./public/js/api.js').then(m => console.log(Object.keys(m)))"

# 로거 확인
LOG_LEVEL=debug node -e "import('./src/logger.js').then(({log}) => { log.debug('d'); log.info('i'); log.warn('w'); })"
LOG_LEVEL=warn node -e "import('./src/logger.js').then(({log}) => { log.debug('d'); log.info('i'); log.warn('w'); })"
```

---

## 완료 기준

- [ ] `public/js/api.js` 생성
- [ ] 35곳 fetch → api/apiJson/apiFire 교체
- [ ] WS onopen에 loadMessages 호출
- [ ] WS onclose에 상태 리셋 + 로그
- [ ] `src/logger.js` 생성
- [ ] server.js 기동 로그 log.info 전환
- [ ] `npm test` 통과
- [ ] 브라우저에서 네트워크 끊김 시 콘솔 에러 없이 null 반환 확인
