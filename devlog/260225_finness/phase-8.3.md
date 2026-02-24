# Phase 8.3: server.js 구조 분리 설계 (947줄 → 6개 라우트 모듈)

> 이 문서는 Phase 8의 P1(구조 분리) 설계를 다룬다.

---

## 왜 해야 하는가

### 현재 상태

```bash
$ wc -l server.js
947 server.js

$ rg -n "app\.(get|post|put|patch|delete)\('/api" server.js | wc -l
62
```

단일 파일에 API 라우트/quota/헬퍼/부팅 로직이 혼재되어 변경 충돌이 잦다.

### 발생하는 문제

1. **변경 충돌 빈도**: 모든 기능 수정이 server.js를 건드려 git merge conflict 발생
2. **회귀 범위 예측 불가**: memory 라우트 수정이 telegram 라우트에 영향을 줄 수 있는지 추적 어려움
3. **테스트 격리 불가**: 특정 라우트 그룹만 테스트하려 해도 전체 서버를 올려야 함
4. **`dev` 스킬 500줄 룰 위반**: 400줄 이상 초과

### 현재 파일 구조 (책임별 분류)

- `.env 로더`, `quota 조회`, `Express/WebSocket 초기화`, `라우트 등록`, `부팅`이 한 파일에 공존
- 기능 단위가 아닌 파일 단위로 변경이 섞여서 PR 충돌 빈도 상승
- 라우트 시그니처 변경 여부를 자동 비교하기 어려움

---

## 설계: Route Registrar 패턴

### 목표 구조

```
src/
  routes/
    core.js            # session, messages, runtime, command, orchestrate, stop, clear
    settings.js        # settings, prompt, heartbeat-md
    memory.js          # memory KV, memory-files, claw-memory, upload
    integrations.js    # telegram send, MCP CRUD, quota
    employees.js       # employees CRUD, skills, heartbeat
    browser.js         # browser 11개 라우트
  http/
    response.js        # ok(), fail() — Phase 8.2에서 생성
    async-handler.js   # asyncHandler — Phase 8.2에서 생성
    error-middleware.js # errorHandler — Phase 8.2에서 생성
server.js              # 앱 초기화, 미들웨어 등록, start/stop
```

### Route Registrar 인터페이스

```js
// src/routes/core.js
import { ok, fail } from '../http/response.js';
import { asyncHandler } from '../http/async-handler.js';

export function registerCoreRoutes(app, deps) {
  const { getSession, getMessages, getMessagesWithTrace,
          parseCommand, executeCommand, makeWebCommandCtx,
          COMMANDS, activeProcess, orchestrate, orchestrateContinue,
          killActiveAgent, isContinueIntent, enqueueMessage,
          messageQueue, insertMessage, broadcast,
          getRuntimeSnapshot, clearSessionState } = deps;

  app.get('/api/session', (_, res) => ok(res, getSession()));

  app.get('/api/messages', (req, res) => {
    const incTrace = ['1','true','yes'].includes(
      String(req.query.includeTrace || '').toLowerCase()
    );
    ok(res, incTrace ? getMessagesWithTrace.all() : getMessages.all());
  });

  app.get('/api/runtime', (_, res) => ok(res, getRuntimeSnapshot()));

  app.post('/api/command', asyncHandler(async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 500);
    const parsed = parseCommand(text);
    if (!parsed) return fail(res, 400, 'not_command');
    const result = await executeCommand(parsed, makeWebCommandCtx());
    ok(res, result);
  }));

  // ... 나머지 코어 라우트
}
```

### Deps 객체 (server.js에서 조립)

```js
// server.js (분리 후)
import { registerCoreRoutes } from './src/routes/core.js';
import { registerSettingsRoutes } from './src/routes/settings.js';
import { registerMemoryRoutes } from './src/routes/memory.js';
import { registerIntegrationRoutes } from './src/routes/integrations.js';
import { registerEmployeeRoutes } from './src/routes/employees.js';
import { registerBrowserRoutes } from './src/routes/browser.js';

const deps = {
  getSession, getMessages, getMessagesWithTrace,
  parseCommand, executeCommand, makeWebCommandCtx,
  COMMANDS, settings, /* ... etc */
};

registerCoreRoutes(app, deps);
registerSettingsRoutes(app, deps);
registerMemoryRoutes(app, deps);
registerIntegrationRoutes(app, deps);
registerEmployeeRoutes(app, deps);
registerBrowserRoutes(app, deps);

app.use(notFoundHandler);
app.use(errorHandler);
```

---

## 분리 상세: 파일별 라우트 배정

### `src/routes/core.js` (~80줄)

| Method | Route | 출처 행 |
|---|---|---|
| GET | /api/session | L330 |
| GET | /api/messages | L331-335 |
| GET | /api/runtime | L336 |
| POST | /api/command | L338-359 |
| GET | /api/commands | L361-373 |
| POST | /api/message | L375-395 |
| POST | /api/orchestrate/continue | L397-403 |
| POST | /api/stop | L405-408 |
| POST | /api/clear | L410-413 |

### `src/routes/settings.js` (~50줄)

| Method | Route | 출처 행 |
|---|---|---|
| GET | /api/settings | L416 |
| PUT | /api/settings | L417-419 |
| GET | /api/prompt | L422-425 |
| PUT | /api/prompt | L426-432 |
| GET | /api/heartbeat-md | L435-438 |
| PUT | /api/heartbeat-md | L439-444 |

### `src/routes/memory.js` (~100줄)

| Method | Route | 출처 행 |
|---|---|---|
| GET | /api/memory | L447 |
| POST | /api/memory | L448-453 |
| DELETE | /api/memory/:key | L454-457 |
| GET | /api/memory-files | L460-479 |
| GET | /api/memory-files/:filename | L480-484 |
| DELETE | /api/memory-files/:filename | L485-489 |
| PUT | /api/memory-files/settings | L490-494 |
| POST | /api/upload | L497-502 |
| GET | /api/claw-memory/search | L712-715 |
| GET | /api/claw-memory/read | L717-722 |
| POST | /api/claw-memory/save | L724-729 |
| GET | /api/claw-memory/list | L731-734 |
| POST | /api/claw-memory/init | L736-739 |

### `src/routes/integrations.js` (~100줄)

| Method | Route | 출처 행 |
|---|---|---|
| POST | /api/telegram/send | L505-551 |
| GET | /api/mcp | L554 |
| PUT | /api/mcp | L555-560 |
| POST | /api/mcp/sync | L561-565 |
| POST | /api/mcp/install | L566-578 |
| POST | /api/mcp/reset | L579-595 |
| GET | /api/cli-registry | L598 |
| GET | /api/cli-status | L599 |
| GET | /api/quota | L600-608 |

### `src/routes/employees.js` (~90줄)

| Method | Route | 출처 행 |
|---|---|---|
| GET | /api/employees | L611 |
| POST | /api/employees | L612-620 |
| PUT | /api/employees/:id | L621-632 |
| DELETE | /api/employees/:id | L633-638 |
| POST | /api/employees/reset | L641-644 |
| GET | /api/heartbeat | L647 |
| PUT | /api/heartbeat | L648-654 |
| GET | /api/skills | L658 |
| POST | /api/skills/enable | L660-676 |
| POST | /api/skills/disable | L678-686 |
| GET | /api/skills/:id | L688-696 |
| POST | /api/skills/reset | L699-708 |

### `src/routes/browser.js` (~85줄)

| Method | Route | 출처 행 |
|---|---|---|
| POST | /api/browser/start | L745-750 |
| POST | /api/browser/stop | L752-755 |
| GET | /api/browser/status | L757-760 |
| GET | /api/browser/snapshot | L762-770 |
| POST | /api/browser/screenshot | L772-775 |
| POST | /api/browser/act | L777-791 |
| POST | /api/browser/vision-click | L794-803 |
| POST | /api/browser/navigate | L805-808 |
| GET | /api/browser/tabs | L810-813 |
| POST | /api/browser/evaluate | L815-818 |
| GET | /api/browser/text | L820-823 |

---

## 충돌 분석

| 대상 | 변경 | 충돌 위험 |
|---|---|---|
| `server.js` | MAJOR MODIFY (라우트 제거 → import 교체) | **높음** — 동시 수정 주의 |
| `src/routes/*.js` | **NEW** (6개) | 없음 |
| Phase 8.1 (guard) | guard가 적용된 라우트를 `memory.js/employees.js`로 이동 | **순서 의존** — 8.1 먼저 |
| Phase 8.2 (응답) | `ok()/fail()` 사용 라우트가 이동됨 | **순서 의존** — 8.2 먼저 |
| Phase 8.4 (catch) | catch 정리 대상이 라우트 함수 안에 있음 | 8.4와 동시 진행 가능 (같은 코드 영역) |

**권장 실행 순서: 8.1 → 8.2 → 8.3 (동시에 8.4)**

---

## 테스트 계획

### 스모크 테스트: `tests/integration/routes-smoke.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';

// 각 registrar가 올바르게 라우트를 등록하는지 검증
test('RS-001: core routes registration', async () => {
  const app = express();
  const routes = [];
  const proxy = new Proxy(app, {
    get(target, prop) {
      if (['get','post','put','delete','patch'].includes(prop)) {
        return (path, ...args) => { routes.push({ method: prop, path }); };
      }
      return target[prop];
    }
  });

  const { registerCoreRoutes } = await import('../../src/routes/core.js');
  registerCoreRoutes(proxy, {}); // deps는 빈 객체 (등록만 확인)

  const expected = ['/api/session', '/api/messages', '/api/runtime',
                    '/api/command', '/api/commands', '/api/message',
                    '/api/orchestrate/continue', '/api/stop', '/api/clear'];
  for (const path of expected) {
    assert.ok(routes.some(r => r.path === path), `missing route: ${path}`);
  }
});

test('RS-002: route count matches baseline', async () => {
  // 분리 전 baseline과 분리 후 추출값의 개수/집합이 동일해야 함
});
```

### 라우트 누락 검증 스크립트: `scripts/verify-routes.mjs`

```js
#!/usr/bin/env node
// 분리 직전 baseline과 분리 후 라우트 비교 (고정 숫자 의존 금지)
import { execSync } from 'child_process';

const before = execSync(
  "rg -oN \"app\\.(get|post|put|patch|delete)\\('/api[^']+\" server.js",
  { encoding: 'utf8' }
).trim().split('\n').sort();

console.log(`[verify] baseline routes: ${before.length}`);
// TODO: 분리 후 각 routes/*.js에서 동일 패턴 추출하여 비교
```

### 실행

```bash
node --test tests/integration/routes-smoke.test.js
node scripts/verify-routes.mjs
```

---

## 완료 기준

- [ ] `server.js` 200줄 이하
- [ ] 6개 라우트 파일 생성 (각 100줄 이하)
- [ ] baseline 대비 라우트 누락/추가 0건 (시그니처 diff 0건)
- [ ] 기존 `npm test` 통과
- [ ] git diff에서 라우트 경로/메서드 변경 0건 (시그니처 불변)
