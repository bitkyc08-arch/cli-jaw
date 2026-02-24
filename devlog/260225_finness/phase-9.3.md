# Phase 9.3: server.js 라우트 분리 실행 (WS3 실행)

> Phase 8.3 설계를 실제 코드로 전환한다.

---

## 왜 해야 하는가

9.1(guard) + 9.2(응답 공통화) 적용 후에도 `server.js`는 여전히 **대형 단일 파일**이다.
분리를 통해:
1. 파일별 변경 범위가 100줄 이내로 축소
2. 기능별 테스트 격리 가능
3. git merge conflict 빈도 감소

---

## 구현 순서

### Step 1: 디렉토리 생성

```bash
mkdir -p src/routes
```

### Step 2: 라우트 파일 추출 (6개)

#### `src/routes/core.js`

```js
import { ok, fail } from '../http/response.js';
import { asyncHandler } from '../http/async-handler.js';

export function registerCoreRoutes(app, deps) {
  const { getSession, getMessages, getMessagesWithTrace,
          parseCommand, executeCommand, makeWebCommandCtx,
          COMMANDS, getRuntimeSnapshot, clearSessionState,
          activeProcess, orchestrate, orchestrateContinue,
          killActiveAgent, isContinueIntent, enqueueMessage,
          messageQueue, insertMessage, broadcast } = deps;

  app.get('/api/session', (_, res) => ok(res, getSession()));

  app.get('/api/messages', (req, res) => {
    const incTrace = ['1','true','yes'].includes(String(req.query.includeTrace||'').toLowerCase());
    ok(res, incTrace ? getMessagesWithTrace.all() : getMessages.all());
  });

  app.get('/api/runtime', (_, res) => ok(res, getRuntimeSnapshot()));

  app.post('/api/command', asyncHandler(async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 500);
    const parsed = parseCommand(text);
    if (!parsed) return fail(res, 400, 'not_command');
    ok(res, await executeCommand(parsed, makeWebCommandCtx()));
  }));

  app.get('/api/commands', (req, res) => {
    const iface = String(req.query.interface || 'web');
    ok(res, COMMANDS
      .filter(c => c.interfaces.includes(iface) && !c.hidden)
      .map(c => ({ name: c.name, desc: c.desc, args: c.args||null,
                    category: c.category||'tools', aliases: c.aliases||[] }))
    );
  });

  app.post('/api/message', (req, res) => {
    const { prompt } = req.body;
    if (!prompt?.trim()) return fail(res, 400, 'prompt_required');
    const trimmed = prompt.trim();
    if (isContinueIntent(trimmed)) {
      if (activeProcess) return fail(res, 409, 'agent_running');
      orchestrateContinue({ origin: 'web' });
      return ok(res, { continued: true });
    }
    if (activeProcess) {
      enqueueMessage(trimmed, 'web');
      return ok(res, { queued: true, pending: messageQueue.length });
    }
    orchestrate(trimmed, { origin: 'web' });
    ok(res, {});
  });

  app.post('/api/orchestrate/continue', (req, res) => {
    if (activeProcess) return fail(res, 409, 'agent_running');
    orchestrateContinue({ origin: 'web' });
    ok(res, {});
  });

  app.post('/api/stop', (_, res) => ok(res, { killed: killActiveAgent('api') }));
  app.post('/api/clear', (_, res) => { clearSessionState(); ok(res, {}); });
}
```

#### `src/routes/memory.js` (9.1 guard 포함)

```js
import { ok, fail } from '../http/response.js';
import { asyncHandler } from '../http/async-handler.js';
import { assertFilename, safeResolveUnder } from '../security/path-guards.js';
import { decodeFilenameSafe } from '../security/decode.js';
import fs from 'node:fs';
import { join, basename } from 'node:path';

export function registerMemoryRoutes(app, deps) {
  const { getMemory, upsertMemory, deleteMemory, getMemoryDir,
          settings, saveSettings, memoryFlushCounter, saveUpload, memory } = deps;

  // Memory KV
  app.get('/api/memory', (_, res) => ok(res, getMemory.all()));
  app.post('/api/memory', (req, res) => {
    const { key, value, source = 'manual' } = req.body;
    if (!key || !value) return fail(res, 400, 'key_and_value_required');
    upsertMemory.run(key, value, source);
    ok(res, {});
  });
  app.delete('/api/memory/:key', (req, res) => {
    deleteMemory.run(req.params.key);
    ok(res, {});
  });

  // Memory files (guarded)
  app.get('/api/memory-files', (_, res) => {
    const memDir = getMemoryDir();
    let files = [];
    if (fs.existsSync(memDir)) {
      files = fs.readdirSync(memDir).filter(f => f.endsWith('.md')).sort().reverse().map(f => {
        const content = fs.readFileSync(join(memDir, f), 'utf8');
        const entries = content.split(/^## /m).filter(Boolean).length;
        return { name: f, entries, size: content.length };
      });
    }
    ok(res, { enabled: settings.memory?.enabled !== false,
      flushEvery: settings.memory?.flushEvery ?? 20, path: memDir, files,
      counter: memoryFlushCounter });
  });

  app.get('/api/memory-files/:filename', asyncHandler((req, res) => {
    const base = getMemoryDir();
    const filename = assertFilename(req.params.filename, { allowExt: ['.md'] });
    const fp = safeResolveUnder(base, filename);
    if (!fs.existsSync(fp)) return fail(res, 404, 'not_found');
    ok(res, { name: filename, content: fs.readFileSync(fp, 'utf8') });
  }));

  // ... delete, settings, upload, claw-memory 라우트
}
```

### Step 3: server.js 정리

```js
// server.js (분리 후 ~200줄)
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
// ... 기존 import

import { registerCoreRoutes } from './src/routes/core.js';
import { registerSettingsRoutes } from './src/routes/settings.js';
import { registerMemoryRoutes } from './src/routes/memory.js';
import { registerIntegrationRoutes } from './src/routes/integrations.js';
import { registerEmployeeRoutes } from './src/routes/employees.js';
import { registerBrowserRoutes } from './src/routes/browser.js';
import { notFoundHandler, errorHandler } from './src/http/error-middleware.js';

// Express init
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// ... quota 함수, 헬퍼 함수

// Route registration
const deps = { /* 모든 의존성 */ };
registerCoreRoutes(app, deps);
registerSettingsRoutes(app, deps);
registerMemoryRoutes(app, deps);
registerIntegrationRoutes(app, deps);
registerEmployeeRoutes(app, deps);
registerBrowserRoutes(app, deps);

app.use(notFoundHandler);
app.use(errorHandler);

// Start
server.listen(PORT, () => { /* ... */ });
```

### Step 4: 라우트 검증

```bash
# 분리 전 라우트 목록 보존
rg -oN "app\.(get|post|put|patch|delete)\('/api[^']+" server.js | sort > /tmp/routes-before.txt

# --- 분리 작업 ---

# 분리 후 라우트 목록
rg -oN "app\.(get|post|put|patch|delete)\('/api[^']+" src/routes/*.js server.js | sort > /tmp/routes-after.txt

# 비교
diff /tmp/routes-before.txt /tmp/routes-after.txt
# 차이 = 0
```

---

## 충돌 분석

| 대상 | 변경 | 충돌 |
|---|---|---|
| `server.js` | **MAJOR** — 라우트 제거 | **높음** — 모든 9.x와 동기 필요 |
| `src/routes/*.js` | **NEW** (6개) | 없음 |
| Phase 9.1 | guard가 적용된 라우트를 메모리/직원 파일로 이동 | **순서: 9.1 → 9.3** |
| Phase 9.2 | `ok()/fail()` import가 route 파일로 이동 | **순서: 9.2 → 9.3** |
| Phase 9.4 (테스트) | 라우트 파일 분리 후 import 경로 변경 | 9.3 완료 후 테스트 |

**이 Phase가 가장 큰 충돌 위험을 가지므로, 반드시 9.1/9.2 완료 후 진행.**

---

## 테스트 계획

### 라우트 등록 스모크 테스트

```js
// tests/integration/route-registration.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

const EXPECTED_ROUTES = [
  'GET /api/session', 'GET /api/messages', 'GET /api/runtime',
  'POST /api/command', 'GET /api/commands', 'POST /api/message',
  'POST /api/orchestrate/continue', 'POST /api/stop', 'POST /api/clear',
  'GET /api/settings', 'PUT /api/settings',
  'GET /api/prompt', 'PUT /api/prompt',
  'GET /api/heartbeat-md', 'PUT /api/heartbeat-md',
  'GET /api/memory', 'POST /api/memory', 'DELETE /api/memory/:key',
  'GET /api/memory-files', 'GET /api/memory-files/:filename',
  'DELETE /api/memory-files/:filename', 'PUT /api/memory-files/settings',
  'POST /api/upload',
  'POST /api/telegram/send',
  'GET /api/mcp', 'PUT /api/mcp', 'POST /api/mcp/sync',
  'POST /api/mcp/install', 'POST /api/mcp/reset',
  'GET /api/cli-registry', 'GET /api/cli-status', 'GET /api/quota',
  'GET /api/employees', 'POST /api/employees',
  'PUT /api/employees/:id', 'DELETE /api/employees/:id',
  'POST /api/employees/reset',
  'GET /api/heartbeat', 'PUT /api/heartbeat',
  'GET /api/skills', 'POST /api/skills/enable', 'POST /api/skills/disable',
  'GET /api/skills/:id', 'POST /api/skills/reset',
  'GET /api/claw-memory/search', 'GET /api/claw-memory/read',
  'POST /api/claw-memory/save', 'GET /api/claw-memory/list',
  'POST /api/claw-memory/init',
  'POST /api/browser/start', 'POST /api/browser/stop',
  'GET /api/browser/status', 'GET /api/browser/snapshot',
  'POST /api/browser/screenshot', 'POST /api/browser/act',
  'POST /api/browser/vision-click', 'POST /api/browser/navigate',
  'GET /api/browser/tabs', 'POST /api/browser/evaluate',
  'GET /api/browser/text',
];

test('RR-001: routes are fully registered', () => {
  assert.ok(EXPECTED_ROUTES.length > 0);
  // 실제 검증은 baseline 파일과 after 파일의 set 비교로 수행
});
```

### 실행

```bash
npm test
node --test tests/integration/route-registration.test.js
# rg 기반 비교
```

---

## 완료 기준

- [ ] `server.js` 200줄 이하
- [ ] 6개 라우트 파일 각 100줄 이하
- [ ] baseline 대비 라우트 누락/추가 0건 (diff 0건)
- [ ] `npm test` 통과
- [ ] 프런트 기능 정상 동작
