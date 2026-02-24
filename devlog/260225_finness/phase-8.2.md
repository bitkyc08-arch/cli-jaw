# Phase 8.2: API 응답/에러 계약 통일 설계

> 이 문서는 Phase 8의 P1(API 계약 일관화) 설계를 다룬다.

---

## 왜 해야 하는가

### 현재 상태: 4가지 응답 패턴이 혼재

```js
// 패턴 A: bare 데이터 (응답 형식 미정)
app.get('/api/session', (_, res) => res.json(getSession()));        // { sessionId, ... }
app.get('/api/employees', (_, res) => res.json(getEmployees.all())); // [{...}, ...]

// 패턴 B: { ok: true, ... } (반구조화)
app.post('/api/clear', (_, res) => res.json({ ok: true }));

// 패턴 C: { ok, data } + { error } 혼합
app.post('/api/command', async (req, res) => {
    // 성공: res.json(result)  ← result 모양이 일관되지 않음
    // 실패: res.status(400).json({ ok: false, code: 'not_command', text: '...' })
    // 서버에러: res.status(500).json({ ok: false, code: 'internal_error', text: '...' })
});

// 패턴 D: { error: '...' } (에러만)
app.post('/api/message', (req, res) => {
    if (!prompt?.trim()) return res.status(400).json({ error: 'prompt required' });
});
```

### 문제점

1. **클라이언트 분기 복잡도**: `fetch` 후 `data.ok`, `data.error`, `Array.isArray(data)`, bare object 모두 개별 처리
2. **Telegram/Web/CLI 에러 표시 중복**: 에러 포맷이 다르면 각 인터페이스가 별도 파싱 로직 필요
3. **테스트 assertion 불일치**: 라우트마다 응답 형태가 달라 assertion 작성이 번거로움

---

## 설계: 공통 응답/에러 모듈

### `src/http/response.js`

```js
/**
 * 표준 성공 응답
 * @param {Response} res
 * @param {any} data
 * @param {object} extra - 추가 필드 (하위호환용)
 */
export function ok(res, data, extra = {}) {
  return res.json({ ok: true, data, ...extra });
}

/**
 * 표준 실패 응답
 * @param {Response} res
 * @param {number} status - HTTP status code
 * @param {string} error - 에러 코드/메시지
 * @param {object} extra - 추가 정보
 */
export function fail(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}
```

### `src/http/async-handler.js`

```js
/**
 * async 라우트 핸들러를 try/catch 없이 사용 가능하게 래핑
 * throw된 에러는 Express error middleware로 전달됨
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
```

### `src/http/error-middleware.js`

```js
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
  return fail(res, status, msg, err?.code ? { code: err.code } : {});
}
```

---

## 적용 전략: 3단계 하위호환 전환

### 1단계: dual-response (기존 필드 유지 + ok/data 추가)

```js
// BEFORE
app.get('/api/session', (_, res) => res.json(getSession()));

// AFTER (1단계 — 하위호환)
app.get('/api/session', (_, res) => {
    const data = getSession();
    res.json({ ok: true, data, ...data }); // 기존 bare 필드도 유지
});
```

### 2단계: 프런트 전환 후 bare 필드 제거

```js
// AFTER (2단계 — 정리 완료)
app.get('/api/session', (_, res) => ok(res, getSession()));
```

### 3단계: 404/500 글로벌 미들웨어 등록

```js
// server.js 하단에 추가
app.use(notFoundHandler);
app.use(errorHandler);
```

---

## 충돌 분석

| 대상 | 변경 | 충돌 위험 |
|---|---|---|
| `src/http/response.js` | **NEW** | 없음 |
| `src/http/async-handler.js` | **NEW** | 없음 |
| `src/http/error-middleware.js` | **NEW** | 없음 |
| `server.js` 전체 라우트 | MODIFY (점진적) | **중간** — 프런트 `fetch` 코드가 응답 형태에 의존 |
| `public/js/features/*.js` | 간접 영향 | 1단계에서 하위호환 유지하면 안전 |

**Phase 8.1과 충돌:** 없음 — 8.1은 guard 유틸 추가, 8.2는 응답 유틸 추가. 서로 독립.
**Phase 8.3과 충돌:** 8.2를 먼저 적용 → 8.3에서 분리된 라우트가 `ok()/fail()` 사용.
**프런트엔드와 충돌:** 1단계(dual-response) 동안에는 충돌 없음.

---

## 테스트 계획

### 파일: `tests/unit/http-response.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail } from '../../src/http/response.js';

function mockRes() {
  let sent = null;
  let statusCode = 200;
  return {
    status(s) { statusCode = s; return this; },
    json(data) { sent = data; return this; },
    get sent() { return sent; },
    get statusCode() { return statusCode; },
  };
}

test('HR-001: ok() wraps data', () => {
  const res = mockRes();
  ok(res, { id: 1 });
  assert.deepEqual(res.sent, { ok: true, data: { id: 1 } });
});

test('HR-002: ok() with extra fields', () => {
  const res = mockRes();
  ok(res, [1, 2], { total: 2 });
  assert.deepEqual(res.sent, { ok: true, data: [1, 2], total: 2 });
});

test('HR-003: fail() sets status and wraps error', () => {
  const res = mockRes();
  fail(res, 400, 'invalid_input');
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.sent, { ok: false, error: 'invalid_input' });
});

test('HR-004: fail() with extra', () => {
  const res = mockRes();
  fail(res, 422, 'validation', { fields: ['name'] });
  assert.deepEqual(res.sent, { ok: false, error: 'validation', fields: ['name'] });
});
```

### 파일: `tests/unit/async-handler.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { asyncHandler } from '../../src/http/async-handler.js';

test('AH-001: passes sync result through', async () => {
  let called = false;
  const handler = asyncHandler((req, res) => { called = true; });
  await handler({}, {}, () => {});
  assert.ok(called);
});

test('AH-002: catches async error and calls next', async () => {
  let caught = null;
  const handler = asyncHandler(async () => { throw new Error('boom'); });
  await handler({}, {}, (err) => { caught = err; });
  assert.equal(caught.message, 'boom');
});
```

### 실행

```bash
node --test tests/unit/http-response.test.js tests/unit/async-handler.test.js
```

---

## 완료 기준

- [ ] `ok()`, `fail()` 단위 테스트 4/4 통과
- [ ] `asyncHandler` 단위 테스트 2/2 통과
- [ ] 고위험 라우트 10곳 이상에 1단계(dual-response) 적용
- [ ] `errorHandler` 미들웨어 등록
- [ ] 기존 `npm test` 통과 (회귀 없음)
