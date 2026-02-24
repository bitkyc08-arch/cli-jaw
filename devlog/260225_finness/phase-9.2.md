# Phase 9.2: 응답/에러 공통 모듈 구현 + 라우트 적용 (WS2 실행)

> Phase 8.2 설계를 실제 코드로 전환한다.

---

## 왜 해야 하는가

현재 4가지 응답 패턴 혼재로 인해:

```js
// 프런트에서 매번 이런 분기가 필요함
const data = await res.json();
if (Array.isArray(data)) { /* employees, messages */ }
else if (data.ok !== undefined) { /* command result */ }
else if (data.error) { /* error case */ }
else { /* session, settings — bare object */ }
```

`{ ok, data }` 통일 후:

```js
const { ok, data, error } = await res.json();
if (!ok) return showError(error);
// data를 바로 사용
```

---

## 구현 순서

### Step 1: HTTP 공통 모듈 생성

```bash
mkdir -p src/http
```

```js
// src/http/response.js
export function ok(res, data, extra = {}) {
  return res.json({ ok: true, data, ...extra });
}
export function fail(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}
```

```js
// src/http/async-handler.js
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
```

```js
// src/http/error-middleware.js
import { fail } from './response.js';

export function notFoundHandler(req, res) {
  return fail(res, 404, 'route_not_found', { method: req.method, path: req.path });
}

export function errorHandler(err, req, res, _next) {
  const status = err?.statusCode || 500;
  const msg = status >= 500 ? 'internal_error' : (err?.message || 'bad_request');
  if (status >= 500) console.error('[http:error]', err);
  else console.warn('[http:warn]', msg, { path: req.path });
  if (res.headersSent) return;
  return fail(res, status, msg);
}
```

### Step 2: 고위험 라우트에 1단계 적용 (dual-response)

Phase 8.2의 17개 "상" 우선순위 라우트부터 적용:

```diff
+import { ok, fail } from './src/http/response.js';
+import { asyncHandler } from './src/http/async-handler.js';

 // memory-files (이미 9.1에서 guard 적용된 상태)
 app.get('/api/memory-files/:filename', asyncHandler((req, res) => {
     const base = getMemoryDir();
     const filename = assertFilename(req.params.filename, { allowExt: ['.md'] });
     const fp = safeResolveUnder(base, filename);
     if (!fs.existsSync(fp)) return fail(res, 404, 'not_found');
     const payload = { name: filename, content: fs.readFileSync(fp, 'utf8') };
+    res.json({ ok: true, data: payload, ...payload }); // 1단계: 기존 필드 유지
 }));

 // skills enable
 app.post('/api/skills/enable', asyncHandler((req, res) => {
     const id = assertSkillId(req.body?.id);
     // ...
     const payload = { id, enabled: true };
+    res.json({ ok: true, data: payload, ...payload }); // 1단계: 기존 필드 유지
 }));

 // upload
 app.post('/api/upload', express.raw({ type: '*/*', limit: '20mb' }), asyncHandler((req, res) => {
     const decoded = decodeFilenameSafe(req.headers['x-filename']);
     const filename = assertFilename(decoded, { allowExt: [/* ... */] });
     const filePath = saveUpload(req.body, filename);
     const payload = { path: filePath, filename: basename(filePath) };
+    res.json({ ok: true, data: payload, ...payload }); // 1단계: 기존 필드 유지
 }));
```

### Step 3: 글로벌 에러 미들웨어 등록

```diff
 // server.js 하단 (server.listen 직전)
+import { notFoundHandler, errorHandler } from './src/http/error-middleware.js';
+app.use(notFoundHandler);
+app.use(errorHandler);

 server.listen(PORT, () => { ... });
```

### Step 4: 나머지 라우트 점진 전환 (2단계)

| 우선순위 | 라우트 그룹 | 전환 방식 |
|---|---|---|
| 상 | memory-files, skills, upload, claw-memory | 1단계 `dual-response` (기존 필드 + `ok/data`) |
| 중 | session, messages, settings, employees, mcp | 1단계 `dual-response` 후 2단계 `ok()/fail()` |
| 낮음 | browser, heartbeat, cli-registry, quota | 프런트 전환 후 2단계 `ok()/fail()` |

---

## 충돌 분석

| 대상 | 변경 | 충돌 |
|---|---|---|
| `src/http/*` | **NEW** (3개) | 없음 |
| `server.js` 전체 라우트 | 점진 수정 | **중간** — 9.1(guard) 수정과 같은 라우트 |
| 프런트 `public/js/**` | 간접 영향 | **1단계에서 안전** — 기존 필드 유지 |
| Phase 9.1 | guard가 적용된 상태에서 `ok()/fail()` 교체 | **순서: 9.1 → 9.2** |
| Phase 9.3 | 라우트 분리 시 `ok()/fail()` import가 route 파일로 이동 | 9.2 코드가 9.3에서 재사용됨 |

---

## 테스트 계획

### 파일: `tests/unit/http-response.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail } from '../../src/http/response.js';

function mockRes() {
  let sent = null, status = 200;
  return {
    status(s) { status = s; return this; },
    json(d) { sent = d; },
    get sent() { return sent; },
    get statusCode() { return status; },
  };
}

test('HR-001: ok wraps data', () => {
  const r = mockRes(); ok(r, { id: 1 });
  assert.deepEqual(r.sent, { ok: true, data: { id: 1 } });
});

test('HR-002: ok with extra', () => {
  const r = mockRes(); ok(r, [1,2], { total: 2 });
  assert.deepEqual(r.sent, { ok: true, data: [1,2], total: 2 });
});

test('HR-003: fail sets status', () => {
  const r = mockRes(); fail(r, 400, 'bad');
  assert.equal(r.statusCode, 400);
  assert.deepEqual(r.sent, { ok: false, error: 'bad' });
});
```

### 파일: `tests/unit/async-handler.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { asyncHandler } from '../../src/http/async-handler.js';

test('AH-001: passes sync through', async () => {
  let called = false;
  await asyncHandler((req, res) => { called = true; })({}, {}, () => {});
  assert.ok(called);
});

test('AH-002: catches async error', async () => {
  let caught = null;
  await asyncHandler(async () => { throw new Error('boom'); })({}, {}, (e) => { caught = e; });
  assert.equal(caught.message, 'boom');
});

test('AH-003: passes statusCode errors', async () => {
  let caught = null;
  await asyncHandler(async () => {
    const e = new Error('nope'); e.statusCode = 403; throw e;
  })({}, {}, (e) => { caught = e; });
  assert.equal(caught.statusCode, 403);
});
```

### 실행

```bash
node --test tests/unit/http-response.test.js tests/unit/async-handler.test.js
npm test
```

---

## 완료 기준

- [ ] `src/http/response.js` + `async-handler.js` + `error-middleware.js` 생성
- [ ] 고위험 라우트 17곳에 1단계 `dual-response` 적용
- [ ] `errorHandler` 미들웨어 등록
- [ ] 단위 테스트 6/6 통과
- [ ] `npm test` 통과
- [ ] 프런트 기존 기능 동작 확인 (기존 필드 하위호환)
