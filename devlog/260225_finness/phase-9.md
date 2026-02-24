---
created: 2026-02-25
status: planning
tags: [cli-claw, finness, phase-9, backend, hardening, dependency, testing]
---
# Phase 9: 백엔드 하드닝 실행 설계서 (프런트 제외)

> 목표: Phase 8의 감사 결과를 실제 구현으로 전환한다.
> 범위: 백엔드 보안 입력 검증, API 계약 통일, 예외 처리 일관화, 테스트 확장, 의존성/정적분석 게이트
> 제외: 프런트 UI/스타일/컴포넌트 변경

---

## 0) Phase 9 한 줄 정의

`"지금 당장 깨질 수 있는 리스크를 먼저 닫고, 이후 변경이 안전해지는 개발 체계를 고정한다."`

---

## 1) 왜 지금 해야 하는가 (우선순위 근거)

1. 공격면이 이미 존재
- `memory-files`, `skills`, `upload`, `claw-memory` 입력 경계가 약함.

2. 구조가 커져서 작은 수정도 위험
- `server.js` 856줄/60 라우트로 결합도가 높음.

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
- `tests/unit/http-validate.test.js`
- `tests/unit/orchestrator.test.js`
- `tests/unit/agent-args.test.js`
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
- `tests/unit/http-validate.test.js`
- `tests/unit/orchestrator.test.js`
- `tests/unit/agent-args.test.js`
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

