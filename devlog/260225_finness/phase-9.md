---
created: 2026-02-25
status: in-progress
tags: [cli-claw, finness, phase-9, backend, hardening, dependency, testing]
---
# Phase 9: 백엔드 하드닝 실행 설계서 (프런트 제외)

> 목표: Phase 8의 감사 결과를 실제 구현으로 전환한다.
> 범위: 백엔드 보안 입력 검증, API 계약 통일, 예외 처리 일관화, 테스트 확장, 의존성/정적분석 게이트
> 제외: 프런트 UI/스타일/컴포넌트 변경
>
> **서브 문서:**
> - [phase-9.1.md](./phase-9.1.md) — 보안 입력 검증 (WS1)
> - [phase-9.2.md](./phase-9.2.md) — API 응답/에러 계약 (WS2)
> - [phase-9.3.md](./phase-9.3.md) — server.js 라우트 분리 (WS3)
> - [phase-9.4.md](./phase-9.4.md) — 테스트 확장 (WS4)
> - [phase-9.5.md](./phase-9.5.md) — 커맨드 통합 (WS5)
> - [phase-9.6.md](./phase-9.6.md) — catch 정책 (WS7, Phase 8.4 기반)
> - [phase-9.7.md](./phase-9.7.md) — 의존성 검증 게이트 (WS8, Phase 8.5 기반)

---

## 0) Phase 9 한 줄 정의

`"지금 당장 깨질 수 있는 리스크를 먼저 닫고, 이후 변경이 안전해지는 개발 체계를 고정한다."`

---

## 1) 왜 지금 해야 하는가 (우선순위 근거)

1. 공격면이 이미 존재
- `memory-files`, `skills`, `upload`, `claw-memory` 입력 경계가 약함.

2. 구조가 커져서 작은 수정도 위험
- `server.js`가 대형 단일 파일로 유지되어 결합도가 높음.

3. 회귀가 다시 반복될 가능성
- 핵심 경로 테스트가 부족해 재발 방지가 약함.

4. 의존성 검증 체인이 환경 의존적
- 온라인 전용 체크(`npm audit/outdated`)는 DNS 불가 환경에서 무력화됨.

결론:
- Phase 9는 기능 추가가 아니라 “실패 비용을 낮추는 인프라 작업”이다.

---

## 2) 성공 기준 (명확한 종료 조건)

### 2.1 필수

- [ ] path/id/filename 관련 보안 케이스가 4xx로 차단됨
- [ ] 신규 공통 validator/response 유틸이 고위험 라우트에 적용됨
- [ ] `npm test` 통과
- [ ] 신규 테스트(보안 + 인자 + 파서) 최소 4개 파일 추가
- [ ] 오프라인 deps check가 CI/로컬에서 항상 실행 가능

### 2.2 권장

- [ ] 온라인 audit/outdated 결과 아티팩트 저장
- [ ] semgrep baseline + triage 문서화
- [ ] catch 분류표 기반 로깅 정책 적용

---

## 3) 설계 원칙

1. 보안 먼저, 리팩터링 나중
- 먼저 입력 경계를 닫고, 그 다음 파일 분리/정리를 한다.

2. 하위호환을 유지하며 계약 전환
- 응답 포맷은 단계적으로 바꾼다.

3. 테스트 선행 (TDD)
- 취약/회귀 케이스를 먼저 실패시키고 수정한다.

4. 오프라인-온라인 이중 검증
- 네트워크 없는 환경에서도 최소 안전선을 유지한다.

---

## 4) 워크스트림 개요

| 스트림 | 이름 | 목적 | 예상 |
|---|---|---|---|
| WS1 | 입력 검증/경로 가드 | 공격면 차단 | 0.5~1일 |
| WS2 | 응답/에러 계약 통일 | 일관성 + 디버깅성 향상 | 0.5~1일 |
| WS3 | 구조 분리 | 변경 범위 축소 | 1~1.5일 |
| WS4 | 테스트/커버리지 | 회귀 차단 | 1~1.5일 |
| WS5 | 의존성/정적분석 게이트 | 배포 전 안전선 고정 | 0.5~1일 |

---

## 5) WS1 — 입력 검증/경로 가드 (P0)

### 5.1 대상 라우트

- `GET /api/memory-files/:filename`
- `DELETE /api/memory-files/:filename`
- `POST /api/skills/enable`
- `POST /api/skills/disable`
- `GET /api/skills/:id`
- `POST /api/upload`
- `GET /api/claw-memory/read`
- `POST /api/claw-memory/save`

### 5.2 신규 파일 설계

#### `src/security/path-guards.js`

책임:
- base 디렉토리 하위 경로 강제
- 파일명 whitelist 검증
- 식별자(id) whitelist 검증

```js
import path from 'node:path';

const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FILE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function assertSkillId(id) {
  const v = String(id || '').trim();
  if (!SKILL_ID_RE.test(v)) throw badRequest('invalid_skill_id');
  if (v.includes('..') || v.includes('/') || v.includes('\\')) throw badRequest('invalid_skill_id');
  return v;
}

export function assertFilename(filename, { allowExt = ['.md'] } = {}) {
  const v = String(filename || '').trim();
  if (!FILE_NAME_RE.test(v)) throw badRequest('invalid_filename');
  const ext = path.extname(v).toLowerCase();
  if (allowExt.length && !allowExt.includes(ext)) throw badRequest('invalid_extension');
  return v;
}

export function safeResolveUnder(baseDir, unsafeName) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, unsafeName);
  const pref = base.endsWith(path.sep) ? base : base + path.sep;
  if (!resolved.startsWith(pref)) throw forbidden('path_escape');
  return resolved;
}

function badRequest(code) {
  const e = new Error(code);
  e.statusCode = 400;
  return e;
}

function forbidden(code) {
  const e = new Error(code);
  e.statusCode = 403;
  return e;
}
```

#### `src/security/decode.js`

```js
export function decodeFilenameSafe(rawHeader) {
  const raw = String(rawHeader || 'upload.bin');
  if (raw.length > 180) {
    const e = new Error('filename_too_long');
    e.statusCode = 400;
    throw e;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    const e = new Error('invalid_percent_encoding');
    e.statusCode = 400;
    throw e;
  }
}
```

### 5.3 라우트 적용 예시

```js
// memory-files/:filename
app.get('/api/memory-files/:filename', asyncHandler((req, res) => {
  const base = getMemoryDir();
  const filename = assertFilename(req.params.filename, { allowExt: ['.md'] });
  const fp = safeResolveUnder(base, filename);
  if (!fs.existsSync(fp)) return fail(res, 404, 'not_found');
  return ok(res, { name: filename, content: fs.readFileSync(fp, 'utf8') });
}));
```

```js
// skills/enable
app.post('/api/skills/enable', asyncHandler((req, res) => {
  const id = assertSkillId(req.body?.id);
  // 기존 로직 유지 + 안전 id 사용
  // ...
  return ok(res, { id, enabled: true });
}));
```

```js
// upload
app.post('/api/upload', express.raw({ type: '*/*', limit: '20mb' }), asyncHandler((req, res) => {
  const decoded = decodeFilenameSafe(req.headers['x-filename']);
  const filename = assertFilename(decoded, { allowExt: ['.png', '.jpg', '.jpeg', '.webp', '.pdf', '.txt', '.md', '.bin'] });
  const filePath = saveUpload(req.body, filename);
  return ok(res, { path: filePath, filename: basename(filePath) });
}));
```

### 5.4 WS1 테스트 요구사항

- traversal 문자열(`../x.md`, `..%2fx.md`, `/etc/passwd`, `C:\\...`) 차단
- 빈 문자열/공백/초장문 파일명 차단
- 정상 파일명은 통과

---

## 6) WS2 — 응답/에러 계약 통일 (P1)

### 6.1 신규 파일

#### `src/http/response.js`

```js
export function ok(res, data, extra = {}) {
  return res.json({ ok: true, data, ...extra });
}

export function fail(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}
```

#### `src/http/errors.js`

```js
export class HttpError extends Error {
  constructor(statusCode, message, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
```

#### `src/http/async-handler.js`

```js
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
```

#### `src/http/error-middleware.js`

```js
import { fail } from './response.js';

export function notFoundHandler(req, res) {
  return fail(res, 404, 'route_not_found', { method: req.method, path: req.path });
}

export function errorHandler(err, req, res, _next) {
  const status = err?.statusCode || 500;
  const msg = status >= 500 ? 'internal_error' : (err?.message || 'bad_request');
  if (status >= 500) console.error('[http:error]', err);
  else console.warn('[http:warn]', msg, { path: req.path, method: req.method });
  return fail(res, status, msg, err?.code ? { code: err.code } : {});
}
```

### 6.2 적용 방식 (점진적)

1단계:
- high-risk 라우트만 우선 전환 (`memory-files`, `skills`, `upload`, `claw-memory`)

2단계:
- 모든 `GET /api/*` 라우트를 `{ ok, data }`로 통일

3단계:
- 프런트/텔레그램 소비부가 새 계약으로 완전히 이행되면 bare 응답 제거

### 6.3 왜 필요한가

- 장애 대응 시 상태코드 + error code로 원인 파악 가능
- 여러 인터페이스(web/telegram/cli)에서 에러 표준화 가능
- 테스트 assertion 작성이 간단해짐

---

## 7) WS3 — 구조 분리 (P1~P2)

### 7.1 목표 구조

```text
src/
  routes/
    core.js
    settings.js
    memory.js
    integrations.js
    employees.js
    browser.js
  http/
    response.js
    errors.js
    async-handler.js
    error-middleware.js
  security/
    path-guards.js
    decode.js
server.js
```

### 7.2 route registrar 패턴

```js
// src/routes/core.js
export function registerCoreRoutes(app, deps) {
  const { getSession, getMessages, parseCommand, executeCommand, makeWebCommandCtx } = deps;

  app.get('/api/session', (_req, res) => ok(res, getSession()));
  app.get('/api/messages', (req, res) => {
    const includeTrace = ['1', 'true', 'yes'].includes(String(req.query.includeTrace || '').toLowerCase());
    const rows = includeTrace ? deps.getMessagesWithTrace.all() : getMessages.all();
    return ok(res, rows);
  });

  app.post('/api/command', asyncHandler(async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 500);
    const parsed = parseCommand(text);
    if (!parsed) return fail(res, 400, 'not_command');
    const result = await executeCommand(parsed, makeWebCommandCtx());
    return ok(res, result);
  }));
}
```

### 7.3 분리 순서

1. 공통 유틸 추가
2. route registrar 파일 추가
3. `server.js`에서 순차적으로 이동
4. 기존 경로/메서드 변경 금지
5. 스모크 테스트 반복

### 7.4 주의

- 기능 변경과 분리를 한 PR에서 동시에 크게 하지 말 것
- 라우트 그룹 단위로 커밋을 쪼갤 것

---

## 8) WS4 — 테스트/커버리지 (P2)

### 8.1 신규 테스트 파일

- `tests/unit/path-guards.test.js`
- `tests/unit/decode.test.js`
- `tests/unit/http-response.test.js`
- `tests/unit/async-handler.test.js`
- `tests/unit/orchestrator-parsing.test.js`
- `tests/unit/orchestrator-triage.test.js`
- `tests/unit/agent-args.test.js`
- `tests/unit/settings-merge.test.js`
- (선택) `tests/api/security-routes.test.js`

### 8.2 테스트 케이스 설계

#### path-guards

| ID | 입력 | 기대 |
|---|---|---|
| PG-001 | `notes.md` | 통과 |
| PG-002 | `../notes.md` | 403 |
| PG-003 | `..%2fnotes.md` | 400 또는 403 |
| PG-004 | `/etc/passwd` | 403 |
| PG-005 | `a/b.md` | 400 |
| PG-006 | `note.txt` (allow `.md`) | 400 |

#### skills id

| ID | 입력 | 기대 |
|---|---|---|
| SI-001 | `dev` | 통과 |
| SI-002 | `dev-backend` | 통과 |
| SI-003 | `../x` | 400 |
| SI-004 | `x/y` | 400 |
| SI-005 | ``(빈값) | 400 |

#### upload filename

| ID | 입력 | 기대 |
|---|---|---|
| UP-001 | `image.png` | 통과 |
| UP-002 | `%E0%A4%A` | 400 |
| UP-003 | `a`.repeat(300)+`.png` | 400 |
| UP-004 | `../../evil.md` | 400 |

#### orchestrator/agent 회귀

| ID | 대상 | 기대 |
|---|---|---|
| OR-001 | `stripSubtaskJSON` fenced json | subtasks 파싱 성공 |
| OR-002 | malformed json | fallback 동작 |
| AG-001 | codex buildArgs(auto perm) | 승인 플래그 포함 |
| AG-002 | gemini resume args | resume 인자 유지 |

### 8.3 샘플 테스트 코드

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSkillId } from '../../src/security/path-guards.js';

test('assertSkillId accepts valid', () => {
  assert.equal(assertSkillId('dev-backend'), 'dev-backend');
});

test('assertSkillId rejects traversal', () => {
  assert.throws(() => assertSkillId('../dev'));
  assert.throws(() => assertSkillId('dev/../x'));
});
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeResolveUnder } from '../../src/security/path-guards.js';
import path from 'node:path';

const base = '/tmp/memory';

test('safeResolveUnder keeps path under base', () => {
  const p = safeResolveUnder(base, 'daily.md');
  assert.equal(p, path.resolve(base, 'daily.md'));
});

test('safeResolveUnder blocks traversal', () => {
  assert.throws(() => safeResolveUnder(base, '../etc/passwd'));
});
```

### 8.4 커버리지 게이트

```bash
node --test \
  --experimental-test-coverage \
  --test-coverage-lines=80 \
  --test-coverage-functions=80 \
  --test-coverage-branches=70 \
  tests/*.test.js tests/**/*.test.js
```

---

## 9) WS5 — 의존성/정적분석 게이트 (P2)

### 9.1 오프라인 체크 (필수)

- `node scripts/check-deps-offline.mjs`
- 목적: 네트워크가 없어도 금지 버전 차단

### 9.2 온라인 체크 (권장)

- `npm audit --json > .artifacts/npm-audit.json`
- `npm outdated --json > .artifacts/npm-outdated.json`
- `semgrep ci --json --json-output .artifacts/semgrep.json`
- `semgrep ci --sarif --sarif-output .artifacts/semgrep.sarif`

### 9.3 baseline 스캔

```bash
# 예: main 브랜치를 baseline으로 사용
semgrep --baseline-commit origin/main --json --json-output .artifacts/semgrep-baseline.json
```

### 9.4 triage 문서 템플릿

`devlog/260225_finness/static-analysis-baseline.md` 예시:

```md
# Static Analysis Baseline

## Scan Meta
- Date:
- Commit:
- Tool versions:

## Findings Summary
- total:
- by severity:

## Actionable Findings
1. [rule-id] file:line - reason - owner - due

## False Positives
1. [rule-id] rationale

## Deferred
1. [rule-id] risk acceptance until <date>
```

---

## 10) 파일별 변경 계획 (구체)

### 10.1 수정 파일

- `server.js`
- `src/agent.js` (테스트 가능 API export 보조)
- `src/orchestrator.js` (파싱 단위 테스트 노출)

### 10.2 신규 파일

- `src/security/path-guards.js`
- `src/security/decode.js`
- `src/http/response.js`
- `src/http/errors.js`
- `src/http/async-handler.js`
- `src/http/error-middleware.js`
- `src/routes/core.js`
- `src/routes/settings.js`
- `src/routes/memory.js`
- `src/routes/integrations.js`
- `src/routes/employees.js`
- `scripts/check-deps-offline.mjs`
- `scripts/check-deps-online.sh`
- `tests/unit/path-guards.test.js`
- `tests/unit/decode.test.js`
- `tests/unit/http-response.test.js`
- `tests/unit/async-handler.test.js`
- `tests/unit/orchestrator-parsing.test.js`
- `tests/unit/orchestrator-triage.test.js`
- `tests/unit/agent-args.test.js`
- `tests/unit/settings-merge.test.js`
- `tests/unit/deps-check.test.js`
- `devlog/260225_finness/phase-9.6.md`
- `devlog/260225_finness/phase-9.7.md`
- `devlog/260225_finness/static-analysis-baseline.md`

### 10.3 영향 파일 (간접)

- `package.json` (script 추가)
- `README.md` 또는 운영 문서 (검증 명령 추가)

---

## 11) 단계별 구현 순서 (실행 플랜)

### Day 1 (보안 경계)

1. `path-guards`, `decode` 유틸 추가
2. 고위험 라우트 적용
3. path/id/upload 테스트 추가
4. 테스트 통과 확인

산출:
- 공격면 차단 커밋

### Day 2 (계약/에러 공통화)

1. `ok/fail`, `asyncHandler`, `errorHandler` 추가
2. 고위험 라우트부터 공통화
3. catch 정책 적용
4. 테스트/스모크 실행

산출:
- 응답/에러 계약 커밋

### Day 3 (구조 분리)

1. route registrar 도입
2. `server.js` 라우트 이동
3. import 정리
4. 라우트 기능 회귀 테스트

산출:
- 구조 분리 커밋

### Day 4 (검증 파이프라인)

1. deps offline/online 스크립트 추가
2. semgrep baseline 실행(가능 환경)
3. 커버리지 임계치 설정
4. static-analysis-baseline 문서 작성

산출:
- 검증 게이트 커밋

---

## 12) 롤백 전략

1. 라우트 분리 PR은 기능별로 분할
- 문제 시 특정 라우트 그룹만 되돌릴 수 있게 유지

2. 응답 계약 전환은 dual-mode로
- 일정 기간 `{ ok, data }`와 기존 필드 병행

3. 의존성 업그레이드는 lockfile 단독 커밋
- 문제 시 lockfile만 빠르게 롤백

4. 보안 가드 오탐 시 allowlist 조정
- guard 자체를 제거하지 않고 규칙만 조정

---

## 13) 리스크 레지스터

| ID | 리스크 | 확률 | 영향 | 대응 |
|---|---|---|---|---|
| R1 | validator 오탐으로 정상 요청 차단 | 중 | 중 | 테스트 케이스 확대 + allowlist 튜닝 |
| R2 | route 분리 시 import 누락 | 중 | 중 | route registration smoke test |
| R3 | 응답 계약 변경으로 소비부 파손 | 중 | 중 | dual-mode + 단계 전환 |
| R4 | deps 체크가 네트워크 탓에 실패 | 높음 | 중 | offline/online 분리 |
| R5 | semgrep 도입 초기 false positive 과다 | 중 | 낮음 | baseline + triage 문서화 |
| R6 | better-sqlite3 업글 시 native 빌드 이슈 | 중 | 중 | 별도 브랜치 검증 |

---

## 14) 수용 테스트 시나리오 (E2E 관점)

### 14.1 보안

- [ ] `GET /api/memory-files/../x.md` → 403
- [ ] `POST /api/skills/enable { id: "../x" }` → 400
- [ ] `POST /api/upload` with malformed filename header → 400
- [ ] `GET /api/claw-memory/read?file=../../x` → 400/403

### 14.2 정상 기능

- [ ] 정상 skill enable/disable/read 동작
- [ ] 정상 memory file read/delete 동작
- [ ] upload 동작 및 파일 저장
- [ ] command/message/session 라우트 기존 동작 유지

### 14.3 회귀

- [ ] `npm test` 통과
- [ ] `test:events`, `test:telegram` 통과
- [ ] 새 unit tests 통과

---

## 15) 의존성 업그레이드 전략 (선택적)

### 15.1 immediate

- 지금 즉시 필요한 것은 "보안 범위 이탈 버전 차단"이다.
- major 업그레이드는 별도 트랙으로 분리한다.

### 15.2 track A (안정)

- `express`, `ws`, `playwright-core`는 최신 릴리스 확인 후 소폭 유지보수

### 15.3 track B (검증 필요)

- `better-sqlite3` 11.x → 12.x는 네이티브 모듈 회귀 가능성이 있으므로 별도 테스트 플랜 필요

테스트 체크리스트:
- DB open/close
- insert/select/update/delete
- WAL/SHM 동작
- 마이그레이션 루틴

---

## 16) 실제 명령 시퀀스 (운영용)

```bash
# 0. 기준 스냅샷
node -v
npm -v
npm ls --depth=0

# 1. 오프라인 검증
node scripts/check-deps-offline.mjs
npm test

# 2. 커버리지 검증
node --test --experimental-test-coverage \
  --test-coverage-lines=80 \
  --test-coverage-functions=80 \
  --test-coverage-branches=70 \
  tests/*.test.js tests/**/*.test.js

# 3. (네트워크 가능 시) 온라인 보안/버전 점검
npm audit --json > .artifacts/npm-audit.json
npm outdated --json > .artifacts/npm-outdated.json

# 4. (설치되어 있으면) semgrep
semgrep ci --json --json-output .artifacts/semgrep.json
semgrep ci --sarif --sarif-output .artifacts/semgrep.sarif
```

---

## 17) 문서/코드 동기화 규칙

- 코드 변경과 동시에 `phase-9.md` 체크리스트 상태 갱신
- 스캔 결과는 `.artifacts/*` + `static-analysis-baseline.md`로 남김
- 의사결정(예: false positive 예외 승인)은 이유와 만료일 포함

---

## 18) Context7/Web 근거 매핑표

| 주제 | 근거 | 반영 항목 |
|---|---|---|
| Express async error wrapper | Context7 Express | `asyncHandler`, `errorHandler` |
| Express body parser limit | Context7 Express + Express docs | upload/body 크기 정책 |
| `res.sendFile` path 주의 | Express 4.x API | path guard 설계 |
| Zod safeParse/coercion | Context7 Zod | request validator 구현 |
| npm audit/outdated | npm docs | online deps gate |
| Node test coverage flags | Node CLI docs | coverage threshold |
| semgrep json/sarif/baseline | Context7 Semgrep + semgrep docs | static analysis gate |
| ws advisory range | GitHub advisory | offline rule |
| node-fetch advisory range | GitHub advisory | offline rule |

---

## 19) 최종 산출물 목록

필수 산출물:
- 코드
  - 보안 guard 유틸
  - HTTP response/error 유틸
  - 라우트 분리 적용
  - 테스트 파일
  - deps check scripts
- 문서
  - `phase-9.md` 상태 갱신
  - `static-analysis-baseline.md`

권장 산출물:
- `.artifacts/npm-audit.json`
- `.artifacts/npm-outdated.json`
- `.artifacts/semgrep.json`
- `.artifacts/semgrep.sarif`

---

## 20) 완료 판정 템플릿

```md
# Phase 9 Completion

## Scope
- [ ] WS1
- [ ] WS2
- [ ] WS3
- [ ] WS4
- [ ] WS5

## Test Results
- npm test:
- coverage:
- security route tests:

## Dependency Check
- offline check:
- npm audit:
- npm outdated:
- semgrep:

## Residual Risk
1.
2.

## Decision
- [ ] ship
- [ ] hold
```

---

## 21) 근거 링크

### Context7
- Express 4.21.2 (error wrapper/body parser/response patterns)
  - https://context7.com/expressjs/express/llms.txt
- Zod (`safeParse`, coercion)
  - https://github.com/colinhacks/zod/blob/main/packages/docs-v3/README.md
  - https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx
- Semgrep (json/sarif/baseline)
  - https://github.com/semgrep/semgrep-docs/blob/main/docs/getting-started/cli.md
  - https://github.com/semgrep/semgrep-docs/blob/main/src/components/reference/_cli-help-scan-output.md
  - https://github.com/semgrep/semgrep-docs/blob/main/release-notes/february-2022.md

### Web 공식 문서/Advisory
- Express security best practices
  - https://expressjs.com/en/advanced/best-practice-security.html
- Express 4.x API `res.sendFile`
  - https://expressjs.com/en/4x/api.html#res.sendFile
- npm audit
  - https://docs.npmjs.com/cli/v10/commands/npm-audit
- npm outdated
  - https://docs.npmjs.com/cli/v10/commands/npm-outdated
- Node CLI test coverage options
  - https://nodejs.org/api/cli.html
- ws advisory
  - https://github.com/advisories/GHSA-3h5v-q93c-6h6q
- node-fetch advisory
  - https://github.com/advisories/GHSA-r683-j2x4-v87g
- express releases
  - https://github.com/expressjs/express/releases
- ws releases
  - https://github.com/websockets/ws/releases
- better-sqlite3 releases
  - https://github.com/WiseLibs/better-sqlite3/releases
- playwright releases
  - https://github.com/microsoft/playwright/releases

---

## 33) WS7 — catch 정책 + 예외 처리 일관화 (Phase 8.4 실행)

> Phase 8.4 설계 기반. 빈 `catch {}` 블록에 로깅/주석을 추가하여 운영 관측성 확보.

### 33.1 현재 상태

`catch {}` 전수 조사 결과 약 **60건** (server.js 8, agent.js 4, orchestrator.js 7, telegram.js 5, prompt.js 12, 기타).

### 33.2 3-tier 정책

| Tier | 대상 | 조치 |
|---|---|---|
| 상 (즉시) | 프로세스 kill, 봇 정지, WS parse, 브라우저 탭 | `console.warn` + 컨텍스트 |
| 중 (Phase 9 내) | JSON 파싱, fetch, 외부 서비스 | `console.debug` + preview |
| 낮 (보류) | 초기화 fallback, 파일 부재 | `/* expected: ... */` 주석 |

### 33.3 구현 범위

**상 등급 10건:**

| # | 파일 | 패턴 | 조치 |
|---|---|---|---|
| 1 | `server.js` | browser tabs → empty | warn + fallback |
| 2 | `server.js` | WS message parse | warn with preview |
| 3 | `src/agent.js` L28 | kill SIGTERM | warn with pid |
| 4 | `src/agent.js` L31 | kill SIGKILL | warn with pid |
| 5 | `src/orchestrator.js` L100 | subtask JSON #1 | debug with preview |
| 6 | `src/orchestrator.js` L104 | subtask JSON #2 | debug with preview |
| 7 | `src/orchestrator.js` L383 | phases_completed JSON | debug |
| 8 | `src/telegram.js` L190 | bot stop | warn with reason |
| 9 | `src/telegram.js` L384 | parse error | warn with msg id |
| 10 | `src/telegram.js` L415 | media error | warn with msg id |

**중 등급 8건** (선별 처리):

| # | 파일 | 조치 |
|---|---|---|
| 1 | `server.js` quota/codex | warn once / debug |
| 2 | `src/memory.js` grep | warn on proc error |
| 3 | `lib/mcp-sync.js` | warn + skip reason |
| 4 | `src/heartbeat.js` file parse | debug |
| 5 | `src/acp-client.js` JSON | debug |
| 6 | `src/config.js` loadSettings | debug + path |

### 33.4 충돌 분석

| 대상 | 충돌 |
|---|---|
| Phase 9.3 (라우트 분리) | 병행 가능 — catch 수정은 라우트 이동과 겹치지 않음 |
| Phase 9.1 (보안 가드) | 없음 |
| Phase 9.4 (테스트) | 없음 — 행동 변경 없는 리팩터링 |

### 33.5 검증

```bash
# 기존 테스트 회귀
npm test

# 주석/로깅 없는 빈 catch 잔량 확인
rg -n "catch \{" server.js src lib -g'*.js' | \
  rg -v "console\.(warn|error|debug|log|info)" | \
  rg -v "/\*" | \
  rg -v "expected|ok|fine|ignore|skip|first run"
```

목표: **상 등급 0건, 주석/로깅 없는 catch 5건 이하**.

### 33.6 완료 기준

- [ ] 상 등급 10건 모두 warn/debug 추가
- [ ] 중 등급 최소 5건 처리
- [ ] 주석 없는 빈 catch 5건 이하
- [ ] 기존 `npm test` 통과

---

## 34) WS8 — 의존성 검증 게이트 (Phase 8.5 실행)

> Phase 8.5 설계 기반. 오프라인/온라인 이중 게이트로 의존성 보안 검증 체계 구축.

### 34.1 파일 구조

```text
scripts/
  check-deps-offline.mjs    # NEW — package-lock.json 기반 오프라인 체크
  check-deps-online.sh       # NEW — npm audit + outdated + semgrep
tests/unit/
  deps-check.test.js         # NEW — semver helper 단위 테스트
.artifacts/                   # NEW dir — 온라인 체크 결과 저장
```

### 34.2 오프라인 게이트 (`check-deps-offline.mjs`)

`package-lock.json`에서 resolved 버전을 읽고 알려진 취약 범위와 비교:

| 패키지 | Advisory | 취약 범위 | 현재 버전 |
|---|---|---|---|
| `ws` | GHSA-3h5v-q93c-6h6q | `>=8.0.0 <8.17.1` | `8.19.0` ✅ |
| `node-fetch` | GHSA-r683-j2x4-v87g | `<2.6.7` or `>=3.0.0 <3.1.1` | `3.3.2` ✅ |

### 34.3 온라인 게이트 (`check-deps-online.sh`)

```bash
npm audit --json > .artifacts/npm-audit.json
npm outdated --json > .artifacts/npm-outdated.json
semgrep ci --json --json-output .artifacts/semgrep.json  # optional
```

### 34.4 package.json 스크립트

```json
{
  "check:deps": "node scripts/check-deps-offline.mjs",
  "check:deps:online": "bash scripts/check-deps-online.sh",
  "pretest": "node scripts/check-deps-offline.mjs"
}
```

### 34.5 충돌 분석

| 대상 | 충돌 |
|---|---|
| `package.json` | 낮음 — scripts 키 추가만 |
| Phase 9.1~9.6 | 완전 독립 — 스크립트 추가만 |

### 34.6 검증

```bash
# 정상: 현재 lock으로 all PASS
node scripts/check-deps-offline.mjs

# 이상: lock 조작 후 FAIL 확인
node --test tests/unit/deps-check.test.js
```

### 34.7 완료 기준

- [ ] 오프라인 스크립트 exit 0 (현재 환경)
- [ ] 취약 버전 강제 시 exit 1 확인
- [ ] `package.json`에 `check:deps` 스크립트 추가
- [ ] `tests/unit/deps-check.test.js` 4/4 통과
- [ ] `.artifacts/` `.gitignore`에 추가

---

## 22) 부록 A: TDD 실행 흐름

1. 실패 테스트 작성
- path traversal, invalid id, malformed filename

2. 최소 코드 수정으로 통과
- guard/util/handler 추가

3. 리팩터링
- route registrar 분리

4. 재검증
- 전체 테스트 + coverage + deps check

---

## 23) 부록 B: PR 분할 전략

- PR-1: `security guards + tests`
- PR-2: `http response/error helpers + route adoption`
- PR-3: `server route modularization`
- PR-4: `deps scripts + semgrep baseline docs`

각 PR 기준:
- 단일 목적
- 테스트 증거 포함
- 롤백 용이

---

## 24) 부록 C: 네트워크 제한 환경 운영 메모

현재 환경에서 관측한 사실:
- `npm audit` / `npm outdated`는 DNS(`registry.npmjs.org`) 실패 가능

운영 원칙:
- 로컬 개발에서는 offline gate를 hard-fail로 사용
- CI(네트워크 가능)에서 online gate를 hard-fail로 사용

예시 policy:

```bash
# local
node scripts/check-deps-offline.mjs && npm test

# ci
node scripts/check-deps-offline.mjs
npm audit --json
npm outdated --json
npm test
```


---

## 25) WS6 — CMD line/Telegram/Web/CLI 커맨드 통합 + Help 통일

요청 반영:
- `cmd line`, `telegram`, `web`, `cli`를 하나의 커맨드 계약으로 묶는 실행 단계 추가.
- `AGENTS.md`/`str_func/AGENTS.md` 체크리스트를 구현 플로우에 편입.
- 관련 스킬(`dev`, `dev-backend`, `dev-testing`, `telegram-send`, `web-routing`, `browser`) 지침을 직접 반영.

### 25.1 목표

1. 명령 정의와 노출 정책 단일소스화
2. Help 출력 정책 단일화 (`--help`, `/help`, Web dropdown, Telegram menu)
3. 인터페이스별 capability(읽기전용/숨김/차단) 명시
4. 자동완성 품질 통일 (command + argument)

### 25.2 현재 문제를 구현 항목으로 변환

| 문제 | 구현 항목 |
|---|---|
| root help 하드코딩/누락 | help generator를 registry 기반으로 전환 |
| Telegram 메뉴 vs `/help` 불일치 | interface policy에서 동시 계산 |
| Web arg completion 미지원 | API completion endpoint 추가 |
| ctx 권한 정책 분산 | capability map + context contract 정리 |

---

## 26) WS6 구현 설계

### 26.1 파일 구조 제안

```text
src/command-contract/
  catalog.js             # COMMANDS + capability metadata
  policy.js              # interface별 노출/실행 정책
  help-renderer.js       # text/json/telegram help 렌더러
  completion-service.js  # command + argument completion
src/http/
  command-controller.js  # /api/commands, /api/command, /api/commands/complete
bin/
  cli-claw.js            # printHelp 제거, renderer 사용
src/telegram.js          # setMyCommands policy 연동
public/js/features/
  slash-commands.js      # API completion 연동
```

### 26.2 capability 정책 모델

```js
export const INTERFACES = ['cmdline', 'cli', 'web', 'telegram'];

// full: 실행 가능, readonly: 조회만 가능, hidden: 목록 숨김, blocked: 실행 차단
export const CAP = {
  full: 'full',
  readonly: 'readonly',
  hidden: 'hidden',
  blocked: 'blocked',
};
```

```js
// 예시
{
  name: 'cli',
  desc: '활성 CLI 확인/변경',
  interfaces: ['cli', 'web', 'telegram'],
  capability: {
    cli: 'full',
    web: 'full',
    telegram: 'readonly',
  }
}
```

원칙:
- Telegram에서 설정 변경이 제한된 명령은 `readonly`로 명시.
- `/help`는 readonly 항목에 `[read-only]` 표시.
- Telegram `setMyCommands`는 `full`만 노출.

### 26.3 help renderer 단일화

```js
import { getVisibleCommands } from './policy.js';

export function renderHelp({ iface, commandName, format = 'text' }) {
  const cmds = getVisibleCommands(iface, { includeReadonly: true });
  if (!commandName) return renderCommandList(cmds, { iface, format });
  const cmd = cmds.find(c => c.name === commandName || (c.aliases || []).includes(commandName));
  if (!cmd) return { ok: false, text: `unknown command: ${commandName}` };
  return renderCommandDetail(cmd, { iface, format });
}
```

### 26.4 `/api/commands` 확장

현재 응답(요약):
- `name`, `desc`, `args`, `category`

목표 응답:

```json
{
  "ok": true,
  "data": [
    {
      "name": "help",
      "aliases": ["h"],
      "desc": "커맨드 목록",
      "args": "[command]",
      "category": "session",
      "capability": "full",
      "examples": ["/help", "/help status"]
    }
  ]
}
```

### 26.5 completion API 추가

`POST /api/commands/complete`

request:

```json
{
  "interface": "web",
  "input": "/mod",
  "argv": []
}
```

response:

```json
{
  "ok": true,
  "data": {
    "kind": "command",
    "items": [
      { "insertText": "/model ", "name": "model", "desc": "모델 확인/변경" }
    ]
  }
}
```

argument 모드:

```json
{
  "ok": true,
  "data": {
    "kind": "argument",
    "command": "model",
    "items": [
      { "insertText": "/model gpt-5", "name": "gpt-5", "desc": "codex" }
    ]
  }
}
```

---

## 27) 인터페이스별 실행 정책

### 27.1 CMD line (`cli-claw --help`)

- `bin/cli-claw.js`에서 수동 문자열 대신 `help-renderer`를 사용.
- switch/subcommand 목록과 출력 목록이 자동 동기화되게 변경.
- 누락 방지: `browser`, `memory` 같은 신규 서브커맨드 자동 반영.

### 27.2 CLI chat (`bin/commands/chat.js`)

- 기존 `parseCommand`/`executeCommand` 경로 유지.
- 추가: `tab` 자동완성은 `completion-service` 결과를 직접 사용.
- `/help`는 renderer 결과를 그대로 표시.

### 27.3 Web

- `slash-commands.js`에서 `/api/commands?interface=web` 초기 로드 유지.
- 입력 시 prefix local filter 대신 `/api/commands/complete` 사용 가능 모드 추가.
- `/help` 실행 결과에 capability 배지 렌더링 (`read-only`, `blocked`).

### 27.4 Telegram

- `setMyCommands` payload는 policy에서 계산해 menu/help와 일치시킴.
- `TG_EXCLUDED_CMDS` 하드코딩 제거 후 capability 정책으로 대체.
- `readonly` 명령은 설명 텍스트에 `(조회 전용)` 포함.

---

## 28) 테스트 설계 (WS6)

### 28.1 단위 테스트

- `tests/unit/commands-policy.test.js`
  - interface별 visible/full/readonly 분기 검증
- `tests/unit/help-renderer.test.js`
  - list/detail 출력 snapshot 검증
- `tests/unit/commands-completion.test.js`
  - command/argument completion 분기 검증

### 28.2 통합 테스트

- `tests/integration/help-parity.test.js`
  - `cli/web/telegram` help 목록 비교
  - menu(help 노출) 불일치 fail

- `tests/integration/cmdline-help.test.js`
  - `bin/cli-claw.js`의 help 출력에 switch command 전체 포함 확인

### 28.3 parity 검증 스크립트

`node scripts/check-command-parity.mjs`

검증 항목:
- command registry vs cmdline help
- command registry vs telegram setMyCommands
- command registry vs `/api/commands` 응답

---

## 29) AGENTS/문서 동기화 절차 (필수)

`str_func/AGENTS.md` 기준으로, WS6 완료 시 아래 동기화 필수:

코드 6곳:
1. `src/commands.js` (또는 `src/command-contract/{catalog,policy}`)
2. `server.js` (또는 controller)
3. `bin/commands/chat.js`
4. `src/telegram.js`
5. `bin/cli-claw.js`
6. `bin/commands/<subcommand>.js` (변경 시)

문서 4곳:
1. `README.md`
2. `devlog/str_func.md`
3. `devlog/str_func/commands.md`
4. `devlog/str_func/server_api.md`

검증 명령:

```bash
npm test
node scripts/check-command-parity.mjs
bash devlog/verify-counts.sh
```

---

## 30) WS6 완료 기준 (Definition of Done)

- [ ] `cmdline/cli/web/telegram`에서 help 정책이 단일소스로 생성됨
- [ ] Telegram 메뉴와 `/help`의 노출 집합이 정책적으로 일치함
- [ ] root `--help`가 실제 서브커맨드와 100% 일치함
- [ ] Web에서 argument completion 사용 가능
- [ ] parity 테스트/스크립트 통과
- [ ] AGENTS 체크리스트 문서 동기화 완료

---

## 31) WS6 리스크와 완화

| 리스크 | 영향 | 완화 |
|---|---|---|
| 정책 전환 중 일부 command 숨김 오작동 | 중 | dual-mode(구/신 정책) 임시 병행 |
| Telegram command 길이/설명 제한 초과 | 낮음 | `toTelegramCommandDescription` 길이 보정 유지 |
| Web completion API 호출 증가 | 낮음 | debounce + local cache |
| root help 리팩토링으로 초기 UX 변화 | 낮음 | 기존 포맷 유지 + 내용만 동기화 |

---

## 32) 스킬 반영 체크 (요청사항 “skill 무조건 봐” 대응)

실제 참조 후 반영한 스킬/문서:
- `skills_ref/dev/SKILL.md`
- `skills_ref/dev-backend/SKILL.md`
- `skills_ref/dev-data/SKILL.md`
- `skills_ref/dev-testing/SKILL.md`
- `skills_ref/telegram-send/SKILL.md`
- `skills_ref/web-routing/SKILL.md`
- `skills_ref/browser/SKILL.md`
- `cli-claw/AGENTS.md`
- `cli-claw/devlog/str_func/AGENTS.md`
- `cli-claw/devlog/str_func/commands.md`
- `cli-claw/devlog/str_func/agent_spawn.md`

적용 방식:
- 스킬 지침을 "규칙"이 아니라 구현 항목(WS6)으로 매핑.
- Help/command 통합과 인터페이스 capability를 Phase 9 실행 플랜에 직접 편입.
